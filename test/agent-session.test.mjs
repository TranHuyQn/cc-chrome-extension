// Usage: node test/agent-session.test.mjs
//
// Runs AgentSession against a fake `claude` that replays the transcript captured
// in Task 1. No real model call, no network — this is about the translation
// layer and the process lifecycle, which are the parts that break silently.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { AgentSession } from "../server/agent.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(root, "test", "fixtures", "claude-stream.ndjson");
const fakeClaude = join(root, "test", "fake-claude.mjs");

let failures = 0;
function check(name, cond, detail = "") {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const workdir = mkdtempSync(join(tmpdir(), "cc-agent-test-"));

function makeSession(extra = {}) {
  const events = [];
  const session = new AgentSession({
    sessionId: "11111111-2222-3333-4444-555555555555",
    model: "sonnet",
    mcpUrl: "http://127.0.0.1:8787/mcp?panel=test",
    allowedTools: "mcp__chrome",
    cwd: workdir,
    claudeBin: process.execPath,
    claudeArgsPrefix: [fakeClaude],
    env: { CC_FAKE_FIXTURE: fixture, ...(extra.env || {}) },
    onEvent: (event) => events.push(event),
    log: () => {},
  });
  return { session, events };
}

// --- 1. a whole turn translates into panel events ---------------------------

{
  const { session, events } = makeSession();
  session.send("xin chào");
  for (let i = 0; i < 100 && !events.some((e) => e.type === "turn_end"); i++) await sleep(50);

  check("emits turn_start first", events[0]?.type === "turn_start", JSON.stringify(events[0]));
  check("emits at least one assistant message", events.some((e) => e.type === "message" && e.text.length > 0));
  check("emits a tool event naming the chrome tool",
    events.some((e) => e.type === "tool" && e.name.includes("chrome")),
    JSON.stringify(events.filter((e) => e.type === "tool")));
  check("ends with turn_end ok", events.at(-1)?.type === "turn_end" && events.at(-1)?.ok === true,
    JSON.stringify(events.at(-1)));
  check("no event type outside the contract",
    events.every((e) => ["turn_start", "delta", "message", "tool", "turn_end"].includes(e.type)),
    JSON.stringify([...new Set(events.map((e) => e.type))]));
  session.dispose();
}

// --- 2. the argv carries the flags the design depends on --------------------

{
  const argvFile = join(workdir, "argv.json");
  const { session, events } = makeSession({ env: { CC_FAKE_ARGV: argvFile } });
  session.send("xin chào");
  for (let i = 0; i < 100 && !events.some((e) => e.type === "turn_end"); i++) await sleep(50);

  const argv = JSON.parse(readFileSync(argvFile, "utf8"));
  const flat = argv.join(" ");
  check("passes --print", argv.includes("-p") || argv.includes("--print"), flat);
  check("asks for stream-json output", flat.includes("--output-format stream-json"), flat);
  check("disables every built-in tool", argv.includes("--tools") && argv[argv.indexOf("--tools") + 1] === "", flat);
  check("uses strict mcp config", argv.includes("--strict-mcp-config"), flat);
  check("allows the chrome mcp tools", flat.includes("mcp__chrome"), flat);
  check("first turn opens the session id, not a resume",
    argv.includes("--session-id") && !argv.includes("--resume"), flat);
  session.dispose();
}

// --- 3. the second turn resumes instead of starting over --------------------

{
  const argvFile = join(workdir, "argv2.json");
  const { session, events } = makeSession({ env: { CC_FAKE_ARGV: argvFile } });
  session.send("lượt một");
  for (let i = 0; i < 100 && !events.some((e) => e.type === "turn_end"); i++) await sleep(50);
  session.send("lượt hai");
  for (let i = 0; i < 100 && events.filter((e) => e.type === "turn_end").length < 2; i++) await sleep(50);

  const argv = JSON.parse(readFileSync(argvFile, "utf8"));
  check("second turn resumes the same session",
    argv.includes("--resume") && argv[argv.indexOf("--resume") + 1] === "11111111-2222-3333-4444-555555555555",
    argv.join(" "));
  session.dispose();
}

// --- 3b. a handed-over session id resumes on the very first turn -------------
//
// The panel persists the id from `ready` and replays it when it reopens. That
// conversation already exists on disk, so turn one must --resume it; passing
// --session-id an already-used uuid is rejected by the CLI.

{
  const argvFile = join(workdir, "argv-resume.json");
  const events = [];
  const session = new AgentSession({
    sessionId: "99999999-8888-7777-6666-555555555555",
    model: "sonnet",
    mcpUrl: "http://127.0.0.1:8787/mcp?panel=test",
    allowedTools: "mcp__chrome",
    cwd: workdir,
    resuming: true,
    claudeBin: process.execPath,
    claudeArgsPrefix: [fakeClaude],
    env: { CC_FAKE_FIXTURE: fixture, CC_FAKE_ARGV: argvFile },
    onEvent: (event) => events.push(event),
    log: () => {},
  });
  session.send("lượt đầu sau khi mở lại panel");
  for (let i = 0; i < 100 && !events.some((e) => e.type === "turn_end"); i++) await sleep(50);

  const argv = JSON.parse(readFileSync(argvFile, "utf8"));
  check("resuming:true makes the FIRST turn a --resume, not a --session-id",
    argv.includes("--resume") &&
    argv[argv.indexOf("--resume") + 1] === "99999999-8888-7777-6666-555555555555" &&
    !argv.includes("--session-id"),
    argv.join(" "));
  session.dispose();
}

// --- 4. stop() actually kills the child -------------------------------------

{
  const { session, events } = makeSession({ env: { CC_FAKE_DELAY_MS: "200" } });
  session.send("chạy dài");
  await sleep(300);
  check("busy while the child runs", session.busy === true);
  const stopped = session.stop();
  check("stop() reports it killed something", stopped === true);
  for (let i = 0; i < 60 && session.busy; i++) await sleep(50);
  check("not busy after stop", session.busy === false);
  check("turn_end reports failure after a stop",
    events.at(-1)?.type === "turn_end" && events.at(-1)?.ok === false,
    JSON.stringify(events.at(-1)));
  session.dispose();
}

// --- 5. a spawn failure emits exactly one turn_end --------------------------
//
// Node fires both `error` and `close` for a child that never actually spawned
// (e.g. ENOENT on claudeBin). Assert the count, not just the last event —
// checking only the tail would let a duplicate turn_end slip back in unseen.

{
  const events = [];
  const session = new AgentSession({
    sessionId: "11111111-2222-3333-4444-555555555555",
    model: "sonnet",
    mcpUrl: "http://127.0.0.1:8787/mcp?panel=test",
    allowedTools: "mcp__chrome",
    cwd: workdir,
    claudeBin: "/nonexistent/binary/does-not-exist-xyz",
    onEvent: (event) => events.push(event),
    log: () => {},
  });
  session.send("xin chào");
  for (let i = 0; i < 100 && !events.some((e) => e.type === "turn_end"); i++) await sleep(50);
  await sleep(100); // give a stray second close()/error() a chance to arrive

  const turnEnds = events.filter((e) => e.type === "turn_end");
  check("exactly one turn_end after a spawn failure", turnEnds.length === 1, JSON.stringify(turnEnds));
  check("that turn_end reports failure", turnEnds[0]?.ok === false, JSON.stringify(turnEnds[0]));
  session.dispose();
}

// --- 6. the stopping flag resets so the following turn can still succeed ----

{
  const { session, events } = makeSession({ env: { CC_FAKE_DELAY_MS: "200" } });
  session.send("lượt bị dừng");
  await sleep(300);
  session.stop();
  for (let i = 0; i < 100 && !events.some((e) => e.type === "turn_end"); i++) await sleep(50);
  check("stopped turn ends with ok:false", events.at(-1)?.type === "turn_end" && events.at(-1)?.ok === false,
    JSON.stringify(events.at(-1)));

  session.send("lượt sau khi dừng");
  for (let i = 0; i < 100 && events.filter((e) => e.type === "turn_end").length < 2; i++) await sleep(50);
  check("the turn after a stop reports ok:true", events.at(-1)?.type === "turn_end" && events.at(-1)?.ok === true,
    JSON.stringify(events.at(-1)));
  session.dispose();
}

// --- 7. a real content_block_delta line becomes a delta event ---------------
//
// test/fixtures/claude-stream-delta.ndjson is not invented: every line is
// quoted verbatim in .superpowers/sdd/2026-08-05-sidepanel-chat/task-1-report.md
// (the `stream_event`/`content_block_*` rows of the type table), captured from
// a real `claude -p --include-partial-messages` run. The committed turn
// fixture (claude-stream.ndjson) has no stream_event lines because that
// particular probe run did not pass --include-partial-messages, so this
// second, narrower fixture is the only way to exercise the delta path against
// genuine captured data instead of an invented shape.

{
  const deltaFixture = join(root, "test", "fixtures", "claude-stream-delta.ndjson");
  const { session, events } = makeSession({ env: { CC_FAKE_FIXTURE: deltaFixture } });
  session.send("xin chào");
  for (let i = 0; i < 100 && !events.some((e) => e.type === "turn_end"); i++) await sleep(50);

  check("a real content_block_delta line becomes a delta event",
    events.some((e) => e.type === "delta" && e.text === "ch"),
    JSON.stringify(events));
  session.dispose();
}

// --- 7b. a failing turn carries the CLI's own explanation -------------------
//
// The exit code alone reads identically for a dead session id, a crash, a bad
// model name and an auth failure. The one sentence that tells them apart is the
// CLI's last stderr line, and it used to reach only the server log — so the
// panel could never say "phiên cũ không còn" instead of "exit 1".

{
  const stderrText = "Some earlier warning\n\nNo conversation found with session ID: 12345678-dead-beef-0000-000000000000";
  const { session, events } = makeSession({
    env: { CC_FAKE_STDERR: stderrText, CC_FAKE_EXIT: "1" },
  });
  session.send("mở lại một phiên đã mất");
  for (let i = 0; i < 100 && !events.some((e) => e.type === "turn_end"); i++) await sleep(50);

  const end = events.at(-1);
  check("a non-zero exit still reports the exit code",
    end?.type === "turn_end" && end.ok === false && end.error.includes("mã 1"),
    JSON.stringify(end));
  check("turn_end.error carries the CLI's last stderr line verbatim",
    end?.error?.includes("No conversation found with session ID: 12345678-dead-beef-0000-000000000000"),
    JSON.stringify(end));
  check("only the LAST non-empty stderr line travels, not the whole buffer",
    end?.error?.includes("Some earlier warning") === false,
    JSON.stringify(end));
  session.dispose();
}

// --- 7c. a clean turn is unchanged ------------------------------------------

{
  const { session, events } = makeSession({ env: { CC_FAKE_STDERR: "noise on a successful run" } });
  session.send("lượt bình thường");
  for (let i = 0; i < 100 && !events.some((e) => e.type === "turn_end"); i++) await sleep(50);
  check("a successful turn_end still carries no error",
    events.at(-1)?.ok === true && events.at(-1)?.error === undefined,
    JSON.stringify(events.at(-1)));
  session.dispose();
}

// --- 8. a disposed session emits nothing, ever ------------------------------
//
// dispose() SIGKILLs the child, but the kill is asynchronous and the stdout
// listener stays attached, so lines already buffered keep arriving and keep
// translating. The panel's start-while-busy path disposes the old session and
// immediately sends `ready` down the SAME open socket, so a late delta or
// message would be rendered as the new conversation's first output. Marking the
// turn `finished` is not enough — that only silences turn_end.

{
  const { session, events } = makeSession({ env: { CC_FAKE_DELAY_MS: "80" } });
  session.send("lượt sẽ bị vứt bỏ");
  for (let i = 0; i < 60 && events.length < 2; i++) await sleep(50);
  check("the doomed turn was actually mid-stream when disposed", events.length >= 2,
    JSON.stringify(events.map((e) => e.type)));

  session.dispose();
  const afterDispose = events.length;
  await sleep(600); // several fixture lines' worth of delay

  check("no event escapes a disposed session", events.length === afterDispose,
    JSON.stringify(events.slice(afterDispose)));

  // The check above passes even with the `disposed` gate removed: with this
  // fake, SIGKILL lands before any further line is written, so it only proves
  // the kill works. The leak is about stdout that was ALREADY in the pipe when
  // dispose() ran — the listener is still attached and still translates it. Feed
  // exactly that, with no timing to lose, so the gate is what is under test.
  const strayLine = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "câu của lượt đã bị vứt" }] },
  });
  session.onStdout(strayLine + "\n");
  check("a line still buffered from the killed child emits nothing",
    events.length === afterDispose,
    JSON.stringify(events.slice(afterDispose)));
}

rmSync(workdir, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
