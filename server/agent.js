// One AgentSession per side panel. Each chat turn spawns a fresh `claude -p`
// child; the child exits when the turn ends, and the next turn resumes the same
// Claude session by id.
//
// One process per turn rather than one long-lived process on purpose: --resume
// is a documented flag, whereas driving a live child would mean writing to a
// stdin control protocol that is not. It also makes the stop button trivially
// correct — killing the child is the whole implementation.
//
// The Claude session id is stable for the panel's lifetime, so history survives
// across turns even though the process does not.

import { spawn } from "node:child_process";
import { writeFileSync, chmodSync, existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// cmd.exe quoting, kept to the one rule actually needed here: wrap in double
// quotes, escape any double quote inside. Everything this quotes is
// repo-controlled — flags, absolute paths, a UUID-validated session id — and
// the chat prompt never reaches argv at all (it goes over stdin), so this does
// not have to survive hostile input, only spaces in %USERPROFILE%.
export function winQuote(s) {
  return /^[A-Za-z0-9_\-.:\\/=]+$/.test(String(s)) ? String(s) : `"${String(s).replace(/"/g, '\\"')}"`;
}

// Node >= 18.20/20.12 refuses to spawn a .cmd without a shell (the fix for
// CVE-2024-27980), and on Windows `claude` IS claude.cmd — so the panel's very
// first turn died with ENOENT there. shell:true is only safe because
// mcpConfigPath() moved the one argument containing JSON quotes out of argv
// and into a file; cmd.exe treats `"` as a quoting toggle and would have
// shredded it.
//
// Takes the platform as an argument so both branches are testable from any
// machine, which is the only reason the Windows branch has coverage at all.
export function buildSpawn(bin, args, platform = process.platform) {
  if (platform !== "win32") {
    return { command: bin, args, options: { shell: false } };
  }
  // The COMMAND is quoted too, not just the args: shell:true makes Node join
  // them into one cmd.exe command line, so an unquoted path with a space
  // (C:\Users\Huy Tran\...\claude.cmd, or anything under a %TEMP% that contains
  // one) would be split and reported as "not recognized as an internal or
  // external command".
  return {
    command: winQuote(bin),
    args: args.map(winQuote),
    options: { shell: true, windowsHide: true },
  };
}

// A background service does not inherit an interactive shell's PATH. Measured
// on macOS: launchd hands this process PATH=/usr/bin:/bin:/usr/sbin:/sbin while
// claude lives at /opt/homebrew/bin/claude, so every panel chat turn died with
// "spawn claude ENOENT" the moment the bridge ran as the installed service —
// which is the only way it is meant to run. systemd --user and Task Scheduler
// give the same treatment.
//
// The installers resolve `claude` once, at install time, and bake the absolute
// path into the unit as CC_CHROME_CLAUDE_BIN — exactly what service-unit.sh
// already did for `node`, and for the same reason. The bare-name fallback is
// what a developer running the bridge by hand in a terminal gets, where PATH is
// real.
export function claudeBinFromEnv() {
  return process.env.CC_CHROME_CLAUDE_BIN || "claude";
}

// Hook events the panel forwards from the user's own settings, and the two it
// deliberately drops.
//
// The panel spawns a fresh `claude` per TURN, not per conversation, so a
// SessionStart hook would fire on every single message — and for a usage
// tracker like token-slayer that means one bogus "session" per line the user
// types. SessionEnd is dropped for the same reason. Everything else fires at
// the same rhythm it does in a terminal.
//
// Measured, not assumed: hooks DO run under `claude -p`, `--settings <file>`
// composes with `--setting-sources project`, and the Stop payload carries a
// readable transcript_path — which is what a usage tracker reads to count the
// turn's output tokens. So dropping SessionStart costs no usage data.
const PANEL_HOOK_EVENTS = [
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SubagentStop",
  "Notification",
];

// Only `hooks`, never `enabledPlugins`. Plugins are the reason
// --setting-sources project exists: a plugin's SessionStart hook injected
// cross-project memory into every spawned child, which made "Phiên mới" look
// broken. Copying the hooks the user declared themselves gives each member
// their own tooling — token trackers, notifiers — without reopening that door,
// and without anyone having to hand-place a file on their machine.
export function panelHooksFrom(userSettings) {
  const hooks = userSettings?.hooks;
  if (!hooks || typeof hooks !== "object") return null;
  const kept = {};
  for (const event of PANEL_HOOK_EVENTS) {
    if (Array.isArray(hooks[event]) && hooks[event].length) kept[event] = hooks[event];
  }
  return Object.keys(kept).length ? { hooks: kept } : null;
}

// A tool result can be hundreds of KB of page text. The panel puts what it
// receives into the DOM and keeps it in its journal, so the cut happens here,
// before it crosses the socket — not in the browser.
export const STEP_SUMMARY_MAX = 800;
// A failure is the one case the user actually has to read, so it gets more room.
export const STEP_ERROR_SUMMARY_MAX = 2000;
export const STEP_INPUT_MAX = 2000;

// `tool_result.content` has two shapes, both measured on 2026-08-15 against CLI
// 2.1.197: a plain string for built-in tools, and an array of content blocks for
// MCP tools — which is every tool this panel actually uses. Missing the array
// case renders "[object Object]" for every chrome tool.
export function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === "string" ? block : block?.text ?? ""))
      .join("\n");
  }
  if (content == null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return "";
  }
}

export function summarizeResult(text, ok) {
  const max = ok ? STEP_SUMMARY_MAX : STEP_ERROR_SUMMARY_MAX;
  return {
    // The real size travels separately so the panel can say "12.4KB" even
    // though only the first slice of it arrived.
    summary: text.length > max ? `${text.slice(0, max)}…` : text,
    size: Buffer.byteLength(text, "utf8"),
  };
}

// Kept as an object rather than a pre-rendered string: the panel reads
// well-known keys (url, query, ref…) to build the one-line subtitle under a
// step. Only when the whole thing is too big does it degrade to a flat preview.
export function clipInput(input) {
  let json;
  try {
    json = JSON.stringify(input ?? {});
  } catch {
    return { __truncated: true, __preview: "" };
  }
  if (json === undefined) return {};
  if (json.length <= STEP_INPUT_MAX) return input ?? {};
  return { __truncated: true, __preview: json.slice(0, STEP_INPUT_MAX) };
}

export class AgentSession {
  constructor({
    sessionId,
    model = null,
    token,
    mcpUrl,
    allowedTools,
    cwd,
    systemPrompt = null,
    // True when sessionId names a conversation the CLI already has on disk, so
    // the very first turn must --resume instead of --session-id. A panel that
    // reopens and replays a remembered id is exactly this case.
    resuming = false,
    // Panel protocol version, replayed by the panel in `start`. 1 = the
    // pre-timeline panel, which only understands `tool`. Anything ≥ 2 gets the
    // step events instead. A bridge is upgraded independently of the extension,
    // so both have to keep working.
    protocol = 1,
    claudeBin = "claude",
    // Overridable so a test can point at a fixture instead of whatever the
    // machine running the suite happens to have configured.
    userSettingsPath = join(homedir(), ".claude", "settings.json"),
    claudeArgsPrefix = [],
    env = {},
    onEvent,
    log = () => {},
  }) {
    this.sessionId = sessionId;
    this.model = model;
    this.token = token;
    this.mcpUrl = mcpUrl;
    this.allowedTools = allowedTools;
    this.cwd = cwd;
    this.systemPrompt = systemPrompt;
    this.protocol = protocol;
    this.claudeBin = claudeBin;
    this.userSettingsPath = userSettingsPath;
    this.claudeArgsPrefix = claudeArgsPrefix;
    this.env = env;
    this.onEvent = onEvent;
    this.log = log;

    this.child = null;
    this.buffer = "";
    // tool_use_id -> { name, t0 }. The only thing that can pair "Claude called
    // read_page" with "read_page came back", because those arrive as two
    // unrelated top-level lines several seconds apart.
    this.steps = new Map();
    // Last phase reported to the panel, so a transition is emitted once rather
    // than on every delta.
    this.phase = null;
    // A turn that has already started must --resume; the very first one has no
    // conversation to resume into and would fail. A caller that hands over an
    // id from an earlier panel seeds this true, because for that id the
    // conversation does exist and --session-id would be rejected as taken.
    this.started = resuming;
    this.stopping = false;
    // Node fires both `error` and `close` for a spawn that fails outright
    // (e.g. ENOENT on claudeBin) — this guard makes sure only the first of
    // the two exit paths for a turn emits its turn_end, so callers never see
    // two end-of-turn events for one send().
    this.finished = false;
    // SIGKILL is asynchronous and the stdout listener stays attached, so a
    // killed child's already-buffered lines still arrive and still translate.
    // On the start-while-busy path the panel socket is very much open — it just
    // received `ready` — so an ungated late delta would be rendered as the new
    // conversation's first words. Nothing may leave a disposed session.
    this.disposed = false;
  }

  get busy() {
    return this.child !== null;
  }

  emit(event) {
    if (this.disposed) return;
    this.onEvent(event);
  }

  setPhase(phase) {
    if (this.phase === phase) return;
    this.phase = phase;
    if (phase) this.emit({ type: "phase", phase });
  }

  startStep(id, name) {
    if (!id || this.steps.has(id)) return;
    this.steps.set(id, { name, t0: performance.now() });
    // A running step outranks any phase in the panel's status bar. Clearing it
    // also matters for the NEXT transition: the CLI sends status:requesting
    // again for the following API round trip, and setPhase only emits on change.
    this.phase = null;
    this.emit({ type: "step_start", id, name });
  }

  endStep(block) {
    const id = block.tool_use_id;
    if (!id) return;
    // Never a step_end the panel has no row for. If content_block_start never
    // arrived — a CLI run without --include-partial-messages, or a future format
    // change — open the step here so every pair is complete. The panel keys its
    // rows by id; an unmatched step_end would vanish with no error.
    if (!this.steps.has(id)) this.startStep(id, block.name || "tool");
    const started = this.steps.get(id);
    this.steps.delete(id);
    const ok = block.is_error !== true;
    const { summary, size } = summarizeResult(toolResultText(block.content), ok);
    this.emit({
      type: "step_end",
      id,
      ok,
      ms: Math.round(performance.now() - started.t0),
      summary,
      size,
    });
  }

  // Every way a turn can end goes through here. A step whose tool_result never
  // arrives — stop button, crashed child, killed process — still closes, so the
  // panel never spins a row forever. That symptom is the whole reason this
  // feature exists; leaving one behind here would recreate it.
  endTurn(payload) {
    for (const [id, step] of this.steps) {
      this.emit({
        type: "step_end",
        id,
        ok: false,
        aborted: true,
        ms: Math.round(performance.now() - step.t0),
        summary: "",
        size: 0,
      });
    }
    this.steps.clear();
    this.phase = null;
    this.emit({ type: "turn_end", ...payload });
  }

  // Written to a file rather than passed inline as JSON. Two reasons, both
  // real: cmd.exe re-parses double quotes when spawning through a shell (which
  // Windows needs — see buildSpawn), and the inline form put the bridge's
  // Bearer token in the child's argv, readable via `ps` / Task Manager by any
  // other local user for the child's lifetime. A 0600 file in the session's
  // own cwd has neither problem.
  //
  // Written once per session and reused: `claude` reads it at startup on every
  // turn, so it has to outlive the first child.
  mcpConfigPath() {
    if (this._mcpConfigPath) return this._mcpConfigPath;
    const file = join(this.cwd, `.mcp-config-${this.sessionId || "panel"}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          chrome: {
            type: "http",
            url: this.mcpUrl,
            headers: { Authorization: `Bearer ${this.token}` },
          },
        },
      }),
      { mode: 0o600 },
    );
    // `mode` only applies when the file is CREATED. A file left by an earlier
    // run keeps whatever mode it had, so repair it unconditionally — the same
    // reason install.sh chmods on every run. Skipped on Windows, where POSIX
    // modes mean nothing and install.ps1's icacls on the install dir is what
    // restricts access.
    if (process.platform !== "win32") chmodSync(file, 0o600);
    this._mcpConfigPath = file;
    return file;
  }

  // Read at spawn time rather than at install time, so a user who edits their
  // hooks gets them on the next message instead of after reinstalling.
  panelSettingsPath() {
    let parsed = null;
    try {
      parsed = JSON.parse(readFileSync(this.userSettingsPath, "utf8"));
    } catch {
      return null; // no user settings, or unreadable/malformed — not an error here
    }
    const settings = panelHooksFrom(parsed);
    if (!settings) return null;
    const file = join(this.cwd, `.panel-settings-${this.sessionId || "panel"}.json`);
    writeFileSync(file, JSON.stringify(settings), { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(file, 0o600);
    this._panelSettingsPath = file;
    return file;
  }

  buildArgs() {
    const args = [
      ...this.claudeArgsPrefix,
      "-p",
      "--output-format", "stream-json",
      // -p combined with --output-format stream-json is rejected outright
      // without --verbose ("Error: When using --print, --output-format=
      // stream-json requires --verbose") — confirmed against CLI 2.1.197.
      "--verbose",
      "--include-partial-messages",
      "--strict-mcp-config",
      // User-level settings (~/.claude/settings.json) can carry `enabledPlugins`
      // whose `SessionStart` hooks inject cross-project memory (or anything
      // else) into every spawned child — including this one, on a "fresh"
      // session, which made "Phiên mới" look broken: the log cleared but the
      // model still recalled unrelated prior work from other projects. This
      // agent must start genuinely blank every time, the way the original
      // Claude for Chrome extension is fully ephemeral between sessions. Do
      // not remove this thinking it's redundant with --strict-mcp-config —
      // that flag only pins the *MCP* config; it does nothing about plugins,
      // hooks, or any other user-level setting.
      "--setting-sources", "project",
      "--mcp-config", this.mcpConfigPath(),
      // Every built-in tool off: this agent has no business reading or writing
      // the user's filesystem, and the browser tools all arrive over MCP.
      "--tools", "",
      "--allowedTools", this.allowedTools,
    ];
    const panelSettings = this.panelSettingsPath();
    if (panelSettings) args.push("--settings", panelSettings);
    if (this.model) args.push("--model", this.model);
    if (this.systemPrompt) args.push("--append-system-prompt", this.systemPrompt);
    if (this.started) args.push("--resume", this.sessionId);
    else args.push("--session-id", this.sessionId);
    return args;
  }

  send(text) {
    if (this.child) throw new Error("A turn is already running; stop it first.");
    this.stopping = false;
    this.finished = false;
    this.buffer = "";
    this.steps.clear();
    this.phase = null;
    this.lastStderrLine = null;
    this.emit({ type: "turn_start" });

    // Checked before spawning, not left to the spawn's own error. A missing
    // binary only reports ENOENT when Node launches it directly; on Windows
    // buildSpawn goes through cmd.exe, which swallows that into exit code 1
    // and "The system cannot find the path specified" — so the actionable
    // message below would never have appeared on the one platform that needs
    // it most. CI caught this on windows-latest.
    //
    // Only applies to a path-shaped claudeBin, which is what the installers
    // bake in (CC_CHROME_CLAUDE_BIN). A bare "claude" still has to be resolved
    // through PATH by the OS, and its ENOENT is handled in the error listener.
    if (/[\\/]/.test(this.claudeBin) && !existsSync(this.claudeBin)) {
      this.finished = true;
      this.endTurn({ ok: false, error: this.missingClaudeMessage() });
      return;
    }

    const { command, args, options } = buildSpawn(this.claudeBin, this.buildArgs());
    const child = spawn(command, args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
      ...options,
    });
    this.child = child;
    this.started = true;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      // The full trace belongs in the server log, as before.
      this.log("[claude stderr]", chunk.trimEnd());
      // Only the last non-empty line is kept for the panel. It is the one that
      // names the cause ("No conversation found with session ID: …"), and the
      // panel is a narrow column — the rest would be unreadable there anyway.
      // Capped: this line is JSON-stringified onto the panel socket and put in
      // the DOM, and nothing bounds what a child writes to stderr — a stack
      // trace or a dumped config would otherwise travel in full.
      const lines = chunk.split("\n").map((line) => line.trim()).filter(Boolean);
      if (lines.length) this.lastStderrLine = lines[lines.length - 1].slice(0, 500);
    });

    child.on("error", (err) => {
      this.child = null;
      // A spawn-time failure (e.g. ENOENT on claudeBin) fires `error` and
      // Node still fires `close` afterwards for the same child — only the
      // first of the two may emit turn_end.
      if (this.finished) return;
      this.finished = true;
      // ENOENT here has one cause and one fix, and "spawn claude ENOENT" names
      // neither. This message is what the user reads in the panel's chat log,
      // so it says which command is missing and what to do about it — the
      // installer is what bakes the absolute path in (CC_CHROME_CLAUDE_BIN),
      // so re-running it is the fix after installing or moving the CLI.
      const message = err.code === "ENOENT" ? this.missingClaudeMessage() : err.message;
      this.endTurn({ ok: false, error: message });
    });

    child.on("close", (code) => {
      this.child = null;
      if (this.finished) return;
      this.finished = true;
      if (this.stopping) {
        this.endTurn({ ok: false, error: "đã dừng theo yêu cầu" });
      } else if (code === 0) {
        this.endTurn({ ok: true });
      } else {
        // The exit code alone reads the same for a dead session id, a crash, a
        // bad model name and an auth failure. The CLI's own last line is what
        // tells them apart, so it travels with the code instead of living only
        // in the server log. Passed through verbatim and unclassified on
        // purpose: deciding that "No conversation found" deserves a particular
        // button is the panel's call, and a classifier here would be a second
        // place to keep in sync with the CLI's wording.
        const cause = this.lastStderrLine;
        this.endTurn({
          ok: false,
          error: cause ? `claude thoát với mã ${code}: ${cause}` : `claude thoát với mã ${code}`,
        });
      }
    });

    // A prompt bigger than the OS pipe buffer (64KB on Linux, less on macOS)
    // cannot be handed over in one write, so the tail of it is still queued when
    // the child exits — and a child that fails immediately (`--resume` on a
    // session id the CLI no longer has exits 1 before reading a byte) leaves
    // that write hitting a closed pipe. Node raises EPIPE on the stdin socket,
    // and with no `error` listener an EventEmitter error is thrown: the whole
    // bridge process dies, taking every MCP session with it — for a paste into
    // a reopened panel, which is the documented common path. The turn's real
    // outcome is reported by `close` (with the child's own stderr line), so all
    // this listener has to do is keep the failed write from being fatal.
    child.stdin.on("error", (err) => {
      this.log("[claude stdin]", err.message);
    });
    child.stdin.write(text);
    child.stdin.end();
  }

  onStdout(chunk) {
    this.buffer += chunk;
    // NDJSON: one JSON object per line, and a chunk boundary can land anywhere,
    // so the tail is kept until its newline arrives.
    let index;
    while ((index = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        // A malformed line is not worth killing the turn over; the transcript is
        // the CLI's to define and an unknown shape may simply be newer than us.
        this.log("[claude] unparseable stdout line:", line.slice(0, 200));
        continue;
      }
      this.translate(event);
    }
  }

  translate(event) {
    if (event.type === "stream_event") {
      const inner = event.event;
      // The earliest moment the tool is knowable: id and name arrive here,
      // before the arguments have finished streaming. Measured 2026-08-15.
      if (inner?.type === "content_block_start" && inner.content_block?.type === "tool_use") {
        this.startStep(inner.content_block.id, inner.content_block.name);
        return;
      }
      const delta = inner?.delta;
      if (delta?.type === "text_delta" && delta.text) {
        this.setPhase("answering");
        this.emit({ type: "delta", text: delta.text });
        return;
      }
      if (delta?.type === "thinking_delta") {
        // The `thinking` field is ALWAYS the empty string on CLI 2.1.197 —
        // measured twice, ultrathink included. The only information here is
        // that thinking is happening at all, so that is all that is reported.
        this.setPhase("thinking");
      }
      return;
    }
    if (event.type === "system" && event.subtype === "status" && event.status === "requesting") {
      this.setPhase("requesting");
      return;
    }
    if (event.type === "assistant") {
      for (const block of event.message?.content || []) {
        if (block.type === "text" && block.text) {
          this.emit({ type: "message", text: block.text });
        } else if (block.type === "tool_use" && block.name) {
          // Idempotent: content_block_start has usually opened this step
          // already. When partial messages are off, this is where it opens.
          this.startStep(block.id, block.name);
          this.emit({ type: "step_args", id: block.id, input: clipInput(block.input) });
          // A panel that predates the timeline only understands this one.
          if (this.protocol < 2) this.emit({ type: "tool", name: block.name });
        }
        // A "thinking" block carries no text (see translate's thinking_delta
        // branch); anything newer than this probe is skipped rather than thrown
        // on, since Anthropic's block-type surface is larger than one fixture.
      }
      return;
    }
    if (event.type === "user") {
      // Tool results come back as a `user` message. This is the ONLY line that
      // says a tool finished, and dropping it is why the panel used to go quiet.
      for (const block of event.message?.content || []) {
        if (block.type === "tool_result") this.endStep(block);
      }
      return;
    }
    if (event.type === "result") {
      this.emit({
        type: "turn_stats",
        ms: event.duration_ms ?? null,
        costUsd: event.total_cost_usd ?? null,
        inputTokens: event.usage?.input_tokens ?? null,
        outputTokens: event.usage?.output_tokens ?? null,
      });
      return;
    }
    // "rate_limit_event", the other "system" subtypes (hook noise, init) and
    // any unrecognised top-level type carry nothing the panel renders.
  }

  // One wording, two callers: the pre-flight check in send() and the spawn
  // error listener. It is what the user reads in the panel's chat log, so it
  // names the command, says why PATH is not the answer, and gives the fix.
  missingClaudeMessage() {
    return (
      `Không chạy được lệnh 'claude' (${this.claudeBin}). Dịch vụ nền không dùng PATH của terminal, ` +
      "nên nó cần đường dẫn tuyệt đối do script cài ghi vào. Cài Claude Code rồi chạy lại lệnh cài " +
      "đặt bridge để ghi lại đường dẫn."
    );
  }

  // Kills the child AND anything it started. On Windows the child is cmd.exe
  // (buildSpawn has to go through a shell so PATHEXT finds claude.cmd), so
  // `claude` is a GRANDchild: child.kill() takes down the shell and leaves the
  // CLI running, the turn never ends, and the panel's stop button does nothing.
  // CI caught exactly that — "not busy after stop" failed on windows-latest and
  // passed everywhere else. taskkill /T is the tree kill; /F because a console
  // app ignores the polite request.
  killChild(signal) {
    if (!this.child) return;
    if (process.platform === "win32" && this.child.pid) {
      // Fire-and-forget: the `close` handler is what actually finishes the
      // turn, and a failure here (child already gone) must not throw into the
      // caller. detached+unref so this helper cannot outlive the server.
      try {
        const killer = spawn("taskkill", ["/pid", String(this.child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.on("error", () => {});
        killer.unref();
      } catch {
        this.child.kill(signal);
      }
      return;
    }
    this.child.kill(signal);
  }

  stop() {
    if (!this.child) return false;
    this.stopping = true;
    this.killChild("SIGTERM");
    return true;
  }

  dispose() {
    this.stopping = true;
    // Mark this turn finished up front: SIGKILL is asynchronous, so the
    // `close` handler still fires after this returns, and it must not emit
    // a turn_end into a session the caller has already torn down.
    this.finished = true;
    // `finished` only silences turn_end. Buffered stdout keeps arriving and
    // still translates into delta/message/tool events, which on the
    // start-while-busy path would land in the *new* conversation.
    this.disposed = true;
    this.killChild("SIGKILL");
    this.child = null;
    // The config carries the bridge's Bearer token, so it should not outlive
    // the session that needed it. Nothing else pruned these: PANEL_CWD had
    // accumulated one .mcp-config-<id>.json per panel session — 40 of them
    // after a few days — and uninstall deliberately preserves that directory,
    // so they survived it too. Best effort by design: a bridge killed outright
    // never runs this, which is what the sweep in uninstall.sh is for.
    for (const key of ["_mcpConfigPath", "_panelSettingsPath"]) {
      if (!this[key]) continue;
      try { rmSync(this[key], { force: true }); } catch { /* already gone */ }
      this[key] = null;
    }
  }
}
