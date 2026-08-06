# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP server (`server/`) + Chrome MV3 extension (`extension/`) that lets Claude Code drive Chrome
without any claude.ai login. Every MCP tool call is forwarded over WebSocket to the extension, which
executes it with `chrome.tabs` / `chrome.scripting` / `chrome.debugger` and returns JSON.

Two runtime modes, both in `server/index.js`: `stdio` (local, single user, binds `127.0.0.1:9876`)
and `http` (`--http`, shared VPS, multi-user, Bearer-token routing, port `8787`).

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
enforced — skipping it silently reopens the hole `close_tab` and `switch_tab` had before 3.0.0.

`resolveTab()` also paints the orange "Claude is driving this tab" frame, so a handler that
uses it gets the indicator for free and must not paint one itself. The frame removes itself
~30s later from a timer held in the page — never move that timer into the service worker,
Chrome terminates the worker mid-sequence and a ghost frame would survive on the user's page.
A handler that captures pixels must call `await clearBorder(tab.id)` before the capture and
`paintBorder(tab.id)` in a `finally`, the way `take_screenshot` does.

## Injected page functions

`pageReadPage`, `pageClick`, `pageFill`, `pageFind`, `pageGetText`, `pageScroll`, `pageWaitCheck` in
`extension/background.js` are serialized and injected into the page by `chrome.scripting.executeScript`.
They run in a different realm, so:

- No closures. They may not reference anything outside their own body — inline every helper.
- Never let one throw: `chrome.scripting` swallows exceptions and returns `undefined`. Wrap the body
  in `try/catch` and `return { __cc_err: e.message }` — `execInTab()` converts that into a real error.
- Element refs live on `window.__cc_refs`, rebuilt by `read_page`/`find`. They go stale on navigation
  or DOM replacement; that is expected, the fix is to call `read_page` again.

## stdio mode: stdout is the MCP transport

In stdio mode stdout carries the MCP protocol. Any stray `console.log` in `server/index.js` corrupts
the session. Log through `log()` (which is `console.error`) or `process.stderr` only.

## Versions and signing key

- Three files carry the version and must agree: `extension/manifest.json` `version` (names the build
  artifacts), `VERSION` in `server/index.js` (reported by `chrome_status`), and `server/package.json`
  `version`. Bump all three when releasing — `test/build.test.mjs` fails if any of them drifts.
  `server/package-lock.json` records the version too; refresh it with
  `npm install --package-lock-only` inside `server/`.
- `key.pem` (gitignored, generated on first `npm run build`) determines the Chrome extension ID.
  Never delete or regenerate it — a new key changes the ID and breaks everyone's installed extension
  and any enterprise allowlist.

## Security invariants — do not relax without being asked

- Both modes require `Origin: chrome-extension://…` on the WebSocket handshake.
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
- `POST /pair` is rate limited per IP. `X-Forwarded-For` (and `-Proto`/`-Host`)
  are honored only when `CC_CHROME_TRUST_PROXY=1`, otherwise a forged header
  would bypass the limiter. `clientIp()` reads the **rightmost** entry — the one
  the adjacent trusted proxy appended; nginx appends, so the leftmost entry is
  attacker-controlled.
- `/pair` distinguishes its two refusals: 429 + `Retry-After` for the rate limit
  (waiting helps), 503 for the `CC_CHROME_MAX_TOKENS` cap (waiting does not).
- Tokens ≥ 8 chars, pair secret ≥ 12 — the server rejects weaker values on
  purpose. Dynamic tokens are capped by `CC_CHROME_MAX_TOKENS`.
- The deploy path assumes TLS terminates at Caddy (`deploy/`); port 8787 is
  never exposed directly.
- Every tool reaches its tab through `resolveTab(params)` in `extension/background.js`, which calls
  `resolveTabInGroup(params)` — that is the **only** place the in-group restriction is enforced: a
  tab id outside the caller's session group is refused, and a call with no tab id resolves to (or
  opens) a tab inside that group instead of whatever tab the user has active. A new or edited
  handler must call `resolveTab()` and must never call `chrome.tabs.query`/`get`/`remove`/`update`
  on a caller-supplied tab id directly — before
  3.0.0, `close_tab` and `switch_tab` did exactly that, which meant either tool could close or focus
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
  enough and this repo ships the counterexample: `deploy/chrome-bridge.service`
  sets `CC_CHROME_HOST=127.0.0.1` *because* a TLS reverse proxy sits in front of
  it, so a bind-address gate would declare that VPS private and let anyone with
  a token spawn `claude` on it under the host's logged-in account. A proxy's own
  peer address is loopback too, which is why the forwarded headers are checked
  by presence. Deliberately **not** overridable by an env var — a switch that
  re-enables this is a switch someone will flip. `/ws` is unaffected: the
  extension bridge is *meant* to work through a proxy.
- The panel's MCP Bearer token travels in the spawned `claude` child's argv
  (inside `--mcp-config`, built by `AgentSession.mcpConfig()` in
  `server/agent.js`), so it is readable via `ps`/`/proc/<pid>/cmdline` by any
  other local user on the same machine, for the child's lifetime. Stated the
  same way the `Origin` caveat above is stated, not omitted: this is a
  deliberate tradeoff, not an oversight. The panel already requires a loopback
  bridge, so the exposure is same-machine only, and that machine already holds
  the token in `~/.ccchrome.json` and `chrome.storage`.
- Known limitation, not a fixed one: a hand-typed
  `ws://127.0.0.1:9876/ws?token=anything` still dials `/panel` on the stdio
  bridge and evicts the extension's own connection. The stdio bridge
  (`DEFAULT_WS_URL`, port 9876) has no path routing at all, so `/panel` lands
  in the same connection handler as `/ws` and `registry.attach()` treats it as
  a replacement connection (closes the old one with 4000). The panel's guard
  in `extension/sidepanel.js` keys only on the token's presence in the saved
  URL, not on which bridge is actually on the other end, and the stdio bridge
  ignores both path and token. No documented flow produces that URL.
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
  and pull every window's active tab into its own group, which is the pre-3.0.0
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
- **Known hole, verified in a real browser, not fixed here:**
  `chrome.debugger.attach` succeeds on this extension's *own*
  `chrome-extension://<id>/sidepanel.html` and `popup.html`, and `javascript_eval`
  never calls `assertScriptableUrl` (only `execInTab` does), nor does `navigate`.
  So a model can `navigate` a tab already in its own group to the extension's own
  page and then `javascript_eval` there — that code runs in the extension's
  privileged realm with `chrome.tabs.*`, which defeats `resolveTabInGroup`
  entirely (confirmed end-to-end: `chrome.tabs.query({})` returned every tab in
  the browser). Chrome blocks attach on `chrome://` but not on
  `chrome-extension://`. Pre-existing, predates the side panel branch, and needs
  its own decision (deny `chrome-extension://` in `javascript_eval`, or refuse to
  `navigate` there at all).

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
  project) — the panel agent should not see the user's global plugins, hooks,
  or cross-project memory at all.
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

## Conventions

- User-facing docs (`README.md`, popup UI, `/ccchrome` command output) are in Vietnamese. Code,
  comments, and commit messages are in English.
- Config is env-var driven and documented in the README table — add new vars there too.
- `.claude/commands/ccchrome.md` is shipped to users via `scripts/install-command.sh`; it is a
  product surface, not local tooling.
