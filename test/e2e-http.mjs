// End-to-end test for http (VPS/multi-user) mode: starts the server with
// --http and two team tokens, launches real Chromium with the extension
// pointed at ws://127.0.0.1:<port>/ws?token=..., then talks to the server
// with the official MCP Streamable HTTP client — exactly like Claude Code
// configured with `claude mcp add --transport http`.
//
// Usage: node test/e2e-http.mjs   (requires `npm install` in test/ and server/)

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import WebSocket, { WebSocketServer } from "ws";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = join(root, "extension");
const HTTP_PORT = 8932;   // test page
const MCP_PORT = 8788;    // bridge server (http mode)
const TOKEN_A = "team-token-alice-0123456789";
const TOKEN_B = "team-token-bob-0123456789";

let failures = 0;
function check(name, cond, detail = "") {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}

const toolText = (result) => (result.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Opens a raw websocket and resolves with the close code, so tests can assert
// exactly why the server refused.
//
// A rejected upgrade (see server/index.js's `reject` helper) completes the
// WebSocket handshake before closing with a specific code — that's the only
// way a browser can read a real close code instead of an indistinguishable
// 1006. That means the client's `open` event fires even for a connection the
// server is about to reject, strictly before `close` — the `ws` library
// guarantees that ordering (see setSocket() in lib/websocket.js). So `open`
// alone can't tell a real accept from an accept-then-immediately-reject; give
// a same-tick/next-tick `close` a brief window to preempt it.
function rawWsCloseCode(url, { origin, protocols } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (code) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    const ws = new WebSocket(url, protocols, origin ? { headers: { origin } } : undefined);
    ws.on("open", () => { setTimeout(() => { ws.close(); done(0); }, 250); });
    ws.on("close", (code) => done(code));
    ws.on("error", () => done(-1));
    setTimeout(() => done(-2), 5000);
  });
}

const EXT_ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// --- test page -------------------------------------------------------------

const TEST_PAGE = `<!DOCTYPE html>
<html><head><title>HTTP Mode Test</title></head>
<body><h1>Hello VPS Bridge</h1>
<input id="name" placeholder="Your name" />
<button id="btn" onclick="document.getElementById('out').textContent='Hi '+document.getElementById('name').value">Greet</button>
<div id="out"></div>
</body></html>`;

const pageServer = createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(TEST_PAGE);
});
await new Promise((r) => pageServer.listen(HTTP_PORT, "127.0.0.1", r));

// --- start bridge server in http mode --------------------------------------

const PAIR_SECRET = "team-pair-secret-0123456789";
const stateFile = join(mkdtempSync(join(tmpdir(), "cc-bridge-state-")), "tokens.json");

const serverProc = spawn("node", [join(root, "server", "index.js"), "--http"], {
  env: {
    ...process.env,
    CC_CHROME_PORT: String(MCP_PORT),
    CC_CHROME_HOST: "127.0.0.1",
    CC_CHROME_TOKENS: `${TOKEN_A}=alice,${TOKEN_B}=bob`,
    CC_CHROME_PAIR_SECRET: PAIR_SECRET,
    CC_CHROME_STATE_FILE: stateFile,
    CC_CHROME_DIST_DIR: join(root, "dist"),
    CC_CHROME_MAX_TOKENS: "2",
    // Tool calls now wait out a service-worker restart before failing (see
    // test/reconnect-grace.test.mjs). The checks below that expect a clean
    // "not connected" failure would otherwise each sit through the 25s default.
    CC_CHROME_RECONNECT_GRACE_MS: "500",
  },
  stdio: ["ignore", "inherit", "inherit"],
});

// Wait for /health
let healthy = false;
for (let i = 0; i < 40; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${MCP_PORT}/health`);
    if (res.ok) { healthy = true; break; }
  } catch {}
  await sleep(250);
}
check("server /health", healthy);
if (!healthy) process.exit(1);

// /health reports live state (who's connected right now); a cached copy would
// misreport it, and it's the endpoint used to verify a deploy landed.
const healthRes = await fetch(`http://127.0.0.1:${MCP_PORT}/health`);
check("health cache-control forbids storing", healthRes.headers.get("cache-control") === "no-store", healthRes.headers.get("cache-control"));

// --- auth checks -----------------------------------------------------------

let res = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
});
check("reject missing token", res.status === 401, `status=${res.status}`);

res = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: "Bearer wrong-token-000000",
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
});
check("reject bad token", res.status === 401, `status=${res.status}`);

// --- MCP client (like Claude Code with --transport http) --------------------

async function mcpConnect(token) {
  const client = new Client({ name: "e2e-http-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${MCP_PORT}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

const clientA = await mcpConnect(TOKEN_A);
const toolsList = await clientA.listTools();
const toolNames = toolsList.tools.map((t) => t.name);
check("tools/list over http", toolNames.includes("navigate") && toolNames.includes("take_screenshot"), toolNames.join(","));

// Before the extension connects, tools should fail cleanly.
let r = await clientA.callTool({ name: "chrome_status", arguments: {} });
check("status disconnected before extension", toolText(r).includes('"connected": false'), toolText(r));

// --- launch Chromium with the extension (alice's browser) -------------------

const userDataDir = mkdtempSync(join(tmpdir(), "cc-bridge-http-e2e-"));
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
await sw.evaluate(async (wsUrl) => {
  await chrome.storage.local.set({ wsUrl });
}, `ws://127.0.0.1:${MCP_PORT}/ws?token=${TOKEN_A}`);
await sw.evaluate(() => new Promise((resolve) => chrome.runtime.sendMessage({ type: "reconnect" }, resolve)));

let connected = false;
for (let i = 0; i < 60; i++) {
  try {
    const status = JSON.parse(toolText(await clientA.callTool({ name: "chrome_status", arguments: {} })));
    if (status.connected) { connected = true; break; }
  } catch {}
  await sleep(500);
}
check("extension connects with alice token", connected);
if (!connected) process.exit(1);

// --- drive the browser over http MCP ----------------------------------------

r = await clientA.callTool({ name: "navigate", arguments: { url: `http://127.0.0.1:${HTTP_PORT}/` } });
check("navigate (http mode)", toolText(r).includes(`127.0.0.1:${HTTP_PORT}`), toolText(r));
const mainTabId = JSON.parse(toolText(r)).tabId;

r = await clientA.callTool({ name: "get_page_text", arguments: {} });
check("get_page_text (http mode)", toolText(r).includes("Hello VPS Bridge"), toolText(r).slice(0, 200));

await clientA.callTool({ name: "fill", arguments: { selector: "#name", value: "TeamMate" } });
r = await clientA.callTool({ name: "click", arguments: { selector: "#btn" } });
check("click (http mode)", toolText(r).includes("Greet"), toolText(r));
r = await clientA.callTool({ name: "get_page_text", arguments: {} });
check("fill+click effect (http mode)", toolText(r).includes("Hi TeamMate"), toolText(r).slice(0, 200));

r = await clientA.callTool({ name: "take_screenshot", arguments: {} });
const img = (r.content || []).find((c) => c.type === "image");
check("screenshot (http mode)", img && img.mimeType === "image/png" && img.data.length > 1000, `len=${img?.data?.length}`);

// --- token isolation: bob has no extension connected ------------------------

const clientB = await mcpConnect(TOKEN_B);
r = await clientB.callTool({ name: "chrome_status", arguments: {} });
check("bob is isolated from alice's browser", toolText(r).includes('"connected": false'), toolText(r).slice(0, 200));
r = await clientB.callTool({ name: "navigate", arguments: { url: "https://example.com" } });
check("bob navigate fails cleanly", r.isError && toolText(r).includes("not connected"), toolText(r).slice(0, 200));

// A second Claude Code session with alice's token reaches the same browser —
// bob's does not. It no longer shares alice's *tabs*, though: since 3.0.0 every
// MCP session works inside its own tab group, so "same browser" is proven by
// reaching her extension, and the isolation is asserted right after.
const clientA2 = await mcpConnect(TOKEN_A);
r = await clientA2.callTool({ name: "chrome_status", arguments: {} });
check("second session, same token, same browser", toolText(r).includes('"connected": true'), toolText(r).slice(0, 200));
r = await clientA2.callTool({ name: "get_page_text", arguments: { tabId: mainTabId } });
check(
  "phiên thứ hai không với được tab của phiên đầu",
  r.isError && /is outside the "Claude · [0-9a-f]{4}" tab group/.test(toolText(r)),
  toolText(r).slice(0, 200)
);

// --- per-session tab groups --------------------------------------------------
//
// Placed here, not at the end of the file: the tests below drive the browser
// through clientA/clientA2, and every section after this one repoints the
// extension's websocket at a different token or a throwaway server, so alice's
// session stops being reachable through the MCP server past this point.

const tabA = JSON.parse(toolText(await clientA.callTool({ name: "new_tab", arguments: { url: `http://127.0.0.1:${HTTP_PORT}/` } })));
const tabA2 = JSON.parse(toolText(await clientA.callTool({ name: "new_tab", arguments: { url: `http://127.0.0.1:${HTTP_PORT}/` } })));
const groupsSame = await sw.evaluate(async ([a, b]) => {
  const ta = await chrome.tabs.get(a), tb = await chrome.tabs.get(b);
  const g = ta.groupId >= 0 ? await chrome.tabGroups.get(ta.groupId) : null;
  return { a: ta.groupId, b: tb.groupId, title: g ? g.title : null, color: g ? g.color : null };
}, [tabA.tabId, tabA2.tabId]);
check("hai tab cùng phiên vào chung một group", groupsSame.a >= 0 && groupsSame.a === groupsSame.b, JSON.stringify(groupsSame));
check("nhãn group đúng định dạng", /^Claude · [0-9a-f]{4}$/.test(groupsSame.title || ""), String(groupsSame.title));
check("group màu cam", groupsSame.color === "orange", String(groupsSame.color));

// clientA2 dùng cùng token nhưng khác MCP session — phải ra group khác
const tabB = JSON.parse(toolText(await clientA2.callTool({ name: "new_tab", arguments: { url: `http://127.0.0.1:${HTTP_PORT}/` } })));
const otherGroup = await sw.evaluate(async (id) => (await chrome.tabs.get(id)).groupId, tabB.tabId);
check("phiên khác thì group khác", otherGroup >= 0 && otherGroup !== groupsSame.a, `${otherGroup} vs ${groupsSame.a}`);

// Yêu cầu 3: tab ngoài group phải bị từ chối, và kéo vào group thì thao tác được.
const outsideId = await sw.evaluate(async (url) => (await chrome.tabs.create({ url, active: false })).id, `http://127.0.0.1:${HTTP_PORT}/`);
await sleep(500);
const blocked = await clientA.callTool({ name: "get_page_text", arguments: { tabId: outsideId } });
check("tab ngoài group bị từ chối", blocked.isError === true, toolText(blocked).slice(0, 160));
check("thông báo lỗi nêu tên nhóm", /Claude · [0-9a-f]{4}/.test(toolText(blocked)), toolText(blocked).slice(0, 160));

// close_tab is the most damaging thing this extension can do to a tab it does
// not own, so it gets its own check — and the tab must still be there after.
const blockedClose = await clientA.callTool({ name: "close_tab", arguments: { tabId: outsideId } });
check("close_tab tab ngoài nhóm bị từ chối", blockedClose.isError === true && /tab group/.test(toolText(blockedClose)), toolText(blockedClose).slice(0, 160));
const stillOpen = await sw.evaluate(async (id) => !!(await chrome.tabs.get(id).catch(() => null)), outsideId);
check("tab ngoài nhóm không bị đóng", stillOpen === true, String(stillOpen));

// Người dùng kéo tab vào nhóm — mô phỏng bằng chính API Chrome dùng khi kéo.
await sw.evaluate(async ([tabId, groupId]) => { await chrome.tabs.group({ tabIds: [tabId], groupId }); }, [outsideId, groupsSame.a]);
const allowed = await clientA.callTool({ name: "get_page_text", arguments: { tabId: outsideId } });
check("kéo tab vào nhóm thì thao tác được", !allowed.isError, toolText(allowed).slice(0, 160));

// switch_tab goes through resolveTab too since 3.0.0, so an in-group tab must
// still be allowed through it.
r = await clientA.callTool({ name: "switch_tab", arguments: { tabId: mainTabId } });
check("switch_tab tab trong nhóm vẫn được", !r.isError && toolText(r).includes(String(mainTabId)), toolText(r).slice(0, 160));

// new_tab must not steal the user's focus. switch_tab just made mainTabId the
// active tab in its window, so it stands in for "the tab the user is looking
// at"; opening another tab in the same group must leave it active and land
// the new tab in the background.
const activeBefore = await sw.evaluate(async (id) => (await chrome.tabs.get(id)).active, mainTabId);
check("tab người dùng đang xem đang active trước khi mở tab mới", activeBefore === true, String(activeBefore));
const tabQuiet = JSON.parse(toolText(await clientA.callTool({ name: "new_tab", arguments: { url: `http://127.0.0.1:${HTTP_PORT}/` } })));
const focusAfter = await sw.evaluate(async ([newId, userId]) => {
  const newTab = await chrome.tabs.get(newId);
  const userTab = await chrome.tabs.get(userId);
  return { newActive: newTab.active, userActive: userTab.active };
}, [tabQuiet.tabId, mainTabId]);
check("new_tab không cướp focus: tab mới không active", focusAfter.newActive === false, JSON.stringify(focusAfter));
check("new_tab không cướp focus: tab người dùng vẫn active", focusAfter.userActive === true, JSON.stringify(focusAfter));
await sw.evaluate(async (id) => { await chrome.tabs.remove(id); }, tabQuiet.tabId);

// Nhiều cửa sổ: new_tab mở ở cửa sổ đang focus, nên lời gọi không kèm tabId
// phải bám theo cửa sổ đó chứ không quay về nhóm cũ ở cửa sổ đầu tiên (nếu
// không, Claude đọc nhầm trang mà không có lỗi nào báo).
const win2 = await sw.evaluate(async (url) => {
  const w = await chrome.windows.create({ url, focused: true });
  return { windowId: w.id, tabId: w.tabs[0].id };
}, `http://127.0.0.1:${HTTP_PORT}/`);
await sleep(500);
const tabW2 = JSON.parse(toolText(await clientA.callTool({ name: "new_tab", arguments: { url: `http://127.0.0.1:${HTTP_PORT}/` } })));
const win2Info = await sw.evaluate(async (id) => {
  const t = await chrome.tabs.get(id);
  return { windowId: t.windowId, groupId: t.groupId };
}, tabW2.tabId);
check("new_tab mở ở cửa sổ đang focus", win2Info.windowId === win2.windowId, JSON.stringify({ win2Info, expected: win2.windowId }));
const resolved = JSON.parse(toolText(await clientA.callTool({ name: "navigate", arguments: { action: "reload" } })));
check(
  "không có tabId thì bám cửa sổ đang focus",
  resolved.tabId === tabW2.tabId,
  JSON.stringify({ resolved: resolved.tabId, expected: tabW2.tabId, firstWindowTab: tabA.tabId })
);
// Trả trạng thái về như cũ cho các phần kiểm thử phía sau.
await sw.evaluate(async (id) => { await chrome.windows.remove(id); }, win2.windowId);
await sleep(500);

// Claude Code gọi tool song song. Với một phiên chưa có nhóm, hai new_tab cùng
// lúc mà không tuần tự hoá sẽ cùng thấy "chưa có nhóm" và tạo hai nhóm trùng
// tên — tabGroups.query chỉ trả về một nhóm, tab của nhóm thua vĩnh viễn không
// với tới được và cũng không hiện trong list_tabs.
const clientA3 = await mcpConnect(TOKEN_A);
const [race1, race2] = await Promise.all([
  clientA3.callTool({ name: "new_tab", arguments: { url: `http://127.0.0.1:${HTTP_PORT}/` } }),
  clientA3.callTool({ name: "new_tab", arguments: { url: `http://127.0.0.1:${HTTP_PORT}/` } }),
]);
const raceTabs = [JSON.parse(toolText(race1)).tabId, JSON.parse(toolText(race2)).tabId];
const raceGroups = await sw.evaluate(async ([a, b]) => {
  const ta = await chrome.tabs.get(a), tb = await chrome.tabs.get(b);
  const g = ta.groupId >= 0 ? await chrome.tabGroups.get(ta.groupId) : null;
  const sameTitle = g ? await chrome.tabGroups.query({ title: g.title }) : [];
  return { a: ta.groupId, b: tb.groupId, title: g ? g.title : null, count: sameTitle.length };
}, raceTabs);
check(
  "hai new_tab song song chỉ tạo một nhóm",
  raceGroups.a >= 0 && raceGroups.a === raceGroups.b && raceGroups.count === 1,
  JSON.stringify(raceGroups)
);
const raceListed = JSON.parse(toolText(await clientA3.callTool({ name: "list_tabs", arguments: {} })));
check(
  "cả hai tab đều thấy được sau khi chạy song song",
  raceTabs.every((id) => raceListed.tabs.some((t) => t.tabId === id)),
  JSON.stringify({ raceTabs, listed: raceListed.tabs.map((t) => t.tabId) })
);

// --- self-service pairing (the /ccchrome connect flow) ----------------------

res = await fetch(`http://127.0.0.1:${MCP_PORT}/pair`, {
  method: "POST",
  headers: { authorization: "Bearer wrong-secret-000000", "content-type": "application/json" },
  body: JSON.stringify({ name: "mallory" }),
});
check("pair rejects bad secret", res.status === 401, `status=${res.status}`);

res = await fetch(`http://127.0.0.1:${MCP_PORT}/pair`, {
  method: "POST",
  headers: { authorization: `Bearer ${PAIR_SECRET}`, "content-type": "application/json" },
  body: JSON.stringify({ name: "carol" }),
});
const paired = await res.json();
check("pair issues token", res.status === 200 && paired.token?.length === 32 && paired.name === "carol", JSON.stringify(paired));
check("pair returns urls", paired.mcpUrl?.endsWith("/mcp") && paired.wsUrl?.includes(`token=${paired.token}`), JSON.stringify(paired));

res = await fetch(`http://127.0.0.1:${MCP_PORT}/pair/status`, {
  headers: { authorization: `Bearer ${paired.token}` },
});
let pairStatus = await res.json();
check("pair/status before extension", res.status === 200 && pairStatus.extensionConnected === false, JSON.stringify(pairStatus));

// Paired token works for MCP immediately.
const clientC = await mcpConnect(paired.token);
r = await clientC.callTool({ name: "chrome_status", arguments: {} });
check("paired token isolated (no browser yet)", toolText(r).includes('"connected": false'), toolText(r).slice(0, 200));

// Re-point the extension at the paired token (simulates carol's browser).
await sw.evaluate(async (wsUrl) => {
  await chrome.storage.local.set({ wsUrl });
}, `ws://127.0.0.1:${MCP_PORT}/ws?token=${paired.token}`);
await sw.evaluate(() => new Promise((resolve) => chrome.runtime.sendMessage({ type: "reconnect" }, resolve)));

let pairedConnected = false;
for (let i = 0; i < 40; i++) {
  const s = await (await fetch(`http://127.0.0.1:${MCP_PORT}/pair/status`, {
    headers: { authorization: `Bearer ${paired.token}` },
  })).json();
  if (s.extensionConnected) { pairedConnected = true; break; }
  await sleep(500);
}
check("extension connects with paired token", pairedConnected);

// carol's session has its own tab group, so it proves browser control by
// opening a tab of its own and reading it back, not by inheriting alice's.
r = await clientC.callTool({ name: "new_tab", arguments: { url: `http://127.0.0.1:${HTTP_PORT}/` } });
check("paired token mở được tab", !r.isError && toolText(r).includes(`127.0.0.1:${HTTP_PORT}`), toolText(r).slice(0, 200));
r = await clientC.callTool({ name: "get_page_text", arguments: {} });
check("browser control via paired token", toolText(r).includes("Hello VPS Bridge"), toolText(r).slice(0, 200));

// Revoke: token stops working everywhere.
res = await fetch(`http://127.0.0.1:${MCP_PORT}/pair`, {
  method: "DELETE",
  headers: { authorization: `Bearer ${paired.token}` },
});
check("pair revoke", res.status === 200, `status=${res.status}`);
res = await fetch(`http://127.0.0.1:${MCP_PORT}/pair/status`, {
  headers: { authorization: `Bearer ${paired.token}` },
});
check("revoked token rejected", res.status === 401, `status=${res.status}`);
let revokedErr = null;
try {
  await mcpConnect(paired.token);
} catch (err) {
  revokedErr = err;
}
check("revoked token cannot start MCP session", revokedErr !== null, String(revokedErr));

// Static tokens cannot be revoked via the API.
res = await fetch(`http://127.0.0.1:${MCP_PORT}/pair`, {
  method: "DELETE",
  headers: { authorization: `Bearer ${TOKEN_A}` },
});
check("static token revoke refused", res.status === 400, `status=${res.status}`);

// --- websocket auth moved out of the URL ------------------------------------

const base = `ws://127.0.0.1:${MCP_PORT}/ws`;

check(
  "token in the query string is refused",
  (await rawWsCloseCode(`${base}?token=${TOKEN_B}`, { origin: EXT_ORIGIN })) === 4002,
  "expected close 4002"
);
check(
  "valid token in the subprotocol is accepted",
  (await rawWsCloseCode(base, { origin: EXT_ORIGIN, protocols: [`ccchrome.token.${TOKEN_B}`] })) === 0,
  "expected the connection to open"
);
check(
  "bad token in the subprotocol is refused",
  (await rawWsCloseCode(base, { origin: EXT_ORIGIN, protocols: ["ccchrome.token.nope-000000"] })) === 4001,
  "expected close 4001"
);
check(
  "missing Origin is refused even with a valid token",
  (await rawWsCloseCode(base, { protocols: [`ccchrome.token.${TOKEN_B}`] })) === 4003,
  "expected close 4003"
);

// --- popup shows why the bridge refused to connect --------------------------

// The popup is the only place a member can see why the bridge will not
// connect, so a rejected handshake must reach it as a readable reason rather
// than the generic "is the MCP server running?".
const extensionId = new URL(sw.url()).host;
await sw.evaluate(async (wsUrl) => {
  await chrome.storage.local.set({ wsUrl });
}, `ws://127.0.0.1:${MCP_PORT}/ws?token=definitely-not-a-real-token`);

const popup = await context.newPage();
await popup.goto(`chrome-extension://${extensionId}/popup.html`);
let popupError = "";
for (let i = 0; i < 40; i++) {
  popupError = await popup.textContent("#error");
  if (popupError && popupError.trim()) break;
  await sleep(250);
}
check("popup explains a rejected token", /[Tt]oken/.test(popupError), `popup #error = ${JSON.stringify(popupError)}`);
await popup.close();

// --- a refused handshake must not reset the reconnect backoff ----------------

// Since 2.0.0 the server refuses by completing the 101 handshake and then
// closing with a code, so the extension's `open` event fires for refusals too.
// While `open` reset reconnectDelay to RECONNECT_MIN_MS, every member with a
// wrong or revoked token retried once a second forever — a permanent 1 Hz
// storm in the server log and in Caddy's access log, with the badge flashing
// green then red once a second.
//
// A standalone server stands in for the real one so the attempts can be
// counted directly; it mirrors server/index.js's reject path exactly (echo the
// offered subprotocol, complete the handshake, close 4001).
const REJECT_PORT = 8933;
const rejectAttempts = [];
const rejectServer = new WebSocketServer({
  host: "127.0.0.1",
  port: REJECT_PORT,
  handleProtocols: (protocols) => [...protocols][0] ?? false,
});
rejectServer.on("connection", (socket) => {
  rejectAttempts.push(Date.now());
  socket.close(4001, "invalid token");
});
await new Promise((r) => rejectServer.once("listening", r));

// Changing the URL runs forceReconnect(), which resets the backoff to 1s — so
// the window below starts from the most favourable possible state for a storm.
await sw.evaluate(async (wsUrl) => {
  await chrome.storage.local.set({ wsUrl });
}, `ws://127.0.0.1:${REJECT_PORT}/ws?token=definitely-not-a-real-token`);

for (let i = 0; i < 40 && rejectAttempts.length === 0; i++) await sleep(250);
check("extension reaches the refusing server", rejectAttempts.length > 0);

// Count, not exact timings: a 1 Hz storm puts ~12 attempts in this window,
// while a backoff that jumps to RECONNECT_MAX_MS (30s) on a refusal allows at
// most the 30s keepalive alarm to sneak one extra in. The threshold sits far
// from both, so the check does not depend on scheduler jitter.
const BACKOFF_WINDOW_MS = 12000;
const firstAttempt = rejectAttempts[0] ?? Date.now();
await sleep(BACKOFF_WINDOW_MS);
const retries = rejectAttempts.filter((t) => t > firstAttempt);
const gaps = rejectAttempts.map((t) => t - firstAttempt);
check(
  "a refused handshake does not reset the backoff (no 1 Hz reconnect storm)",
  retries.length <= 3,
  `${retries.length} retries in ${BACKOFF_WINDOW_MS}ms; offsets=${gaps.join(",")}`
);
rejectServer.close();

// --- the keepalive alarm actually puts a ping on the wire --------------------
//
// Chrome throttles setInterval in a backgrounded service worker down to about
// one check a minute, so the 20s keepalive interval stops landing inside the
// 30s window a worker needs to stay considered active; Chrome then kills the
// worker and the socket closes with 1001. The cc-keepalive alarm is the
// throttling-proof floor, so its handler must send the ping itself.
//
// WHAT THIS PROVES: firing cc-keepalive on an open socket puts a `ping` frame
// on the wire. WHAT IT DOES NOT PROVE: that this actually saves the worker
// under real intensive throttling — a test cannot make Chrome throttle on
// demand. That part is verified by inspection and by the live deployment.
const KEEPALIVE_PORT = 8934;
const pings = [];
const keepaliveServer = new WebSocketServer({ host: "127.0.0.1", port: KEEPALIVE_PORT });
keepaliveServer.on("connection", (socket) => {
  socket.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type !== "ping") return;
    pings.push(Date.now());
    socket.send(JSON.stringify({ type: "pong" }));
  });
});
await new Promise((r) => keepaliveServer.once("listening", r));

// A loopback URL with no token is the stdio-mode shape, which the extension
// accepts without a subprotocol.
await sw.evaluate(async (wsUrl) => {
  await chrome.storage.local.set({ wsUrl });
}, `ws://127.0.0.1:${KEEPALIVE_PORT}/ws`);

for (let i = 0; i < 40 && pings.length === 0; i++) await sleep(250);
check("extension connects to the keepalive probe server", pings.length > 0);

// The 0.5-minute periodic alarm would muddy the measurement, and so would a
// 20s interval tick — so clear the alarm, sync on the interval by taking the
// baseline right after a ping, then fire cc-keepalive as a one-shot well
// inside the remaining ~20s of quiet.
check(
  "cc-keepalive alarm is registered at Chrome's 0.5-minute minimum",
  (await sw.evaluate(async () => (await chrome.alarms.get("cc-keepalive"))?.periodInMinutes)) === 0.5
);
await sw.evaluate(async () => { await chrome.alarms.clear("cc-keepalive"); });
const baseline = pings.length;
await sw.evaluate(async () => { await chrome.alarms.create("cc-keepalive", { when: Date.now() + 500 }); });
for (let i = 0; i < 16 && pings.length === baseline; i++) await sleep(250);
check(
  "firing cc-keepalive on an open socket sends a ping (survives a throttled setInterval)",
  pings.length > baseline,
  `baseline=${baseline} now=${pings.length}`
);
await sw.evaluate(async () => { await chrome.alarms.create("cc-keepalive", { periodInMinutes: 0.5 }); });
keepaliveServer.close();

// --- extension package downloads (requires `npm run build` to have run) -----

res = await fetch(`http://127.0.0.1:${MCP_PORT}/extension.zip`);
if (res.status === 404) {
  console.log("SKIP  extension download checks (dist/ not built; run 'npm run build')");
} else {
  const zipBytes = Buffer.from(await res.arrayBuffer());
  check("download extension.zip", res.status === 200 && zipBytes.subarray(0, 2).toString() === "PK", `status=${res.status} len=${zipBytes.length}`);
  check("zip content-type", res.headers.get("content-type") === "application/zip", res.headers.get("content-type"));
  // Cloudflare (and other intermediaries) cache static-looking extensions by
  // default; without no-store a rebuild silently stays invisible behind the
  // edge cache for up to hours, so this must never be cacheable.
  check("zip cache-control forbids storing", res.headers.get("cache-control") === "no-store", res.headers.get("cache-control"));
  res = await fetch(`http://127.0.0.1:${MCP_PORT}/extension.crx`);
  const crxBytes = Buffer.from(await res.arrayBuffer());
  check("download extension.crx", res.status === 200 && crxBytes.subarray(0, 4).toString() === "Cr24", `status=${res.status} len=${crxBytes.length}`);
  check("crx cache-control forbids storing", res.headers.get("cache-control") === "no-store", res.headers.get("cache-control"));

  // --- /ccchrome.md (staged into dist/ by `npm run build`) ------------------

  res = await fetch(`http://127.0.0.1:${MCP_PORT}/ccchrome.md`);
  const mdBody = await res.text();
  check("ccchrome.md status", res.status === 200, `status=${res.status}`);
  check("ccchrome.md cache-control forbids storing", res.headers.get("cache-control") === "no-store", res.headers.get("cache-control"));
  check("ccchrome.md content-type is markdown", (res.headers.get("content-type") || "").startsWith("text/markdown"), res.headers.get("content-type"));
  check(
    "ccchrome.md body looks like the slash command (frontmatter with description:)",
    /^---\s*\n[\s\S]*?description:/.test(mdBody),
    mdBody.slice(0, 80)
  );

  // --- 404s: both downloads must fail with an actionable message when the
  // files they serve are missing. CC_CHROME_DIST_DIR is fixed for the life of
  // this spawned server, so this simulates "not built" by renaming the built
  // files out of the way for one request, rather than restarting the server.
  const distCcchrome = join(root, "dist", "ccchrome.md");
  const distCcchromeHidden = `${distCcchrome}.hidden-for-test`;
  renameSync(distCcchrome, distCcchromeHidden);
  try {
    res = await fetch(`http://127.0.0.1:${MCP_PORT}/ccchrome.md`);
    const errBody = await res.json();
    check(
      "ccchrome.md 404s with an actionable message when dist/ is missing it",
      res.status === 404 && /npm run build/.test(errBody.error || ""),
      `status=${res.status} body=${JSON.stringify(errBody)}`
    );
  } finally {
    renameSync(distCcchromeHidden, distCcchrome);
  }
}

// --- pairing abuse limits ---------------------------------------------------

// Dynamic tokens are capped so a leaked secret cannot be turned into an
// unbounded token factory. carol's token was revoked above, so the store is
// empty again and the cap of 2 applies cleanly from here.
async function pairAs(name) {
  return await fetch(`http://127.0.0.1:${MCP_PORT}/pair`, {
    method: "POST",
    headers: { authorization: `Bearer ${PAIR_SECRET}`, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
}
check("pair below the cap succeeds", (await pairAs("cap-one")).status === 200);
check("pair at the cap succeeds", (await pairAs("cap-two")).status === 200);
// 503, not 429: the cap will not clear by waiting, so it must be
// distinguishable from the rate limit below (which does carry Retry-After).
const overCap = await pairAs("cap-three");
check("pair beyond CC_CHROME_MAX_TOKENS is refused with 503", overCap.status === 503, `status=${overCap.status}`);
check("token-cap refusal has no Retry-After", !overCap.headers.get("retry-after"), `retry-after=${overCap.headers.get("retry-after")}`);
check(
  "token-cap message names CC_CHROME_MAX_TOKENS",
  ((await overCap.json()).error || "").includes("CC_CHROME_MAX_TOKENS"),
  "expected the error to name the env var"
);

// The pairing secret is the one value a human chooses, so it is the one worth
// throttling. Tokens are 128-bit random and not worth guessing.
const attemptStatuses = [];
let sawRateLimit = false;
let retryAfter = null;
for (let i = 0; i < 14; i++) {
  const attempt = await fetch(`http://127.0.0.1:${MCP_PORT}/pair`, {
    method: "POST",
    headers: { authorization: "Bearer wrong-secret-000000", "content-type": "application/json" },
    body: "{}",
  });
  attemptStatuses.push(attempt.status);
  if (attempt.status === 429) {
    sawRateLimit = true;
    retryAfter = attempt.headers.get("retry-after");
    break;
  }
}
check("repeated bad pairing secrets get rate limited", sawRateLimit, attemptStatuses.join(","));
check("rate limited response carries Retry-After", !!retryAfter && Number(retryAfter) > 0, `retry-after=${retryAfter}`);

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);

await context.close();
serverProc.kill();
pageServer.close();
rmSync(userDataDir, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
