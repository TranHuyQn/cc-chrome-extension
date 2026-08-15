# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP server (`server/`) + Chrome MV3 extension (`extension/`) that lets Claude Code drive Chrome
without any claude.ai login. Every MCP tool call is forwarded over WebSocket to the extension, which
executes it with `chrome.tabs` / `chrome.scripting` / `chrome.debugger` and returns JSON.

One runtime mode: `mainHttp()` in `server/index.js` runs an HTTP + WebSocket server, bound to
`127.0.0.1` by default (port `8787`), that every Claude Code session and the extension both talk to.
There is no `mainStdio()` — stdio mode (single process on stdout, no auth) was removed before 1.0.0. The
distribution model changed with it: `scripts/install.sh` installs a per-user background service (see
"Setup and commands" below) instead of everyone pointing at one shared server. The shared-server shape
is **gone**, not deprecated — `deploy/`, the Cloudflare tunnel doc, `POST /pair` and every dynamic
token went with it in 1.0.0. `TokenStore` now only reads tokens configured up front, which for a normal
install is the one token `install.sh` writes to `tokens.json`.

## Setup and commands

Three separate `package.json` files — installing at the root is **not** enough:

```bash
npm install              # root: build tooling only (adm-zip, crx)
cd server && npm install # MCP server runtime deps (@modelcontextprotocol/sdk, ws, zod)
cd test && npm install   # e2e deps (playwright)
```

```bash
npm run build       # package extension -> dist/*.zip + signed dist/*.crx
npm run lint        # eslint (flat config in eslint.config.mjs); must stay at 0 errors
npm test            # build.test + origin.test + e2e + e2e-http — needs real Chromium
npm run test:e2e    # a single suite: also test:build, test:origin, test:http
```

Tests launch a real Chromium with the extension loaded. All four files under `test/` read
`CHROME_PATH` for the browser binary (falls back to Playwright's own managed Chromium when unset)
and `HEADED=1` to run with a visible window instead of headless:

```bash
HEADED=1 CHROME_PATH="/path/to/chrome" npm test
```

**On macOS, browser tests need `HEADED=1`** — the extension's service worker never appears in
headless mode. **Also on macOS, leave `CHROME_PATH` unset** — installed Google Chrome ≥137 has
removed the `--load-extension`/`--disable-extensions-except` command-line flags for the branded
stable channel (a Google anti-malware change), so it silently fails to load the unpacked extension
at all, headed or headless. Playwright's own managed Chromium (branded "Chrome for Testing", not
the stable Google Chrome channel) still honors those flags, so the working combination on this
platform is `HEADED=1` with no `CHROME_PATH` — that runs Playwright's bundled browser with a
visible window.

`scripts/install.sh` is the end-user installer referenced above under "What this is" (not needed for
developing or testing this repo — `npm test` starts and stops its own server instances directly): it
installs a per-user background service via `scripts/service-unit.sh` (LaunchAgent on macOS,
`systemd --user` on Linux) and registers the MCP server with Claude Code over `--transport http`.
`scripts/install.ps1` is the Windows counterpart, backed by `scripts/service-task.ps1`, which
registers a Task Scheduler task triggered at logon. All three are the same model — a per-user job
that starts when the user logs in — and Windows is deliberately NOT a Windows Service: that would run
in session 0 with no user profile, leaving the side panel's spawned `claude` with no logged-in
account, and it would need administrator rights. No installer here ever requires elevation.

Platform coverage is asymmetric and it matters when reading a green run: `test/install.test.mjs`
drives bash and shadows `uname`/`systemctl` to exercise the Linux branch from any machine, while
`test/install-windows.test.mjs` **skips with exit 0 off Windows**. A green `npm test` on macOS has
therefore never executed a line of the `.ps1` files. `.github/workflows/ci.yml` is what does —
including a `powershell-syntax` job, because a syntax error in a `.ps1` would otherwise be invisible
on a machine with no `pwsh`.

Even a green CI is not the same as a real install, and three separate Windows-only defects proved it:
the documented `irm ... | iex` could never have worked (CI invokes the script with `-File`), the
release tarball carried a symlink Windows' `tar.exe` cannot create (CI installs from a checkout via
`CC_CHROME_SOURCE`, never through the download path), and a first install died on `claude mcp remove`
returning non-zero (CI had no `claude` on PATH, so the whole block was skipped). Each gap is now
covered. The full Windows flow — install without elevation, extension connected, browser tools, side
panel chat — has since been run on real hardware; reboot survival and uninstall have not.
`npm run build:release` (`scripts/build-release.mjs`) is what packages a release for GitHub — see
"Publishing a GitHub Release" below.

There is no formatter or bundler, and the extension is plain JS loaded directly by Chrome — never
introduce a build step for `extension/` without being asked. A `PostToolUse` hook in
`.claude/settings.json` lints every `.js`/`.mjs` file right after it is written; fix what it reports
before moving on.

## Adding or changing a browser tool

A tool exists in **two** places and the method name must match exactly:

1. `server/index.js` — `tool(name, description, zodSchema, handler)` inside `buildMcpServer()`; the
   handler calls `call("<method>", args)`.
2. `extension/background.js` — an entry with the same key in the `handlers` object.

Then add a `client.callTool("<name>", …)` assertion in `test/e2e.mjs` and a row in the README tool
table. Errors thrown in either place surface as `isError` MCP results, not session crashes — throw
`Error` with a message that tells Claude what to do next (see the "stale ref" and "browser-internal
page" messages for the tone).

A new handler in `extension/background.js` must get its tab through `resolveTab(params)` (see
"Security invariants" below) instead of calling `chrome.tabs.get`/`query` itself. `resolveTab` is a
thin wrapper around `resolveTabInGroup`, which is the one place the in-group restriction is
enforced — skipping it silently reopens a hole `close_tab` and `switch_tab` once had.

`resolveTab()` also paints the orange "Claude is driving this tab" frame, so a handler that
uses it gets the indicator for free and must not paint one itself. The frame removes itself
~30s later from a timer held in the page — never move that timer into the service worker,
Chrome terminates the worker mid-sequence and a ghost frame would survive on the user's page.
A handler that captures pixels must call `await clearBorder(tab.id)` before the capture and
`paintBorder(tab.id)` in a `finally`, the way `take_screenshot` does.

**No handler may take focus.** A handler must never pass `active: true` to `chrome.tabs.update`
or `focused: true` to `chrome.windows.update`, and must never send `state: "normal"` to a window
that is not actually minimized — that field alone raises a window even as a same-value
transition. The one narrow exception is `switch_tab`, which may activate its own target tab
inside that tab's window and may still not raise the window. This is the property the owner
cares about most: the original Claude in Chrome extension activates the tab and raises the
window on essentially every tool call (anthropics/claude-code#39696, #39707, #31119), and this
project deliberately does not. `test/focus.test.mjs` ends with a sweep that calls **every**
handler and asserts both halves — the arguments actually passed to those two APIs (deterministic
everywhere) and the owner's active tab (observable). The sweep reads `Object.keys(handlers)`
live, so a new handler that is not listed in it fails the suite rather than being silently
uncovered. Three separate cases in that file failed this rule at some point — `take_screenshot`,
`resize_window` and `switch_tab` — so the sweep exists precisely because reading the handlers
by hand missed it three times.

## Injected page functions

`pageReadPage`, `pageClick`, `pageFill`, `pageFind`, `pageGetText`, `pageScroll`, `pageWaitCheck` in
`extension/background.js` are serialized and injected into the page by `chrome.scripting.executeScript`.
They run in a different realm, so:

- No closures. They may not reference anything outside their own body — inline every helper.
- Never let one throw: `chrome.scripting` swallows exceptions and returns `undefined`. Wrap the body
  in `try/catch` and `return { __cc_err: e.message }` — `execInTab()` converts that into a real error.
- Element refs live on `window.__cc_refs`, rebuilt by `read_page`/`find`. They go stale on navigation
  or DOM replacement; that is expected, the fix is to call `read_page` again.

## Versions and signing key

- Three files carry the version and must agree: `extension/manifest.json` `version` (names the build
  artifacts), `VERSION` in `server/index.js` (reported by `chrome_status`), and `server/package.json`
  `version`. Bump all three when releasing — `test/build.test.mjs` fails if any of them drifts.
  `server/package-lock.json` records the version too; refresh it with
  `npm install --package-lock-only` inside `server/`.
- `key.pem` (gitignored, generated on first `npm run build`) determines the Chrome extension ID.
  Never delete or regenerate it — a new key changes the ID and breaks everyone's installed extension
  and any enterprise allowlist.

## Publishing a GitHub Release

`npm run build:release` (`scripts/build-release.mjs`) writes exactly three things to `dist/`:
`cc-chrome-bridge.tar.gz` (the full install payload — `server/`, `extension/`, `node_modules`,
`uninstall.sh`, `service-unit.sh`, `uninstall.ps1`, `service-task.ps1`, `ccchrome.md`) and,
standalone, `install.sh` and `install.ps1`. **All three must be uploaded as release assets**, not
just the tarball — each documented one-line install fetches its own script first, before the tarball
that script then pulls at `CC_CHROME_RELEASE_URL`:
`curl -fsSL .../releases/latest/download/install.sh | bash` and
`irm .../releases/latest/download/install.ps1 | iex`, both in `README.md` and
`.claude/commands/ccchrome.md`. A missing standalone asset makes its command 404 silently, and the
Windows user sees literally nothing happen. No CI workflow does this upload, so it is a manual step
on every release: run `npm run build:release`, then attach `dist/cc-chrome-bridge.tar.gz`,
`dist/install.sh` and `dist/install.ps1` to the GitHub Release. `test/build.test.mjs` asserts both
standalone copies exist and are byte-identical to their sources, but nothing can assert that a human
attached them.

## Security invariants — do not relax without being asked

- The bridge requires `Origin: chrome-extension://…` on the WebSocket handshake.
  An absent Origin is a rejection, not a pass. It blocks browser-originated
  cross-origin connections and raises the bar against casual local clients, but
  `Origin` is client-supplied and a purpose-built local process forges it in one
  line — `test/e2e-http.mjs` does exactly that on purpose. Never document it as
  something stronger than that; the README's "Lưu ý bảo mật" section is the
  wording that must stay honest. `CC_CHROME_EXTENSION_ID` narrows this (signed
  `.crx` installs only — Load-unpacked ids are path-derived and per-machine) but
  does not close it.
- The http-mode token travels in `Sec-WebSocket-Protocol` (`ccchrome.token.<t>`),
  never in the query string, because reverse proxies log the full URI. The
  server must echo the selected subprotocol via `handleProtocols` or browsers
  fail the handshake with no usable error.
- Refusals complete the handshake and close with a code (4001 bad token, 4002
  missing subprotocol, 4003 bad origin) so the extension can explain itself.
  Destroying the socket reaches the browser as an indistinguishable 1006.
  Consequence for `extension/background.js`: the `open` event fires for refusals
  too, so it must never reset the reconnect backoff or flip the badge to
  `connected` — only the first message actually received from the server proves
  a socket. Refusal codes jump the backoff straight to `RECONNECT_MAX_MS`.
- Tokens are ≥ 8 chars; the server exits rather than run with a weaker one.
  There is no way to mint a token at runtime — no `/pair`, no dynamic store —
  so the only credentials that exist are the ones already in `tokens.json` or
  `CC_CHROME_TOKENS`.
- Every tool reaches its tab through `resolveTab(params)` in `extension/background.js`, which calls
  `resolveTabInGroup(params)` — that is the **only** place the in-group restriction is enforced: a
  tab id outside the caller's session group is refused, and a call with no tab id resolves to (or
  opens) a tab inside that group instead of whatever tab the user has active. A new or edited
  handler must call `resolveTab()` and must never call `chrome.tabs.query`/`get`/`remove`/`update`
  on a caller-supplied tab id directly — before
  tab-group isolation landed, `close_tab` and `switch_tab` did exactly that, which meant either tool could close or focus
  *any* tab in the browser, not just the caller's own. That bypass is why the rule exists now.
- The side panel gets its own `/panel` websocket rather than sharing `/ws`,
  because `registry.attach()` closes the previous connection on token collision
  and the panel would evict the service worker's bridge. It reuses the same
  origin check, the same `Sec-WebSocket-Protocol` token, and the same refusal
  codes, plus 4004 of its own. `/panel` and the `AgentSession` spawn behind it
  exist **only** when nobody but this machine can reach the bridge, and that is
  three conditions, not one (`panelRefusalReason()` in `server/index.js`, backed
  by `server/loopback.js`): `HOST` is loopback, **and** `req.socket.remoteAddress`
  is loopback (IPv4-mapped `::ffff:127.0.0.1` included), **and** the upgrade
  carries no `X-Forwarded-For`/`-Proto`/`-Host`. A `HOST`-only check is not
  enough, and the counterexample is concrete even though this repo no longer
  ships that deployment: a bridge set to `CC_CHROME_HOST=127.0.0.1` *because* a
  TLS reverse proxy sits in front of it would be declared private by a
  bind-address gate, letting anyone with a token spawn `claude` on that host
  under its logged-in account. A proxy's own
  peer address is loopback too, which is why the forwarded headers are checked
  by presence. Deliberately **not** overridable by an env var — a switch that
  re-enables this is a switch someone will flip. `/ws` is unaffected: the
  extension bridge is *meant* to work through a proxy.
- The panel's MCP Bearer token reaches the spawned `claude` child through a
  **file**, not argv: `AgentSession.mcpConfigPath()` in `server/agent.js`
  writes `.mcp-config-<sessionId>.json` (mode 0600) into the session's own cwd
  and passes that path to `--mcp-config`. Do not put the config back inline.
  It was inline until 3.6.0, which meant the token was readable via
  `ps`/`/proc/<pid>/cmdline` by any other local user for the child's lifetime,
  and it is also what made the Windows spawn impossible — Windows has to go
  through `cmd.exe` (Node refuses to spawn `claude.cmd` without a shell since
  CVE-2024-27980) and `cmd` treats the JSON's `"` as quoting toggles. The mode
  is re-applied on every write because `writeFileSync`'s `mode` only applies at
  creation. Nothing prunes these files; they live in `PANEL_CWD`, which nothing
  prunes either.
- Historical note, now moot: earlier versions had a second `stdio` mode
  bridge that ignored path routing entirely, so a hand-typed
  `ws://127.0.0.1:9876/ws?token=anything` would dial `/panel` on it and evict
  the extension's own connection. `mainStdio()` was removed before 1.0.0 — there
  is exactly one server process now, it always does path-based routing
  between `/ws` and `/panel`, and nothing in this repo listens on 9876 by
  default any more. `extension/sidepanel.js` and `extension/popup.js` still
  carry `9876` in a stale UI fallback default; that is a dead value with
  nothing behind it unless a caller manually points the extension at some
  other, unrelated process on that port.
- `attach_tab` in `extension/background.js` is the one sanctioned way a tab
  outside the session group gets in. It is not an MCP tool, so **Claude** cannot
  call it — but that is the only boundary that claim covers: `handleRequest`
  dispatches whatever `method` arrives on `/ws` straight into `handlers`, so the
  **bridge server** can call it whether or not a user pressed anything. On a
  shared bridge that meant whoever controls that process could pull every
  member's currently-focused tab into a group and read it. The guard is
  `assertLoopbackBridge()`: the handler refuses unless the extension's own saved
  bridge URL is loopback, which costs nothing legitimate because the panel only
  works against a loopback bridge anyway. It takes **no caller
  parameters at all**: the extension resolves the window itself with
  `chrome.windows.getLastFocused({windowTypes:["normal"]})` and acts on that
  window's active tab. An earlier revision let the panel name a `windowId`,
  reasoning that refusing `tabId` was enough. It was not — window ids are small
  sequential integers, so anything holding the panel token could enumerate them
  and pull every window's active tab into its own group, which is the pre-isolation
  hole with lasting access instead of a single action.

- A panel replays **two** ids on `start`, and both are caller-supplied:
  `sessionId` (reaches argv as `claude --resume`, so it is validated against a
  UUID shape before it can get there) and `mcpSessionId` (names the tab group).
  The second exists because the conversation survives a reconnect via `--resume`
  while the tab group did not: a freshly minted id renamed the group and
  stranded every tab the user had attached. Either id is refused and replaced
  with a fresh one when something live already holds it — another open panel for
  `sessionId`, an open panel or a live MCP session for `mcpSessionId` — which is
  the backstop for two panels ending up with one id. The extension keys its
  stored ids per window (`panelSession.<windowId>` in `chrome.storage.local`)
  for the same reason: one extension-global key made two windows resume one
  conversation.
- **Closed before 1.0.0:** `chrome.debugger.attach` still succeeds on this
  extension's *own* `chrome-extension://<id>/sidepanel.html` and `popup.html`
  (Chrome blocks attach on `chrome://` but not on `chrome-extension://`), so
  the guard has to be at the tool level, not the debugger API. `navigate` calls
  `assertNavigableUrl()` and refuses to send a tab to `chrome-extension:` (or
  `chrome:`, `devtools:`, `edge:`, non-blank `about:`) in the first place, and
  every mutating debugger-backed tool — `javascript_eval`, `press_key`,
  `type_text`, `upload_file` — calls `assertScriptableUrl()` on the tab before
  it touches `chrome.debugger`, so none of them can run against a
  browser-internal page even if a tab somehow already sits on one.
  `take_screenshot` deliberately does **not** call `assertScriptableUrl()` —
  that is a decision, not a gap: capturing pixels mutates nothing, while
  injecting keystrokes, script or a file selection into this extension's own
  options UI has no legitimate use and can repoint the bridge itself.
  `test/security-eval.test.mjs` guards both halves of this: it asserts the
  four mutating tools are refused against `chrome-extension://` targets (the
  only scheme it drives against a real tab — `chrome:`, `devtools:`, `edge:`
  are covered by `assertScriptableUrl()`/`assertNavigableUrl()` sharing the
  one `INTERNAL_URL_RE` regex, not by a separate assertion per scheme), and
  separately asserts `take_screenshot` still **succeeds** against the same
  `chrome-extension://` target, specifically so nobody "fixes" that asymmetry
  later.

## Side panel chat operational notes

- `AgentSession.buildArgs()` in `server/agent.js` passes `--setting-sources
  project` to every spawned `claude` child. This is load-bearing, not
  redundant with `--strict-mcp-config`: user-level settings
  (`~/.claude/settings.json`) can carry `enabledPlugins`, and a plugin's
  `SessionStart` hook runs on *every* spawned child, not once — which made
  "Phiên mới" look broken (the panel's log cleared and the server correctly
  minted a fresh session id and `--session-id`, but the child still recalled
  unrelated work from other projects, injected by the hook, not by
  conversation history). Confirmed empirically: without the flag,
  `system:init`'s `plugins` field was non-empty and a real `SessionStart` hook
  fired on every turn (verified via its own disk side effect); with the flag,
  `plugins: []` and the hook did not run, on the same machine and the same
  `~/.claude/settings.json`. Isolating the panel this way is deliberate, not
  just a bugfix: it matches the original Claude for Chrome extension (fully
  ephemeral between sessions) and Claude's own memory feature (siloed per
  project) — the panel agent should not see the user's global plugins or
  cross-project memory at all. Their own `hooks` are the one deliberate
  exception, forwarded separately; see the next entry for why that does not
  reopen this.
- The panel forwards the user's OWN hooks into each spawned `claude` — via a
  generated `--settings` file holding only their `hooks` block, never
  `enabledPlugins`. That keeps a usage tracker or notifier working (measured:
  hooks do fire under `claude -p`, `--settings` composes with
  `--setting-sources project`, and the Stop payload carries a readable
  `transcript_path`) without reopening the plugin door `--setting-sources
  project` exists to close. `SessionStart` and `SessionEnd` are dropped on
  purpose: the panel spawns one process per TURN, so forwarding them would
  record a whole session per message typed. The file is read at spawn time, so
  editing hooks takes effect on the next message rather than after a reinstall,
  and it is deleted on dispose alongside the MCP config.
- `~/.cc-chrome-bridge/panel` (`PANEL_CWD` in `server/index.js`) is the working
  directory every spawned `claude` child runs in, so it accumulates that CLI's
  own session history over time. Nothing in this repo prunes it.
- `test/panel-protocol.test.mjs` runs a real bridge with `CC_CHROME_HOST=127.0.0.1`,
  so it creates `~/.cc-chrome-bridge/panel` on the machine running the test as
  a side effect, and it binds a fixed port (8793) rather than an ephemeral
  one — a second run, or another suite already holding that port, fails to
  start rather than picking a different one.
- `npm run verify:sidepanel` is deliberately **not** part of `npm test`: it
  spawns the real `claude` CLI for live chat turns (no fixture stand-in), so it
  spends real API usage on whatever account the machine is logged into and is
  not deterministic enough for CI. Run it by hand — `HEADED=1` is already baked
  into the npm script — when you need to verify the actual side-panel UI
  end-to-end.
- The panel's activity timeline is a **two-sided contract with one owner per
  half**: `AgentSession.translate()` in `server/agent.js` owns the data — it
  pairs `tool_use_id` between the `content_block_start`/`assistant` lines and
  the `user` line carrying `tool_result`, times each step, and truncates
  results before they cross the socket — while `extension/panel-labels.js` owns
  every user-facing word. Adding a browser tool means adding one row to
  `TOOL_LABELS`; it means nothing on the server. Two invariants keep the UI
  honest and are easy to break: a `tool_result` for an id the server never
  announced must open its own `step_start` first (the panel keys rows by id and
  would silently drop an unmatched `step_end`), and **every** path that ends a
  turn must go through `AgentSession.endTurn()`, which closes any step still
  open with `aborted: true`. Miss the second and a killed turn leaves a row
  pulsing forever — which is the exact symptom the timeline was built to remove.
- The panel must also sweep its OWN open step rows rather than count on the
  server for it: `endTurn()` only fires on a session that is still alive, and a
  *disposed* session — a model change, a dropped socket — emits nothing at all,
  so there is no closing event to receive. `extension/sidepanel.js` calls
  `sweepOpenSteps()` at `turn_start`, in `socket.onclose`, in the model `change`
  handler, and after a journal replay; miss any one of those call sites and a
  row pulses forever with no turn running, which then wins `paintStatus`'s "a
  running tool outranks any phase" rule and names a dead tool in the status
  bar. `test/verify-sidepanel.mjs`'s T6 covers the model-change window on
  purpose without an intervening `turn_start` — `turn_start` sweeps too and
  would mask the very gap the test exists to catch.
- `thinking` blocks from `claude -p --output-format stream-json` **always carry
  an empty string** — measured twice on CLI 2.1.197, including under
  `ultrathink`, where the model plainly did think (a 2462-character answer
  followed). The count of `thinking_delta` events is still non-zero, so "the
  model is thinking" is knowable and "what it is thinking" is not. The panel
  therefore reports a *phase*, never reasoning text. Do not add a collapsible
  thinking box back without re-measuring first.
- The panel keeps its own journal of what it drew (`extension/panel-journal.js`,
  `panelLog.<windowId>` in `chrome.storage.local`, capped at 400 entries /
  512KB) and replays it before dialling the socket, because a reopened panel
  otherwise showed a blank log for a conversation the server resumes happily.
  It is NOT synchronised with the CLI's own transcript: clearing one does not
  clear the other. An assistant bubble's journal entry is created by its
  **first `delta`**, not by `message` — a placeholder pushed with
  `ccJournal.push()` — so the bubble lands in its true position relative to
  the tool rows around it; journalling it only at `message` time would place
  it after that turn's `step_start`/`step_args`/`step_end` entries and a
  reopened panel would show tools above text that came before them. Later
  deltas render live and journal nothing. `message` fills that same entry by
  reference and calls `ccJournal.resize()`, never `record()`, which would push
  a second entry for the same bubble. Every path that can end a stream without
  a `message` ever arriving — `ready` (a disposed session on a model change or
  "Phiên mới"), `turn_end`, `socket.onclose`, and the model `change` handler —
  calls `flushStreamingEntry()` first to copy whatever reached the screen into
  that placeholder, or a reopened panel shows an empty bubble where the text
  was.
- The panel declares `protocol: 2` in its `start` frame. A bridge is upgraded by
  the installer while the extension only changes when the user reloads it in
  `chrome://extensions`, so the server still emits the pre-timeline `tool` event
  to anything that does not ask for 2. Do not delete that branch.

## Conventions

- User-facing docs (`README.md`, popup UI, `/ccchrome` command output) are in Vietnamese. Code,
  comments, and commit messages are in English.
- Config is env-var driven and documented in the README table — add new vars there too.
- `.claude/commands/ccchrome.md` is shipped to users via `scripts/install.sh` (it copies the file into
  `~/.claude/commands/`); it is a product surface, not local tooling.
