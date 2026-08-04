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
    // The whole look IS the glow now — there is no solid edge to measure, so
    // the assertion counts the stacked inset layers carrying the frame colour.
    // A style silently reverted to a hard border fails here instead of passing
    // on "some frame exists".
    const layers = (s.boxShadow.match(/inset/g) || []).length;
    const tinted = /232,\s*113,\s*10/.test(s.boxShadow);
    return layers >= 3 && tinted && s.borderTopWidth === "0px"
      && s.position === "fixed" && s.pointerEvents === "none"
      ? "present"
      : `bad-style:layers=${layers}/tinted=${tinted}/border=${s.borderTopWidth}/${s.position}/${s.pointerEvents}`;
  });
  /* eslint-enable no-undef */
}

// Bounding rect of the visible frame (inside the shadow root), so a caller
// can tell "the host exists" apart from "the frame actually covers the
// viewport" — a hostile containing-block collapses it to a 0-height box
// while borderState() alone would still happily report "present". Returns
// document.documentElement.clientWidth/clientHeight alongside the rect,
// measured in the same evaluate call: that is what a position:fixed element
// is actually sized against, and on a page with a scrollbar (this test page
// has one) it is ~15-20px narrower than window.innerWidth, which includes
// the scrollbar gutter and would make a healthy frame look "short".
async function frameRect() {
  const p = drivenPage();
  if (!p) return null;
  /* eslint-disable no-undef -- browser globals, evaluated inside the page by Playwright, not by this Node process */
  return await p.evaluate(() => {
    const host = document.getElementById("__cc_border");
    if (!host || !host.shadowRoot) return null;
    const frame = host.shadowRoot.firstElementChild;
    if (!frame) return null;
    const r = frame.getBoundingClientRect();
    return {
      width: r.width,
      height: r.height,
      top: r.top,
      left: r.left,
      clientWidth: document.documentElement.clientWidth,
      clientHeight: document.documentElement.clientHeight,
    };
  });
  /* eslint-enable no-undef */
}

// Detects the frame's orange edge inside a PNG by decoding it in the driven
// page itself — this test has no PNG library, but the browser does. Proves
// take_screenshot really strips the frame before capturing, rather than just
// putting it back afterward (which the repaint checks above cannot tell apart
// from a suppression that never ran).
async function pngHasOrange(base64) {
  const p = drivenPage();
  /* eslint-disable no-undef -- browser globals, evaluated inside the page by Playwright, not by this Node process */
  return await p.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) return "failed to decode image (0x0)";
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    // Matching #E8710A within a tolerance would find nothing: the frame has no
    // solid pixels any more, it is a translucent wash, so every pixel it
    // produces is the frame colour blended with whatever the page painted.
    // What survives blending is the hue direction — far more red than blue.
    // The test page is white with black text, so nothing else on it is warm:
    // white and black both give r-b = 0. Over white, the frame's strongest
    // band lands near (242,178,120), i.e. r-b = 122.
    const rows = [0, 1, 2, h - 1].filter((y) => y >= 0 && y < h);
    for (const y of rows) {
      const row = ctx.getImageData(0, y, w, 1).data;
      for (let x = 0; x < w; x++) {
        const i = x * 4;
        const r = row[i];
        const g = row[i + 1];
        const b = row[i + 2];
        if (r - b >= 30 && r - g >= 15 && r > 120) {
          return `orange at ${x},${y} (rgb ${r},${g},${b})`;
        }
      }
    }
    return "clean";
  }, base64);
  /* eslint-enable no-undef */
}

// Positive control for pngHasOrange: an 8x8 swatch filled with the frame
// colour, built and PNG-encoded entirely inside the driven page. If the
// detector ever silently stops detecting orange, this fails loudly and the
// "clean" checks on real screenshots stop being trustworthy.
async function orangeSwatchBase64() {
  const p = drivenPage();
  /* eslint-disable no-undef -- browser globals, evaluated inside the page by Playwright, not by this Node process */
  return await p.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 8;
    canvas.height = 8;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#E8710A";
    ctx.fillRect(0, 0, 8, 8);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  /* eslint-enable no-undef */
}

check("tìm được tab Claude đang lái để quan sát", drivenPage() !== null);

r = await client.callTool("read_page", {});
let border = await borderState();
check("khung cam xuất hiện khi Claude thao tác", border === "present", border);

// The host lives on document.documentElement precisely so it stays out of
// read_page/get_page_text/find, which all walk <body>. Assert that placement
// directly from the page, not by grepping tool output for the id string:
// read_page's element dump is built from tag/type/role/label/href and never
// emits an id no matter where the host lives, so a text-based check here
// could never fail — this one can, if the host is ever moved under <body>.
/* eslint-disable no-undef -- browser globals, evaluated inside the page by Playwright, not by this Node process */
const hostOutsideBody = await drivenPage().evaluate(() => {
  const host = document.getElementById("__cc_border");
  return !!host && !document.body.contains(host);
});
/* eslint-enable no-undef */
check("khung cam nằm ngoài <body>, không lọt vào read_page/get_page_text", hostOutsideBody, String(hostOutsideBody));

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

// Ghost frame: document.getElementById only ever returns the FIRST element
// with a given id in tree order. A page that plants a decoy #__cc_border
// earlier in the tree (inside <body>, ahead of the real host on
// documentElement) would make a getElementById-based rebuild remove the
// decoy and leave the real host orphaned next to a fresh second host — and
// a getElementById-based idle timer / hide would then only ever clear one
// of the two, leaving the other painted forever.
/* eslint-disable no-undef -- browser globals, evaluated inside the page by Playwright, not by this Node process */
await drivenPage().evaluate(() => {
  const decoy = document.createElement("div");
  decoy.id = "__cc_border";
  decoy.attachShadow({ mode: "open" });
  document.body.insertBefore(decoy, document.body.firstChild);
});
/* eslint-enable no-undef */
r = await client.callTool("read_page", {});
/* eslint-disable no-undef -- browser globals, evaluated inside the page by Playwright, not by this Node process */
const ghostCheck = await drivenPage().evaluate(() => {
  const hosts = document.querySelectorAll("#__cc_border");
  if (hosts.length !== 1) return { count: hosts.length };
  const real = hosts[0];
  const isReal = real.parentElement === document.documentElement
    && !!real.shadowRoot
    && !!real.shadowRoot.firstElementChild
    && real.shadowRoot.firstElementChild.getAttribute("data-cc-frame") === "1";
  return { count: hosts.length, isReal };
});
/* eslint-enable no-undef */
check(
  "khung cam chỉ còn đúng 1 host thật sau khi có decoy chen vào <body>",
  ghostCheck.count === 1 && ghostCheck.isReal === true,
  JSON.stringify(ghostCheck)
);
// Nothing must touch this tab during the wait, so the idle timer fires and
// must clear every #__cc_border it finds, not just the one a
// getElementById-based sweep would have seen.
await sleep(2600);
/* eslint-disable no-undef -- browser globals, evaluated inside the page by Playwright, not by this Node process */
const ghostCountAfterIdle = await drivenPage().evaluate(() => document.querySelectorAll("#__cc_border").length);
/* eslint-enable no-undef */
check("khung cam ma không sót lại sau khi hết thời gian idle", ghostCountAfterIdle === 0, String(ghostCountAfterIdle));

// Hostile page CSS, tested as two independent attacks so each check can fail
// for the reason its name actually claims. borderState() alone reads the
// frame's own computed style, which an ancestor's display:none never
// touches, so it cannot expose that attack on its own — each attack below
// gets its own real, independently-injected stylesheet and its own
// assertion of something that genuinely breaks without the host's forced
// styling.

// Attack A: [aria-hidden="true"] { display: none } is a real in-the-wild
// pattern. If the host's own display isn't force-set, the whole shadow
// subtree stops being rendered, and getClientRects() on the frame goes
// empty — unlike borderState(), that can actually catch this.
const hostileDisplayNone = await drivenPage().addStyleTag({
  content: `[aria-hidden="true"] { display: none !important }`,
});
r = await client.callTool("read_page", {});
/* eslint-disable no-undef -- browser globals, evaluated inside the page by Playwright, not by this Node process */
const renderedUnderDisplayNone = await drivenPage().evaluate(() => {
  const host = document.getElementById("__cc_border");
  const frame = host && host.shadowRoot && host.shadowRoot.firstElementChild;
  return !!frame && frame.getClientRects().length > 0;
});
/* eslint-enable no-undef */
check(
  "khung cam sống sót qua CSS thù địch (display:none trên [aria-hidden])",
  renderedUnderDisplayNone,
  String(renderedUnderDisplayNone)
);
await hostileDisplayNone.evaluate((el) => el.remove());

// Attack B: a blanket `div { transform }` rule turns an unstyled host into a
// containing block for its position:fixed shadow content, collapsing the
// frame onto the host's own 0-height box.
const hostileTransform = await drivenPage().addStyleTag({
  content: `div { transform: translateZ(0) }`,
});
r = await client.callTool("read_page", {});
const rect = await frameRect();
const rectOk = !!rect
  && Math.abs(rect.width - rect.clientWidth) <= 5
  && Math.abs(rect.height - rect.clientHeight) <= 5;
check(
  "khung cam không bị co lại thành 0px bởi containing block thù địch (transform)",
  rectOk,
  JSON.stringify(rect)
);
await hostileTransform.evaluate((el) => el.remove());

// Page tampering: the shadow root has to stay `mode: "open"` (this very test
// suite reads host.shadowRoot from the main world), so a page script can
// reach in and delete the frame in one line. Full tamper-proofing is
// impossible in a DOM the page also controls — the achievable guarantee is
// that the next tool call heals it rather than silently reusing the gutted
// host forever.
//
// Re-arm the frame with a tool call right before tampering, rather than
// relying on whatever paint is left over from the checks above: this
// sequence must not lean on the 2000ms idle window still having time left
// on it, or a slow/loaded machine makes borderState() read "absent" here
// instead of the tampered "no-frame" this check needs as its starting point.
r = await client.callTool("read_page", {});
/* eslint-disable no-undef -- browser globals, evaluated inside the page by Playwright, not by this Node process */
await drivenPage().evaluate(() => {
  const host = document.getElementById("__cc_border");
  if (host && host.shadowRoot && host.shadowRoot.firstElementChild) {
    host.shadowRoot.firstElementChild.remove();
  }
});
/* eslint-enable no-undef */
const tampered = await borderState();
check("khung cam bên trong bị page JS xoá (chuẩn bị kiểm chứng tự phục hồi)", tampered === "no-frame", tampered);
r = await client.callTool("read_page", {});
border = await borderState();
check("khung cam tự phục hồi ở lần thao tác kế tiếp sau khi bị page JS phá", border === "present", border);

// Prove pngHasOrange itself can detect orange before trusting it to clear
// the real screenshots below.
const swatchBase64 = await orangeSwatchBase64();
const swatchResult = await pngHasOrange(swatchBase64);
check("bộ dò màu cam nhận diện được mẫu cam (kiểm tra dương)", swatchResult.startsWith("orange"), swatchResult);

// take_screenshot removes the frame to capture a clean image, then repaints.
// Seeing it back afterwards is the observable proof the suppression ran: if
// the handler had not removed it, there would be nothing to repaint. But the
// repaint alone can't tell a real suppression from a no-op clearBorder (both
// end with the border back), so also decode the captured pixels and check
// the frame colour is actually absent from the image itself.
r = await client.callTool("take_screenshot", {});
border = await borderState();
check("khung cam vẽ lại sau screenshot (viewport)", border === "present", border);
img = (r.content || []).find((c) => c.type === "image");
let pixelResult = img ? await pngHasOrange(img.data) : "no-image";
check("ảnh chụp màn hình (viewport) không dính khung cam", pixelResult === "clean", pixelResult);

r = await client.callTool("take_screenshot", { fullPage: true });
border = await borderState();
check("khung cam vẽ lại sau screenshot (fullPage)", border === "present", border);
img = (r.content || []).find((c) => c.type === "image");
pixelResult = img ? await pngHasOrange(img.data) : "no-image";
check("ảnh chụp màn hình (fullPage) không dính khung cam", pixelResult === "clean", pixelResult);

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
