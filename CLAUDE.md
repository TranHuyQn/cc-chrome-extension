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
npm test            # build.test + origin.test + e2e (stdio) + e2e (http) — needs real Chromium
npm run test:stdio  # a single suite: also test:build, test:origin, test:http
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

- `extension/manifest.json` `version` names the build artifacts; `VERSION` in `server/index.js` is
  reported by `chrome_status`. Bump both when releasing.
- `key.pem` (gitignored, generated on first `npm run build`) determines the Chrome extension ID.
  Never delete or regenerate it — a new key changes the ID and breaks everyone's installed extension
  and any enterprise allowlist.

## Security invariants — do not relax without being asked

- Both modes require `Origin: chrome-extension://…` on the WebSocket handshake.
  An absent Origin is a rejection, not a pass — that hole let any local process
  drive the browser. `CC_CHROME_EXTENSION_ID` optionally pins one extension id.
- The http-mode token travels in `Sec-WebSocket-Protocol` (`ccchrome.token.<t>`),
  never in the query string, because reverse proxies log the full URI. The
  server must echo the selected subprotocol via `handleProtocols` or browsers
  fail the handshake with no usable error.
- Refusals complete the handshake and close with a code (4001 bad token, 4002
  missing subprotocol, 4003 bad origin) so the extension can explain itself.
  Destroying the socket reaches the browser as an indistinguishable 1006.
- `POST /pair` is rate limited per IP. `X-Forwarded-For` is honored only when
  `CC_CHROME_TRUST_PROXY=1`, otherwise a forged header would bypass the limiter.
- Tokens ≥ 8 chars, pair secret ≥ 12 — the server rejects weaker values on
  purpose. Dynamic tokens are capped by `CC_CHROME_MAX_TOKENS`.
- The deploy path assumes TLS terminates at Caddy (`deploy/`); port 8787 is
  never exposed directly.

## Conventions

- User-facing docs (`README.md`, popup UI, `/ccchrome` command output) are in Vietnamese. Code,
  comments, and commit messages are in English.
- Config is env-var driven and documented in the README table — add new vars there too.
- `.claude/commands/ccchrome.md` is shipped to users via `scripts/install-command.sh`; it is a
  product surface, not local tooling.
