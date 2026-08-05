# Claude headless probe — findings for Task 2

Probe run 2026-08-05 against `claude` CLI 2.1.197. Full detail and the exact
commands are in `.superpowers/sdd/2026-08-05-sidepanel-chat/task-1-report.md`.

## 1. Prompt delivery form

Prompt via stdin works and is what Task 2 should use:

```bash
echo "<prompt text>" | claude -p --output-format stream-json --verbose --session-id "$SID" ...
```

One deviation from the brief's example command: `--output-format stream-json`
requires `--verbose` when combined with `-p`/`--print`, or the CLI exits 1
immediately with `Error: When using --print, --output-format=stream-json
requires --verbose`. Task 2 must always pass `--verbose` alongside
`--output-format stream-json`.

## 2. NDJSON `type` values

| `type` | `subtype` / `event.type` | Carries | Frequency (basic probe, no MCP) |
|---|---|---|---|
| `system` | `hook_started` | A configured hook (SessionStart etc.) began running. Noise from the *caller's* global `~/.claude/settings.json` hooks, not from anything the panel sends. | many, once per configured hook |
| `system` | `hook_response` | The hook's output, possibly injecting `additionalContext` into the session (e.g. Superpowers/claude-mem inject large system-prompt text here). | many, once per hook |
| `system` | `init` | Session bootstrap: `cwd`, `session_id`, `tools` (full allowed-tool list), `mcp_servers` (with `status`), `model`, `slash_commands`, `skills`, `plugins`. This is where the panel can read which MCP tools were actually granted. | 1 |
| `system` | `status` | Lightweight status ping, e.g. `"status":"requesting"`. | 1+ |
| `stream_event` | `message_start` | Only present with `--include-partial-messages`. Streaming envelope open for a new assistant message. | 1 per assistant turn |
| `stream_event` | `content_block_start` | Streaming: a new content block (text or tool_use) begins. | 1 per block |
| `stream_event` | `content_block_delta` | Streaming: incremental text/JSON delta for the current block — this is the token-by-token stream. | many |
| `stream_event` | `content_block_stop` | Streaming: current block finished. | 1 per block |
| `stream_event` | `message_delta` | Streaming: top-level message metadata update (e.g. `stop_reason`, usage). | 1 per assistant turn |
| `stream_event` | `message_stop` | Streaming: assistant message fully complete. | 1 per assistant turn |
| `assistant` | — | A **complete** assistant message (same content whether or not `--include-partial-messages` was used) — `message.content[]` holds one or more content blocks; see the block-type table below for exactly which. This is the one to render chat bubbles from; `stream_event` is only needed for live token streaming. | 1+ per turn |
| `user` | — | Synthetic user-role message carrying `tool_result` content back to the model after a tool call — not a real user turn, do not render as one. | 1 per tool call |
| `rate_limit_event` | — | Account rate-limit status snapshot (`rateLimitType`, `resetsAt`, etc.). Not conversational; can be ignored/logged. | 1+ |
| `result` | `success` (or error subtype) | Final summary of the whole `claude -p` invocation: `result` (final text), `is_error`, `duration_ms`, `total_cost_usd`, `usage`, `permission_denials`. Always the last line. | 1 |

Real one-line examples of each `type` are quoted verbatim in
`task-1-report.md` (section "NDJSON type table"), taken from the actual probe
runs (`/tmp/probe-a.ndjson`, and the committed `test/fixtures/claude-stream.ndjson`).

### `assistant.message.content[]` block types

Derived mechanically, not from memory: parsed every `assistant` line in the
committed `test/fixtures/claude-stream.ndjson` (`node -e` + `JSON.parse` per
line) and collected the distinct `content[].type` values across all of them.
The fixture has exactly 3 `assistant` lines (fixture lines 14, 15, 18), one
content block each:

| `content[].type` | Count in fixture | What it is | What the panel UI should do |
|---|---|---|---|
| `thinking` | 1 | Extended-thinking block. In this run it was `{"type":"thinking","thinking":"","signature":"Es..."}` — an **empty** `thinking` string plus an opaque `signature` (redacted/encrypted reasoning trace, not human-readable text). | Ignore for chat rendering (nothing readable to show); at most render as a collapsed "thinking…" indicator if the panel wants one. Never treat `signature` as displayable text. |
| `tool_use` | 1 | `{"type":"tool_use","id":"toolu_...","name":"mcp__chrome__chrome_status","input":{...}}` — a tool call the model is making. | Render as tool-activity UI (e.g. "Calling chrome_status…"), not as a chat bubble. Pair with the matching `tool_result` in the following `user` line via `tool_use_id`/`id`. |
| `text` | 1 | `{"type":"text","text":"..."}` — plain assistant reply text (also used for the model's final answer that echoes tool output back in prose). | Render as a normal assistant chat bubble. |

**This list is only what appeared in one committed fixture, not an exhaustive
enumeration of every block type the API can emit.** Task 2's translator must
not hard-fail on an unrecognized `content[].type` — fall back to ignoring or
generically logging it rather than throwing, since other block types (e.g.
`redacted_thinking`, `server_tool_use`) are known to exist in the wider API
surface and simply didn't happen to appear in this one probe run.

### Known CLI/environment behaviours Task 2 must handle

- **`--verbose` is mandatory.** On CLI 2.1.197, `-p`/`--print` combined with
  `--output-format stream-json` fails immediately (exit 1, no NDJSON output
  at all) unless `--verbose` is also passed. Exact stderr text:
  `Error: When using --print, --output-format=stream-json requires --verbose`.
  Task 2 must always pass `--verbose` alongside `--output-format stream-json`.
- **Global SessionStart hooks inject `system` noise.** Because the probing
  account has global hooks configured (Superpowers, claude-mem) in
  `~/.claude/settings.json`, every headless invocation emits a burst of
  `system:hook_started`/`hook_response` events and one hook injects several KB
  of `additionalContext` text into the session before the first real
  assistant turn. The panel's translator must tolerate/ignore unknown
  `system` subtypes rather than assuming `system:init` is always the first
  line — a different machine (with no such hooks, or different ones) will
  produce a different number and shape of leading `system` lines.

## 3. `--resume` context retention

Confirmed: `--resume <session-id>` across two **separate** `claude -p`
process invocations retains conversation context. Evidence:

```
$ echo "Tôi tên là Huy. Chỉ trả lời: ok" | claude -p --output-format stream-json \
    --tools "" --strict-mcp-config --verbose --session-id "$SID3" > probe-b1.ndjson
$ echo "Tôi tên gì?" | claude -p --output-format stream-json \
    --tools "" --strict-mcp-config --verbose --resume "$SID3" > probe-b2.ndjson
```

Assistant's answer in `probe-b2.ndjson` (extracted from `type=="assistant"` /
`content[].type=="text"`):

```
Huy.
```

This confirms the one-process-per-turn architecture (spawn `claude -p
--resume $SID` per user message) is viable; Task 2 does **not** need to keep
a long-lived `--input-format stream-json` process alive.

## 4. Confirmed `--allowedTools` value

The short form works — no need to enumerate all 22 tool names by hand:

```
--allowedTools "mcp__chrome"
```

Confirmed against a live bridge server (`node server/index.js --http`) with
an `--mcp-config` pointing `chrome` at `http://127.0.0.1:8787/mcp` with a
Bearer token. The model called `mcp__chrome__chrome_status` and received the
real tool result (`"connected": false, ...`), with `permission_denials: []`
in the final `result` event — i.e. it was not blocked and did not fall back
to a refusal. `system:init`'s `tools` array independently confirms all 22
`mcp__chrome__*` tools were granted under this one prefix.
