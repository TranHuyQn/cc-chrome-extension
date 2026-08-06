// The /panel socket is a second door into the same process, so it must refuse
// exactly like /ws does — same origin rule, same token rule, same close codes —
// plus one rule of its own: behind it sits a process spawn on the host, so it
// exists only on a bridge nobody but this machine can reach.
//
// That last rule is three conditions, not one. An earlier version checked only
// the bind address, and this repo ships the configuration that defeats it:
// deploy/chrome-bridge.service sets CC_CHROME_HOST=127.0.0.1 *because* a TLS
// reverse proxy sits in front of it, so a bind-address-only gate declares that
// deployment private and lets anyone with a token spawn `claude` on the VPS.
//
// Usage: node test/panel-auth.test.mjs

import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { isLoopbackAddress } from "../server/loopback.js";

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
function connectPanel(port, { origin = ORIGIN, token = TOKEN, subprotocol = true, headers = {}, path = "/panel" } = {}) {
  return new Promise((resolve) => {
    const protocols = subprotocol ? [`ccchrome.token.${token}`] : [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, protocols, { headers: { origin, ...headers } });
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

// --- loopback bind is not the same as "only this machine can reach me" ------
//
// The deployment above: bound to 127.0.0.1, reached through a reverse proxy.
// Presence of any X-Forwarded-* header is the proof that something is
// forwarding on someone else's behalf — the proxy's own peer address is
// loopback, so the peer check alone can never catch this.

check("an upgrade carrying X-Forwarded-For closes /panel with 4004",
  (await connectPanel(PORT, { headers: { "x-forwarded-for": "203.0.113.7" } })).closed === 4004,
  "a bridge behind a reverse proxy must never spawn claude, whatever it binds to");

check("an upgrade carrying X-Forwarded-Proto closes /panel with 4004",
  (await connectPanel(PORT, { headers: { "x-forwarded-proto": "https" } })).closed === 4004);

check("an upgrade carrying X-Forwarded-Host closes /panel with 4004",
  (await connectPanel(PORT, { headers: { "x-forwarded-host": "bridge.example.com" } })).closed === 4004);

// The mirror image, and the reason this rule lives on /panel alone: the
// extension bridge is *meant* to work through a reverse proxy (that is the
// entire http mode), so the same header must not cost it its connection.
check("the same header does NOT affect the /ws extension bridge",
  (await connectPanel(PORT, { path: "/ws", headers: { "x-forwarded-for": "203.0.113.7" } })).timeout === true,
  "a /ws socket is accepted and simply stays silent until the extension speaks first");

// --- the peer check, at the only level it can be tested ----------------------
//
// A non-loopback peer cannot be arranged against a loopback-bound listener: the
// kernel will not route a packet from another host to 127.0.0.1, which is
// exactly what makes binding there meaningful. So this branch is covered where
// it lives, against the address forms Node actually reports — including the
// IPv4-mapped one a dual-stack socket hands back.
const peerCases = [
  ["127.0.0.1", true],
  ["127.0.0.53", true],
  ["::1", true],
  ["[::1]", true],
  ["::ffff:127.0.0.1", true],
  ["::FFFF:127.0.0.1", true],
  ["::ffff:192.168.1.5", false],
  ["192.168.1.5", false],
  ["10.0.0.4", false],
  ["203.0.113.7", false],
  ["fe80::1%lo0", false],
  ["", false],
  [undefined, false],
  ["127.0.0.1.evil.com", false],
];
for (const [address, expected] of peerCases) {
  check(`peer ${JSON.stringify(address)} is ${expected ? "" : "not "}loopback`,
    isLoopbackAddress(address) === expected);
}

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
