// Chrome terminates an extension's service worker once its window has been in
// the background long enough for intensive throttling to starve the keepalive
// (measured on the live deployment: close=1001, lived=327s, silent_for=47s).
// The chrome.alarms entry revives the worker within ~30s, but every tool call
// that landed in that gap used to fail instantly with "not connected".
//
// This suite drives the server with a fake extension — a plain `ws` client that
// speaks the same frames the real background.js does — so the whole thing runs
// without a browser.
//
// Usage: node test/reconnect-grace.test.mjs   (requires `npm install` in test/ and server/)

import { spawn } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import WebSocket from "ws";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8791;
const TOKEN = "reconnect-test-token-0123456789";
const GRACE_MS = 6000;
const EXT_ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

let failures = 0;
function check(name, cond, detail = "") {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toolText = (result) => (result.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

// --- fake extension ---------------------------------------------------------

// Mirrors extension/background.js on the wire: `hello` on open, `pong` for
// `ping`, and a `response` carrying the same id for every `request`. The real
// handshake needs the chrome-extension Origin and the ccchrome.token.<t>
// subprotocol (see test/e2e-http.mjs).
function fakeExtension() {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, [`ccchrome.token.${TOKEN}`], {
    headers: { origin: EXT_ORIGIN },
  });
  const ext = {
    socket,
    calls: [],
    close: () => new Promise((r) => { socket.on("close", r); socket.close(); }),
  };
  socket.on("open", () => {
    socket.send(JSON.stringify({ type: "hello", client: "fake-extension", version: "3.0.0" }));
  });
  socket.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === "pong") return;
    if (msg.type !== "request") return;
    ext.calls.push(msg.method);
    socket.send(JSON.stringify({
      type: "response",
      id: msg.id,
      result: { tabs: [{ tabId: 1, title: "fake tab", url: "about:blank" }], via: "fake-extension" },
    }));
  });
  ext.ready = new Promise((r, j) => {
    socket.once("open", r);
    socket.once("error", j);
  });
  return ext;
}

// --- server -----------------------------------------------------------------

const serverProc = spawn("node", [join(root, "server", "index.js"), "--http"], {
  env: {
    ...process.env,
    CC_CHROME_PORT: String(PORT),
    CC_CHROME_HOST: "127.0.0.1",
    CC_CHROME_TOKENS: `${TOKEN}=reconnect-tester`,
    CC_CHROME_RECONNECT_GRACE_MS: String(GRACE_MS),
  },
  stdio: ["ignore", "inherit", "inherit"],
});

let up = false;
for (let i = 0; i < 40; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) { up = true; break; }
  } catch {}
  await sleep(250);
}
check("server is up", up);
if (!up) {
  serverProc.kill();
  process.exit(1);
}

const client = new Client({ name: "reconnect-test", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
  requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
}));
await client.listTools();

// --- 1. happy path ----------------------------------------------------------

let ext = fakeExtension();
await ext.ready;
await sleep(300);

let r = await client.callTool({ name: "list_tabs", arguments: {} });
check("tool call succeeds while the extension is connected", !r.isError && toolText(r).includes("fake-extension"), toolText(r).slice(0, 200));

// chrome_status must answer immediately — it is the tool used to ask whether
// the extension is there, so it may never sit in the grace wait.
let t0 = Date.now();
r = await client.callTool({ name: "chrome_status", arguments: {} });
check("chrome_status reports connected", toolText(r).includes('"connected": true'), toolText(r).slice(0, 200));
check("chrome_status is fast while connected", Date.now() - t0 < 2000, `${Date.now() - t0}ms`);

// --- 2. the regression: a call issued during the reconnect gap ---------------

await ext.close();
await sleep(100);

// chrome_status is asked first, while nothing is connected: it must answer now,
// not after the grace period.
t0 = Date.now();
r = await client.callTool({ name: "chrome_status", arguments: {} });
const statusMs = Date.now() - t0;
check("chrome_status answers immediately while disconnected", statusMs < GRACE_MS / 2, `${statusMs}ms`);
check("chrome_status still says connected:false", toolText(r).includes('"connected": false'), toolText(r).slice(0, 200));

// Issue the call into the gap, then bring the extension back a beat later —
// exactly what Chrome's cc-keepalive alarm does after it kills the worker.
t0 = Date.now();
const inFlight = client.callTool({ name: "list_tabs", arguments: {} });
await sleep(1500);
ext = fakeExtension();
await ext.ready;

r = await inFlight;
const gapMs = Date.now() - t0;
check(
  "a tool call issued during the reconnect gap succeeds once the extension is back",
  !r.isError && toolText(r).includes("fake-extension"),
  `${gapMs}ms -- ${toolText(r).slice(0, 300)}`
);
check("the waiting call resolves shortly after the reconnect, not at the grace deadline", gapMs < GRACE_MS, `${gapMs}ms (grace ${GRACE_MS}ms)`);

// --- 3. a genuine absence still fails, and fails on time --------------------

await ext.close();
await sleep(100);

t0 = Date.now();
r = await client.callTool({ name: "list_tabs", arguments: {} });
const failMs = Date.now() - t0;
check("with no extension coming back, the call fails", r.isError === true, toolText(r).slice(0, 200));
check("it fails with the existing 'not connected' message", toolText(r).includes("not connected"), toolText(r).slice(0, 200));
check("it waits roughly the grace period first", failMs >= GRACE_MS - 500, `${failMs}ms (grace ${GRACE_MS}ms)`);
check("it does not hang until the 45s request timeout", failMs < GRACE_MS + 5000, `${failMs}ms`);

serverProc.kill();

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
