// MCP sessions used to live forever: a client that vanished without closing
// left its transport in the map for the lifetime of the process. This runs a
// server with a two-second TTL and checks the session is actually reaped.
//
// Usage: node test/session-ttl.test.mjs   (requires `npm install` in test/ and server/)

import { spawn } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8789;
const TOKEN = "ttl-test-token-0123456789";

let failures = 0;
function check(name, cond, detail = "") {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const health = async () => await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();

const serverProc = spawn("node", [join(root, "server", "index.js"), "--http"], {
  env: {
    ...process.env,
    CC_CHROME_PORT: String(PORT),
    CC_CHROME_HOST: "127.0.0.1",
    CC_CHROME_TOKENS: `${TOKEN}=ttl-tester`,
    CC_CHROME_SESSION_TTL_MS: "2000",
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
if (!up) process.exit(1);

check("no sessions before any client connects", (await health()).mcpSessions === 0, JSON.stringify(await health()));

const client = new Client({ name: "ttl-test", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
  requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
}));
await client.listTools();
check("session is tracked after connecting", (await health()).mcpSessions === 1, JSON.stringify(await health()));

// The client stops talking without closing — exactly the leak this fixes.
await sleep(6000);
const after = await health();
check("idle session is reaped after the TTL", after.mcpSessions === 0, JSON.stringify(after));

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
serverProc.kill();
process.exit(failures === 0 ? 0 : 1);
