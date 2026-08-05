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
    claudeBin = "claude",
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
    this.claudeBin = claudeBin;
    this.claudeArgsPrefix = claudeArgsPrefix;
    this.env = env;
    this.onEvent = onEvent;
    this.log = log;

    this.child = null;
    this.buffer = "";
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

  // NOTE on exposure: this JSON string (Bearer token included) is passed as
  // an --mcp-config argv value, so it is visible in `ps`/`/proc/<pid>/cmdline`
  // to any other local user on the same machine as the bridge server for the
  // lifetime of the child process. That is a deliberate tradeoff carried over
  // from the probe, not an oversight — see the task-2 fix-round report for
  // the file-based-config alternative this was weighed against.
  mcpConfig() {
    return JSON.stringify({
      mcpServers: {
        chrome: {
          type: "http",
          url: this.mcpUrl,
          headers: { Authorization: `Bearer ${this.token}` },
        },
      },
    });
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
      "--mcp-config", this.mcpConfig(),
      // Every built-in tool off: this agent has no business reading or writing
      // the user's filesystem, and the browser tools all arrive over MCP.
      "--tools", "",
      "--allowedTools", this.allowedTools,
    ];
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
    this.lastStderrLine = null;
    this.emit({ type: "turn_start" });

    const child = spawn(this.claudeBin, this.buildArgs(), {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
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
      const lines = chunk.split("\n").map((line) => line.trim()).filter(Boolean);
      if (lines.length) this.lastStderrLine = lines[lines.length - 1];
    });

    child.on("error", (err) => {
      this.child = null;
      // A spawn-time failure (e.g. ENOENT on claudeBin) fires `error` and
      // Node still fires `close` afterwards for the same child — only the
      // first of the two may emit turn_end.
      if (this.finished) return;
      this.finished = true;
      this.emit({ type: "turn_end", ok: false, error: err.message });
    });

    child.on("close", (code) => {
      this.child = null;
      if (this.finished) return;
      this.finished = true;
      if (this.stopping) {
        this.emit({ type: "turn_end", ok: false, error: "đã dừng theo yêu cầu" });
      } else if (code === 0) {
        this.emit({ type: "turn_end", ok: true });
      } else {
        // The exit code alone reads the same for a dead session id, a crash, a
        // bad model name and an auth failure. The CLI's own last line is what
        // tells them apart, so it travels with the code instead of living only
        // in the server log. Passed through verbatim and unclassified on
        // purpose: deciding that "No conversation found" deserves a particular
        // button is the panel's call, and a classifier here would be a second
        // place to keep in sync with the CLI's wording.
        const cause = this.lastStderrLine;
        this.emit({
          type: "turn_end",
          ok: false,
          error: cause ? `claude thoát với mã ${code}: ${cause}` : `claude thoát với mã ${code}`,
        });
      }
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
      const delta = event.event?.delta;
      if (delta?.type === "text_delta" && delta.text) {
        this.emit({ type: "delta", text: delta.text });
      }
      return;
    }
    if (event.type === "assistant") {
      for (const block of event.message?.content || []) {
        if (block.type === "text" && block.text) {
          this.emit({ type: "message", text: block.text });
        } else if (block.type === "tool_use" && block.name) {
          this.emit({ type: "tool", name: block.name });
        }
        // Any other content block type (e.g. "thinking", or something newer
        // than this probe) carries nothing the panel renders — skip silently
        // rather than throw, since Anthropic's block-type surface is larger
        // than what one fixture happened to exercise.
      }
      return;
    }
    // "system" (session bootstrap and this machine's SessionStart hook noise),
    // "user" (tool results fed back to the model), "rate_limit_event" and
    // "result" carry nothing the panel renders — the final text already
    // arrived as an assistant message. Any unrecognised top-level type is
    // ignored the same way rather than throwing.
  }

  stop() {
    if (!this.child) return false;
    this.stopping = true;
    this.child.kill("SIGTERM");
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
    if (this.child) this.child.kill("SIGKILL");
    this.child = null;
  }
}
