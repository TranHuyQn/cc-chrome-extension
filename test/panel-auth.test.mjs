// The /panel socket is a second door into the same process, so it must refuse
// exactly like /ws does — same origin rule, same token rule, same close codes —
// plus one rule of its own: a bridge that is not bound to loopback must not
// expose it at all, because behind it sits a process spawn on the host.
//
// Usage: node test/panel-auth.test.mjs

import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "paneltoken12345";
const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

let failures = 0;
function check(name, cond, detail = "") {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(host, port) {
  const child = spawn(process.execPath, [join(root, "server", "index.js"), "--http"], {
    env: {
      ...process.env,
      CC_CHROME_TOKENS: `${TOKEN}=panel`,
      CC_CHROME_HOST: host,
      CC_CHROME_PORT: String(port),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", () => {});
  return child;
}

async function waitForHealth(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  return false;
}

// Resolves with the close code, so a refusal is observable the way the panel
// itself observes it — a browser cannot read the HTTP status of a failed upgrade.
function connectPanel(port, { origin = ORIGIN, token = TOKEN, subprotocol = true } = {}) {
  return new Promise((resolve) => {
    const protocols = subprotocol ? [`ccchrome.token.${token}`] : [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/panel`, protocols, { headers: { origin } });
    const done = (value) => { try { ws.close(); } catch { /* already closing */ } resolve(value); };
    ws.on("close", (code) => resolve({ closed: code }));
    ws.on("error", () => resolve({ closed: 1006 }));
    ws.on("message", (data) => done({ message: JSON.parse(data.toString()) }));
    setTimeout(() => done({ timeout: true }), 5000);
  });
}

// --- loopback bridge: the normal case ---------------------------------------

const PORT = 8791;
const server = startServer("127.0.0.1", PORT);
check("loopback server came up", await waitForHealth(PORT));

check("good origin + good token is accepted",
  (await connectPanel(PORT)).message !== undefined,
  "expected a server hello frame");

check("bad token closes with 4001",
  (await connectPanel(PORT, { token: "wrongtoken12345" })).closed === 4001);

check("missing subprotocol closes with 4002",
  (await connectPanel(PORT, { subprotocol: false })).closed === 4002);

check("non-extension origin closes with 4003",
  (await connectPanel(PORT, { origin: "https://evil.example.com" })).closed === 4003);

check("absent origin closes with 4003",
  (await connectPanel(PORT, { origin: "" })).closed === 4003);

server.kill();
await sleep(500);

// --- public bridge: /panel must not exist -----------------------------------

const PUBLIC_PORT = 8792;
const publicServer = startServer("0.0.0.0", PUBLIC_PORT);
check("public server came up", await waitForHealth(PUBLIC_PORT));

check("a non-loopback bridge refuses /panel with 4004",
  (await connectPanel(PUBLIC_PORT)).closed === 4004,
  "a public bridge must never spawn claude on the host");

publicServer.kill();

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
