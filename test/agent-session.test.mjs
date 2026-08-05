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

rmSync(workdir, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
