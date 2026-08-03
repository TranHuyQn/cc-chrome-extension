// End-to-end test for http (VPS/multi-user) mode: starts the server with
// --http and two team tokens, launches real Chromium with the extension
// pointed at ws://127.0.0.1:<port>/ws?token=..., then talks to the server
// with the official MCP Streamable HTTP client — exactly like Claude Code
// configured with `claude mcp add --transport http`.
//
// Usage: node test/e2e-http.mjs   (requires `npm install` in test/ and server/)

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import WebSocket from "ws";

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

// A second Claude Code session with alice's token shares her browser.
const clientA2 = await mcpConnect(TOKEN_A);
r = await clientA2.callTool({ name: "get_page_text", arguments: {} });
check("second session, same token, same browser", toolText(r).includes("Hi TeamMate"), toolText(r).slice(0, 200));

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

r = await clientC.callTool({ name: "get_page_text", arguments: {} });
check("browser control via paired token", toolText(r).includes("Hi TeamMate"), toolText(r).slice(0, 200));

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

// --- extension package downloads (requires `npm run build` to have run) -----

res = await fetch(`http://127.0.0.1:${MCP_PORT}/extension.zip`);
if (res.status === 404) {
  console.log("SKIP  extension download checks (dist/ not built; run 'npm run build')");
} else {
  const zipBytes = Buffer.from(await res.arrayBuffer());
  check("download extension.zip", res.status === 200 && zipBytes.subarray(0, 2).toString() === "PK", `status=${res.status} len=${zipBytes.length}`);
  check("zip content-type", res.headers.get("content-type") === "application/zip", res.headers.get("content-type"));
  res = await fetch(`http://127.0.0.1:${MCP_PORT}/extension.crx`);
  const crxBytes = Buffer.from(await res.arrayBuffer());
  check("download extension.crx", res.status === 200 && crxBytes.subarray(0, 4).toString() === "Cr24", `status=${res.status} len=${crxBytes.length}`);
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
const overCap = await pairAs("cap-three");
check("pair beyond CC_CHROME_MAX_TOKENS is refused", overCap.status === 429, `status=${overCap.status}`);

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
