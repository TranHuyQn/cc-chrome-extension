// The panel's load-bearing invariant: one panel, one MCP session id, for every
// turn it ever runs.
//
// Each chat turn is a fresh `claude` process and therefore a fresh MCP
// `initialize`. The id that comes out of that is what the extension turns into a
// tab group name (sessionGroupTitle() in extension/background.js), so if a turn
// ever gets its own id, turn two silently loses access to the tabs turn one
// opened. Nothing throws, no existing suite goes red — the tools just start
// refusing tabs that worked a moment earlier. That combination of high
// consequence and zero signal is why this file exists.
//
// No browser: the extension end is a stand-in socket that records the `session`
// field the server attaches to each tool request, and the `claude` end is
// test/fake-claude-mcp.mjs reached through a PATH shim.
//
// Usage: node test/panel-protocol.test.mjs

import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import WebSocket from "ws";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "panelprototoken123";
const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const PORT = 8793;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(name, cond, detail = "") {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const workdir = mkdtempSync(join(tmpdir(), "cc-panel-proto-"));
const sessionFile = join(workdir, "sessions.txt");

// The panel builds its own AgentSession with the default claudeBin ("claude"),
// so the only seam for a fake is PATH. Node resolves an unqualified command
// against the PATH of the env it hands the child, so a shim directory in front
// of it wins.
const shimDir = join(workdir, "bin");
const shim = join(shimDir, "claude");
mkdirSync(shimDir, { recursive: true });
writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(root, "test", "fake-claude-mcp.mjs"))} "$@"\n`);
chmodSync(shim, 0o755);

const server = spawn(process.execPath, [join(root, "server", "index.js"), "--http"], {
  env: {
    ...process.env,
    PATH: `${shimDir}:${process.env.PATH}`,
    CC_CHROME_TOKENS: `${TOKEN}=panelproto`,
    CC_CHROME_HOST: "127.0.0.1",
    CC_CHROME_PORT: String(PORT),
    CC_FAKE_SESSION_FILE: sessionFile,
  },
  stdio: ["ignore", "ignore", "pipe"],
});
const serverLog = [];
server.stderr.setEncoding("utf8");
server.stderr.on("data", (chunk) => serverLog.push(chunk));

async function waitForHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  return false;
}

check("server came up", await waitForHealth());

// --- stand-in extension ------------------------------------------------------
//
// It records nothing but the `session` field the server attaches to each tool
// request; that is precisely the value sessionGroupTitle() hashes into a tab
// group name.

const toolSessions = [];
const ext = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, [`ccchrome.token.${TOKEN}`], {
  headers: { origin: ORIGIN },
});
ext.on("open", () => ext.send(JSON.stringify({ type: "hello", client: "test-stand-in", version: "3.3.0" })));
ext.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type !== "request") return;
  toolSessions.push({ method: msg.method, session: msg.session });
  ext.send(JSON.stringify({
    type: "response",
    id: msg.id,
    result: { tabs: [{ id: 42, title: "Stand-in tab", url: "https://example.com/" }] },
  }));
});
for (let i = 0; i < 50 && ext.readyState !== 1; i++) await sleep(100);
check("stand-in extension connected", ext.readyState === 1);

// --- panel socket ------------------------------------------------------------

const frames = [];
const panel = new WebSocket(`ws://127.0.0.1:${PORT}/panel`, [`ccchrome.token.${TOKEN}`], {
  headers: { origin: ORIGIN },
});
panel.on("message", (data) => frames.push(JSON.parse(data.toString())));
const send = (obj) => panel.send(JSON.stringify(obj));
const waitFor = async (predicate, ms = 20000) => {
  for (let i = 0; i < ms / 50; i++) {
    const hit = frames.find(predicate);
    if (hit) return hit;
    await sleep(50);
  }
  return null;
};

const hello = await waitFor((f) => f.type === "hello");
check("panel gets a hello frame carrying its id", !!hello?.panelId, JSON.stringify(hello));

send({ type: "start", sessionId: null, model: "sonnet" });
const ready = await waitFor((f) => f.type === "ready");
check("start is answered with ready", !!ready, JSON.stringify(frames));

// --- two turns, one session id ----------------------------------------------

send({ type: "prompt", text: "lượt một" });
const end1 = await waitFor((f) => f.type === "turn_end");
check("turn 1 ends ok", end1?.ok === true, JSON.stringify(end1) + " server: " + serverLog.join(""));

send({ type: "prompt", text: "lượt hai" });
for (let i = 0; i < 400 && frames.filter((f) => f.type === "turn_end").length < 2; i++) await sleep(50);
const end2 = frames.filter((f) => f.type === "turn_end")[1];
check("turn 2 ends ok", end2?.ok === true, JSON.stringify(end2) + " server: " + serverLog.join(""));

// Two separate children, two separate MCP initializes.
const childSessions = existsSync(sessionFile)
  ? readFileSync(sessionFile, "utf8").split("\n").filter(Boolean)
  : [];
check("each turn ran its own claude child that initialized MCP",
  childSessions.length === 2, JSON.stringify(childSessions));

check("both turns reached the extension with a tool request",
  toolSessions.length === 2, JSON.stringify(toolSessions));

// The assertion this whole file exists for. Equality, not non-emptiness: a
// restored `sessionIdGenerator: randomUUID` leaves both values populated and
// only this comparison notices.
check("both turns deliver the SAME mcp session id to the extension",
  toolSessions.length === 2 &&
  !!toolSessions[0].session &&
  toolSessions[0].session === toolSessions[1].session,
  JSON.stringify(toolSessions));

check("the id the children negotiated is the id the extension saw",
  childSessions[0] === toolSessions[0]?.session &&
  childSessions[1] === toolSessions[1]?.session,
  `children=${JSON.stringify(childSessions)} extension=${JSON.stringify(toolSessions.map((t) => t.session))}`);

// --- groupTitle agrees with sessionGroupTitle() ------------------------------
//
// Derived from the observed session id rather than hardcoded, so the check
// travels with whatever uuid this run happens to draw. The separator is U+00B7.

const observed = toolSessions[0]?.session || "";
const expectedTitle = `Claude · ${observed.replace(/-/g, "").slice(0, 4)}`;
check("ready.groupTitle names the tab group the extension will actually create",
  ready?.groupTitle === expectedTitle,
  `ready=${JSON.stringify(ready?.groupTitle)} expected=${JSON.stringify(expectedTitle)}`);

// And that expectation is not a second copy of the rule: it is the extension's
// own line, read out of the file that owns it.
const backgroundSrc = readFileSync(join(root, "extension", "background.js"), "utf8");
const template = backgroundSrc.match(/return (`Claude .*?`);/s)?.[1];
const fromExtension = template ? new Function("session", "return " + template)(observed) : null;
check("that title is byte-identical to sessionGroupTitle() in extension/background.js",
  !!fromExtension && fromExtension === ready?.groupTitle,
  `extension=${JSON.stringify(fromExtension)} panel=${JSON.stringify(ready?.groupTitle)}`);

// --- unknown frame types are not swallowed -----------------------------------

send({ type: "definitely_not_a_real_command" });
const errFrame = await waitFor((f) => f.type === "error", 5000);
check("an unrecognised frame type comes back as an error naming itself",
  !!errFrame && errFrame.message.includes("definitely_not_a_real_command"),
  JSON.stringify(errFrame));

// --- re-initialize on a live panel -------------------------------------------
//
// Same thing turn 3 would do. The old transport must be closed rather than
// silently overwritten in the sessions map, and the replacement must still work.

const initialize = (target) => fetch(target, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe", version: "1" } },
  }),
});

const reinitA = await initialize(`${BASE}/mcp?panel=${hello.panelId}`);
const idA = reinitA.headers.get("mcp-session-id");
const reinitB = await initialize(`${BASE}/mcp?panel=${hello.panelId}`);
const idB = reinitB.headers.get("mcp-session-id");
check("a re-initialize on a live panel returns the same mcp session id",
  !!idA && idA === idB, `${idA} vs ${idB}`);
check("that id is still the one the turns used", idA === observed, `${idA} vs ${observed}`);

const survivor = await fetch(`${BASE}/mcp`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "mcp-session-id": idB,
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
});
check("the surviving session still answers tools/list", survivor.status === 200, String(survivor.status));

// attach_tab must never be reachable as an MCP tool call — it is the one
// place this codebase deliberately grants access outside the caller's own
// tab group, and it exists only on the panel -> attachPanelTab -> extension
// path, never inside buildMcpServer(). A grep proves that statically; this
// proves it against the server's own live tools/list response, which is what
// Claude Code actually sees. MCP tool names can be namespaced by the client
// (e.g. "mcp__chrome__attach_tab"), so both an exact match and a "...__" +
// name suffix are checked.
const survivorBody = await survivor.text();
const survivorJson = /^data: /m.test(survivorBody)
  ? JSON.parse(survivorBody.split("\n").find((l) => l.startsWith("data: ")).slice(6))
  : JSON.parse(survivorBody);
const toolNames = (survivorJson.result?.tools || []).map((t) => t.name);
check(
  "attach_tab is not among the tools/list this MCP session exposes to Claude",
  toolNames.length > 0 && !toolNames.some((n) => n === "attach_tab" || n.endsWith("__attach_tab")),
  JSON.stringify(toolNames)
);

// --- everyone else is unaffected ---------------------------------------------

const plainA = await initialize(`${BASE}/mcp`);
const plainB = await initialize(`${BASE}/mcp`);
const plainIdA = plainA.headers.get("mcp-session-id");
const plainIdB = plainB.headers.get("mcp-session-id");
check("an /mcp client with no ?panel= still gets a session id",
  plainA.status === 200 && !!plainIdA, `${plainA.status} ${plainIdA}`);
check("two such clients get different ids, i.e. ordinary Claude Code is untouched",
  !!plainIdB && plainIdA !== plainIdB && plainIdA !== observed,
  `${plainIdA} vs ${plainIdB} (panel ${observed})`);

const unknown = await initialize(`${BASE}/mcp?panel=deadbeef-0000-0000-0000-000000000000`);
check("an unknown ?panel= id is refused with 404", unknown.status === 404, String(unknown.status));

// --- a closed panel takes its MCP session with it ----------------------------
//
// The panel's session id is one only that panel ever uses, so once the socket
// is gone nothing can reach the transport again — but it would still sit in the
// sessions map pinning an McpServer until the 8-hour idle reaper. Open and
// close the side panel through a working day and that is dozens of them.

const before = (await (await fetch(`${BASE}/health`)).json()).mcpSessions;
check("the panel's mcp session is live while the panel is open", before >= 1, String(before));

panel.close();
await sleep(500);
const after = (await (await fetch(`${BASE}/health`)).json()).mcpSessions;
check("closing the panel drops its mcp session instead of leaking it until the reaper",
  after === before - 1, `before=${before} after=${after}`);

// --- two panels at once, and the ids a panel replays -------------------------
//
// Everything below concerns what a panel is allowed to hand back to the server
// on `start`. Two ids travel there and both used to be taken on trust:
//
//   sessionId    goes to `claude --resume`/`--session-id`, i.e. into argv.
//                Two side panels in two Chrome windows read one
//                extension-global storage key and both resumed the SAME
//                on-disk conversation, interleaving two chats into one file.
//   mcpSessionId names the tab group (sessionGroupTitle). It was minted fresh
//                on every panel connection, so a reconnect renamed the group
//                and stranded every tab the user had attached.

function openPanel() {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/panel`, [`ccchrome.token.${TOKEN}`], {
    headers: { origin: ORIGIN },
  });
  const seen = [];
  socket.on("message", (data) => seen.push(JSON.parse(data.toString())));
  return {
    socket,
    frames: seen,
    send: (obj) => socket.send(JSON.stringify(obj)),
    waitFor: async (predicate, ms = 10000) => {
      for (let i = 0; i < ms / 50; i++) {
        const hit = seen.find(predicate);
        if (hit) return hit;
        await sleep(50);
      }
      return null;
    },
  };
}

const panelA = openPanel();
await panelA.waitFor((f) => f.type === "hello");
panelA.send({ type: "start", sessionId: null, model: "sonnet" });
const readyA = await panelA.waitFor((f) => f.type === "ready");
check("panel A starts a session of its own", !!readyA?.sessionId, JSON.stringify(readyA));

const panelB = openPanel();
await panelB.waitFor((f) => f.type === "hello");
// Exactly what the old extension-global storage key made the second window do.
panelB.send({ type: "start", sessionId: readyA.sessionId, mcpSessionId: readyA.mcpSessionId, model: "sonnet" });
const readyB = await panelB.waitFor((f) => f.type === "ready");
check("a second panel replaying a live conversation id does NOT get that conversation",
  !!readyB?.sessionId && readyB.sessionId !== readyA.sessionId,
  `A=${readyA?.sessionId} B=${readyB?.sessionId}`);
check("and it is told why, instead of two chats silently sharing one file on disk",
  !!(await panelB.waitFor((f) => f.type === "error", 3000)),
  JSON.stringify(panelB.frames));
check("nor does it get the other panel's tab group",
  !!readyB?.mcpSessionId && readyB.mcpSessionId !== readyA.mcpSessionId,
  `A=${readyA?.mcpSessionId} B=${readyB?.mcpSessionId}`);

// A malformed id must never reach argv: `claude` parses whatever it is handed,
// and a value shaped like a flag is read as one.
panelB.send({ type: "start", sessionId: "--dangerous-flag", model: "sonnet" });
const badId = await panelB.waitFor((f) => f.type === "error" && /sessionId/.test(f.message || ""), 3000);
check("a sessionId that is not a UUID is refused before it can reach argv",
  !!badId, JSON.stringify(panelB.frames));

// This is the exact frame shape that used to dispose panelB's live agent
// (the one from its earlier successful `start` above) before uuidOrNull()
// ever ran, so the throw happened too late to stop it: panel.agent was left
// pointing at a disposed AgentSession, `if (!panel.agent)` never caught it,
// and the next `prompt` spawned a real `claude` child whose turn_start /
// delta / turn_end were all swallowed by AgentSession.emit()'s `this.disposed`
// guard — a paid turn consumed with nothing shown for it. Checking for the
// error frame alone (above) would not have caught that: the fix is proven
// only by showing the panel still works afterwards.
panelB.send({ type: "prompt", text: "vẫn dùng được sau khi start hỏng" });
const turnStartAfterBadStart = await panelB.waitFor((f) => f.type === "turn_start", 5000);
check("the panel is still usable after a rejected start: the prompt reaches the still-live agent and turn_start arrives",
  !!turnStartAfterBadStart, JSON.stringify(panelB.frames));

// --- the reconnect case: the tab group survives ------------------------------
//
// `panel` (the first socket in this file) is closed by now, so the id it used
// is free again — which is exactly the state after a dropped socket or a
// restarted bridge. Replaying it must put this panel back in the same group.

const panelC = openPanel();
await panelC.waitFor((f) => f.type === "hello");
panelC.send({ type: "start", sessionId: null, mcpSessionId: observed, model: "sonnet" });
const readyC = await panelC.waitFor((f) => f.type === "ready");
check("a reconnecting panel that replays its mcp session id keeps it",
  readyC?.mcpSessionId === observed, `${readyC?.mcpSessionId} vs ${observed}`);
check("so the tab group name is the same one the attached tabs are already in",
  readyC?.groupTitle === expectedTitle, `${readyC?.groupTitle} vs ${expectedTitle}`);
check("a panel that replays nothing still gets a group of its own",
  readyA?.groupTitle !== expectedTitle && readyB?.groupTitle !== expectedTitle,
  `A=${readyA?.groupTitle} B=${readyB?.groupTitle} replayed=${expectedTitle}`);

try { panelA.socket.close(); } catch { /* already closing */ }
try { panelB.socket.close(); } catch { /* already closing */ }
try { panelC.socket.close(); } catch { /* already closing */ }
await sleep(300);

// --- teardown ----------------------------------------------------------------

try { panel.close(); } catch { /* already closing */ }
try { ext.close(); } catch { /* already closing */ }
await sleep(200);
server.kill();
rmSync(workdir, { recursive: true, force: true });

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
