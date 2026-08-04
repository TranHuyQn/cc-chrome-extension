// End-to-end test: launches Chromium with the bridge extension loaded, starts
// the MCP server, and exercises the tools over real MCP stdio — exactly the
// way Claude Code talks to the server.
//
// Usage: node test/e2e.mjs   (requires `npm install` in test/ and server/)

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import WebSocket from "ws";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = join(root, "extension");
const HTTP_PORT = 8931;
const WS_PORT = 9877; // avoid clashing with a dev server on the default port

let failures = 0;
function check(name, cond, detail = "") {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}

// --- tiny MCP stdio client -------------------------------------------------

class McpClient {
  constructor(command, args, env) {
    this.proc = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 1;
    this.proc.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString();
      let idx;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      }
    });
  }

  request(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    this.proc.stdin.write(payload + "\n");
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP request ${method} timed out`));
        }
      }, 60000);
    });
  }

  notify(method, params = {}) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async callTool(name, args = {}) {
    return await this.request("tools/call", { name, arguments: args });
  }

  kill() {
    this.proc.kill();
  }
}

const toolText = (result) => (result.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- test page -------------------------------------------------------------

const TEST_PAGE = `<!DOCTYPE html>
<html><head><title>CC Bridge Test</title></head>
<body>
<h1>Hello CC Bridge</h1>
<h2>Form section</h2>
<p>Some paragraph text to find with a needle: xyzzy-needle.</p>
<form onsubmit="return false">
  <input id="name" placeholder="Your name" />
  <select id="color"><option value="">pick</option><option value="red">Red</option><option value="blue">Blue</option></select>
  <button id="btn" type="button">Greet</button>
</form>
<div id="out"></div>
<div style="height:3000px"></div>
<div id="bottom-marker">the very bottom</div>
<script>
  console.log("page loaded log line");
  document.getElementById("btn").addEventListener("click", () => {
    document.getElementById("out").textContent =
      "Hi " + document.getElementById("name").value + " color=" + document.getElementById("color").value;
    setTimeout(() => {
      const late = document.createElement("div");
      late.id = "late";
      late.textContent = "late element appeared";
      document.body.appendChild(late);
    }, 800);
  });
  document.getElementById("name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("out").textContent = "enter-pressed";
  });
</script>
</body></html>`;

// --- main ------------------------------------------------------------------

const httpServer = createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(TEST_PAGE);
});
await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));
console.log(`Test page at http://127.0.0.1:${HTTP_PORT}/`);

const client = new McpClient("node", [join(root, "server", "index.js")], {
  CC_CHROME_PORT: String(WS_PORT),
});

const init = await client.request("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "e2e-test", version: "1.0.0" },
});
client.notify("notifications/initialized");
check("MCP initialize", init?.serverInfo?.name === "claude-chrome", JSON.stringify(init?.serverInfo));

const toolsList = await client.request("tools/list");
const toolNames = (toolsList.tools || []).map((t) => t.name);
console.log(`tools/list -> ${toolNames.length} tools: ${toolNames.join(", ")}`);
check("tools/list has core tools", ["navigate", "read_page", "click", "fill", "take_screenshot", "javascript_eval"].every((t) => toolNames.includes(t)));

// Launch Chromium with the extension. The extension's default WS URL is 9876,
// so we point it at the test port via storage after launch... simpler: the
// extension reads wsUrl from chrome.storage; we seed it by evaluating in the
// service worker context through Playwright.
const userDataDir = mkdtempSync(join(tmpdir(), "cc-bridge-e2e-"));
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: process.env.HEADED !== "1",
  // CI points CHROME_PATH at its own Chromium; without it Playwright uses the
  // browser it manages itself.
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ],
});

let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 });
console.log(`Extension service worker: ${sw.url()}`);

// Point the extension at the test WS port and reconnect.
await sw.evaluate(async (wsUrl) => {
  await chrome.storage.local.set({ wsUrl });
}, `ws://127.0.0.1:${WS_PORT}`);
await sw.evaluate(() => new Promise((resolve) => chrome.runtime.sendMessage({ type: "reconnect" }, resolve)));

// Wait for the extension to connect to the MCP server.
let connected = false;
for (let i = 0; i < 60; i++) {
  try {
    const status = JSON.parse(toolText(await client.callTool("chrome_status")));
    if (status.connected) { connected = true; break; }
  } catch {}
  await sleep(500);
}
check("extension connects to MCP server", connected);
if (!connected) {
  console.error("Extension never connected; aborting.");
  process.exit(1);
}

// navigate
let r = await client.callTool("navigate", { url: `http://127.0.0.1:${HTTP_PORT}/` });
check("navigate", toolText(r).includes(`127.0.0.1:${HTTP_PORT}`), toolText(r));

// get_page_text
r = await client.callTool("get_page_text", {});
check("get_page_text", toolText(r).includes("Hello CC Bridge"), toolText(r).slice(0, 200));

// read_page
r = await client.callTool("read_page", {});
const readPageText = toolText(r);
check("read_page headings", readPageText.includes("h1: Hello CC Bridge"));
check("read_page elements", /\[\d+\] <button[^>]*> "Greet"/.test(readPageText), readPageText.slice(0, 400));
const btnRef = Number((readPageText.match(/\[(\d+)\] <button[^>]*> "Greet"/) || [])[1]);

// fill input + select
r = await client.callTool("fill", { selector: "#name", value: "Claude" });
check("fill input", toolText(r).includes("Claude"), toolText(r));
r = await client.callTool("fill", { selector: "#color", value: "Blue" });
check("fill select by text", toolText(r).includes("Blue"), toolText(r));

// click by ref
r = await client.callTool("click", { ref: btnRef });
check("click by ref", toolText(r).includes("Greet"), toolText(r));
r = await client.callTool("get_page_text", {});
check("click had effect", toolText(r).includes("Hi Claude color=blue"), toolText(r).slice(0, 300));

// wait_for (element appears 800ms after click)
r = await client.callTool("wait_for", { selector: "#late", timeoutMs: 5000 });
check("wait_for late element", toolText(r).includes('"found": true'), toolText(r));

// find
r = await client.callTool("find", { query: "xyzzy-needle" });
check("find", toolText(r).includes("xyzzy-needle"), toolText(r));

// press_key: focus input then Enter
await client.callTool("click", { selector: "#name" });
r = await client.callTool("press_key", { key: "Enter" });
check("press_key call", toolText(r).includes("Enter"), toolText(r));
r = await client.callTool("get_page_text", {});
check("press_key had effect", toolText(r).includes("enter-pressed"), toolText(r).slice(0, 300));

// type_text
await client.callTool("fill", { selector: "#name", value: "" });
await client.callTool("click", { selector: "#name" });
r = await client.callTool("type_text", { text: "typed!" });
check("type_text call", toolText(r).includes("typed!"), toolText(r));
r = await client.callTool("javascript_eval", { code: "document.getElementById('name').value" });
check("type_text had effect", toolText(r).includes("typed!"), toolText(r));

// javascript_eval
r = await client.callTool("javascript_eval", { code: "6 * 7" });
check("javascript_eval", toolText(r).includes("42"), toolText(r));

// screenshot (viewport + full page)
r = await client.callTool("take_screenshot", {});
let img = (r.content || []).find((c) => c.type === "image");
check("take_screenshot viewport", img && img.mimeType === "image/png" && img.data.length > 1000, `len=${img?.data?.length}`);
r = await client.callTool("take_screenshot", { fullPage: true });
img = (r.content || []).find((c) => c.type === "image");
check("take_screenshot fullPage", img && img.data.length > 1000, `len=${img?.data?.length}`);

// --- orange "Claude is driving this tab" border ---------------------------
// Observed through Playwright, not through javascript_eval: every tool call
// repaints the frame, so a tool-based probe could never see it expire.
const drivenPage = () =>
  context.pages().find((p) => p.url().startsWith(`http://127.0.0.1:${HTTP_PORT}`)) || null;

async function borderState() {
  const p = drivenPage();
  if (!p) return "no-page";
  /* eslint-disable no-undef -- browser globals, evaluated inside the page by Playwright, not by this Node process */
  return await p.evaluate(() => {
    const host = document.getElementById("__cc_border");
    if (!host) return "absent";
    if (host.parentElement !== document.documentElement) return "wrong-parent";
    if (!host.shadowRoot) return "no-shadow";
    const frame = host.shadowRoot.firstElementChild;
    if (!frame) return "no-frame";
    const s = getComputedStyle(frame);
    return s.borderTopWidth === "3px" && s.position === "fixed" && s.pointerEvents === "none"
      ? "present"
      : `bad-style:${s.borderTopWidth}/${s.position}/${s.pointerEvents}`;
  });
  /* eslint-enable no-undef */
}

check("tìm được tab Claude đang lái để quan sát", drivenPage() !== null);

r = await client.callTool("read_page", {});
let border = await borderState();
check("khung cam xuất hiện khi Claude thao tác", border === "present", border);

// The frame lives outside <body> so it never shows up in read_page/get_page_text.
r = await client.callTool("get_page_text", {});
check("khung cam không lọt vào get_page_text", !toolText(r).includes("__cc_border"), toolText(r).slice(0, 200));

// Nothing must touch this tab during the wait, so the page-side timer fires.
await sleep(2600);
border = await borderState();
check("khung cam tự tắt sau ~2s không thao tác", border === "absent", border);

// A tab where injection is impossible must behave exactly as it did before:
// same error, no new failure mode from the painter.
const blankTab = JSON.parse(toolText(await client.callTool("new_tab", {})));
r = await client.callTool("read_page", { tabId: blankTab.tabId });
check(
  "about:blank giữ nguyên thông báo lỗi cũ",
  r.isError === true && toolText(r).includes("has no page open yet"),
  toolText(r).slice(0, 200)
);
await client.callTool("close_tab", { tabId: blankTab.tabId });

// Navigation destroys the DOM and the frame with it; an ongoing sequence must
// get it back.
await client.callTool("navigate", { url: `http://127.0.0.1:${HTTP_PORT}/` });
border = await borderState();
check("khung cam vẽ lại sau navigate", border === "present", border);

// take_screenshot removes the frame to capture a clean image, then repaints.
// Seeing it back afterwards is the observable proof the suppression ran: if
// the handler had not removed it, there would be nothing to repaint.
await client.callTool("take_screenshot", {});
border = await borderState();
check("khung cam vẽ lại sau screenshot (viewport)", border === "present", border);

await client.callTool("take_screenshot", { fullPage: true });
border = await borderState();
check("khung cam vẽ lại sau screenshot (fullPage)", border === "present", border);

// scroll
r = await client.callTool("scroll", { direction: "bottom" });
check("scroll bottom", toolText(r).includes("bottom"), toolText(r));

// console messages (attach then reload to capture load-time logs)
await client.callTool("read_console_messages", {});
await client.callTool("navigate", { action: "reload" });
r = await client.callTool("read_console_messages", {});
check("read_console_messages", toolText(r).includes("page loaded log line"), toolText(r).slice(0, 300));

// network requests (already attached via console flow? separate domain)
await client.callTool("read_network_requests", {});
await client.callTool("navigate", { action: "reload" });
r = await client.callTool("read_network_requests", {});
check("read_network_requests", toolText(r).includes(`127.0.0.1:${HTTP_PORT}`), toolText(r).slice(0, 300));

// tabs
r = await client.callTool("new_tab", { url: `http://127.0.0.1:${HTTP_PORT}/second` });
const newTabId = JSON.parse(toolText(r)).tabId;
check("new_tab", Number.isInteger(newTabId), toolText(r));
// Since 3.0.0 list_tabs is scoped to the session's group, so it must name the
// group, include the tab new_tab just put in it, and leave out a tab opened
// outside it (the browser's own first tab, which nothing ever grouped).
const ungroupedId = await sw.evaluate(async () => {
  const tabs = await chrome.tabs.query({ groupId: chrome.tabGroups.TAB_GROUP_ID_NONE });
  return tabs.length ? tabs[0].id : null;
});
check("có tab ngoài group để đối chứng", Number.isInteger(ungroupedId), String(ungroupedId));
r = await client.callTool("list_tabs", {});
const listed = JSON.parse(toolText(r));
check("list_tabs names the session group", /^Claude · [0-9a-f]{4}$/.test(listed.group || ""), toolText(r).slice(0, 300));
check("list_tabs", listed.tabs.some((t) => t.tabId === newTabId), toolText(r).slice(0, 300));
check("list_tabs bỏ qua tab ngoài group", !listed.tabs.some((t) => t.tabId === ungroupedId), toolText(r).slice(0, 300));

// The refusal has to name the group and both ways out, because the remedy is a
// drag in Chrome that Claude cannot perform for the user.
r = await client.callTool("get_page_text", { tabId: ungroupedId });
const refusal = toolText(r);
console.log(`refusal message: ${refusal}`);
check("tab ngoài group bị từ chối", r.isError === true, refusal.slice(0, 200));
check(
  "thông báo từ chối nêu nhóm và cả hai cách xử lý",
  /is outside the "Claude · [0-9a-f]{4}" tab group/.test(refusal)
    && /[Dd]rag that tab into the group/.test(refusal)
    && /new_tab/.test(refusal),
  refusal.slice(0, 200)
);
r = await client.callTool("switch_tab", { tabId: newTabId });
check("switch_tab", toolText(r).includes(String(newTabId)), toolText(r));
r = await client.callTool("close_tab", { tabId: newTabId });
check("close_tab", toolText(r).includes(String(newTabId)), toolText(r));

// A non-extension local process must not be able to drive the browser. The `ws`
// client sends no Origin header, which is exactly the case that used to slip
// through.
const rawCloseCode = await new Promise((resolve) => {
  const raw = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
  raw.on("close", (code) => resolve(code));
  raw.on("error", () => resolve(-1));
  setTimeout(() => resolve(0), 5000);
});
check("raw ws client without Origin is rejected with 4003", rawCloseCode === 4003, `code=${rawCloseCode}`);

// error paths
r = await client.callTool("click", { selector: "#does-not-exist" });
check("click error is clean", r.isError && toolText(r).includes("No element matches"), toolText(r));
r = await client.callTool("navigate", {});
check("navigate error is clean", r.isError && toolText(r).includes("url is required"), toolText(r));

// chrome_status detail
r = await client.callTool("chrome_status", {});
check("chrome_status", toolText(r).includes('"connected": true'), toolText(r));

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);

await context.close();
client.kill();
httpServer.close();
rmSync(userDataDir, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
