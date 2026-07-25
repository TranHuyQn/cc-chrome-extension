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

const serverProc = spawn("node", [join(root, "server", "index.js"), "--http"], {
  env: {
    ...process.env,
    CC_CHROME_PORT: String(MCP_PORT),
    CC_CHROME_HOST: "127.0.0.1",
    CC_CHROME_TOKENS: `${TOKEN_A}=alice,${TOKEN_B}=bob`,
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
  headless: true,
  executablePath: "/opt/pw-browsers/chromium",
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

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);

await context.close();
serverProc.kill();
pageServer.close();
rmSync(userDataDir, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
