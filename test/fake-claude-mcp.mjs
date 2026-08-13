// A second stand-in for the `claude` binary, for the panel-protocol test.
//
// test/fake-claude.mjs replays a captured transcript and never touches the
// network, which is the right shape for testing AgentSession's translation
// layer. This one is the opposite half: it ignores what it says and does what a
// real child does to the *server* — reads --mcp-config out of its own argv,
// performs a full MCP handshake against that URL, and calls one browser tool.
//
// That is the only way to observe the invariant the panel depends on: two
// consecutive turns are two separate processes, each doing its own MCP
// `initialize`, and both must land on the same MCP session id or the extension
// puts each turn's tabs in a different tab group.
//
//   CC_FAKE_SESSION_FILE  append the negotiated Mcp-Session-Id here (one per line)
//   CC_FAKE_TOOL          tool to call after the handshake (default list_tabs)
//
// The NDJSON it writes to stdout is handcrafted rather than captured on purpose:
// nothing here is testing transcript translation (agent-session.test.mjs does
// that against real fixtures), only that a turn runs end to end.

import { appendFileSync, readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const configIndex = argv.indexOf("--mcp-config");
if (configIndex === -1) {
  process.stderr.write("fake-claude-mcp: no --mcp-config in argv\n");
  process.exit(2);
}
// --mcp-config takes either a path or inline JSON, and the real CLI accepts
// both. AgentSession switched to the path form (the token used to be visible
// in argv, and its JSON quotes could not survive cmd.exe on Windows), so this
// stand-in has to accept both too or it stops standing in for anything.
const configArg = argv[configIndex + 1];
const config = JSON.parse(
  configArg.trimStart().startsWith("{") ? configArg : readFileSync(configArg, "utf8"),
);
const { url, headers } = config.mcpServers.chrome;

process.stdin.resume();
process.stdin.on("data", () => {});

// The server may answer either as JSON or as a one-shot SSE stream; both carry
// the same JSON-RPC payload, so unwrap whichever arrived.
function parsePayload(contentType, text) {
  if (!text) return null;
  if ((contentType || "").includes("text/event-stream")) {
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    return line ? JSON.parse(line.slice(5).trim()) : null;
  }
  return JSON.parse(text);
}

async function rpc(target, body, sessionId) {
  const res = await fetch(target, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    sessionId: res.headers.get("mcp-session-id"),
    payload: parsePayload(res.headers.get("content-type"), text),
  };
}

const init = await rpc(url, {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "fake-claude-mcp", version: "1" },
  },
});
if (init.status !== 200 || !init.sessionId) {
  process.stderr.write(`fake-claude-mcp: initialize failed (${init.status})\n`);
  process.exit(3);
}
if (process.env.CC_FAKE_SESSION_FILE) {
  appendFileSync(process.env.CC_FAKE_SESSION_FILE, init.sessionId + "\n");
}

await rpc(url, { jsonrpc: "2.0", method: "notifications/initialized" }, init.sessionId);

const toolName = process.env.CC_FAKE_TOOL || "list_tabs";
const called = await rpc(
  url,
  { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: toolName, arguments: {} } },
  init.sessionId
);
if (called.status !== 200) {
  process.stderr.write(`fake-claude-mcp: tools/call failed (${called.status})\n`);
  process.exit(4);
}

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
emit({
  type: "assistant",
  message: { content: [{ type: "tool_use", name: `mcp__chrome__${toolName}`, input: {} }] },
});
emit({ type: "assistant", message: { content: [{ type: "text", text: "xong" }] } });
process.exit(0);
