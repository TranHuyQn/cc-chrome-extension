# Orange border indicator on tabs Claude is driving

Date: 2026-08-04
Status: approved, ready for implementation plan

## Problem

When Claude Code drives a tab through the bridge, nothing on the page itself says so. The
only signal today is the orange tab group in the tab strip, which is easy to miss and says
"this tab belongs to a Claude session", not "Claude is touching it right now". Anthropic's
own Claude for Chrome extension paints an orange frame around the viewport while the agent
acts, and drops it when the agent stops. This spec brings that behaviour to the bridge.

## Goal

An orange frame is drawn inside the viewport of the tab Claude is currently acting on, and
disappears on its own about two seconds after Claude stops acting on that tab.

## Non-goals

- No text label inside the frame (decided: border only).
- No user setting to turn it off — it is a transparency signal and stays always on.
- No indicator for tabs in the session group that Claude is not currently touching.

## Design

### Rendering

`chrome.scripting.executeScript` injects a function into the main frame (no `allFrames`)
that creates, or refreshes, a single host element `div#__cc_border` on `document.documentElement`.

- The host carries an open shadow root; the visible frame is a div inside that shadow root,
  so page CSS selectors cannot restyle or hide it.
- All styles are applied with `element.style.setProperty(name, value, "important")`.
  No `<style>` element and no stylesheet is inserted, so pages with a strict `style-src`
  CSP are unaffected.
- Frame style: `position: fixed; inset: 0; border: 3px solid #E8710A; box-sizing: border-box;
  pointer-events: none; z-index: 2147483647;` plus `box-shadow: inset 0 0 0 1px rgba(0,0,0,0.15)`
  so the frame stays visible on orange-ish pages.
- The host is marked `aria-hidden="true"` and is never focusable, so it does not reach
  assistive tech or the page's own tab order.

The injected function follows the existing rules for in-page functions in
`extension/background.js`: no closures, everything inlined, whole body wrapped in
`try/catch`. It is a fire-and-forget paint, so a failure returns quietly rather than
producing `{ __cc_err }`.

### Lifetime — the timer lives in the page, not in the service worker

Each paint call clears and re-arms a `setTimeout(..., 2000)` stored on `window.__cc_borderTimer`
that removes the host element.

- A burst of tool calls keeps pushing the deadline back, so the frame is steady during a
  sequence of actions instead of blinking once per call.
- Two seconds after the last call touching that tab, the frame removes itself.
- If Chrome terminates the MV3 service worker mid-sequence — a routine event in this
  project — the frame still disappears, because nothing about its removal depends on the
  worker being alive. A timer held in the service worker would leave a permanent ghost
  frame in that case. This is the reason the timer is page-side.

Each tab holds its own timer, so when Claude moves to another tab the previous one clears
itself two seconds later with no bookkeeping in the worker.

### Where it hooks in

A single call site: the end of `resolveTab()` in `extension/background.js`, on every path
that returns a tab. Every tool reaches its tab through `resolveTab()` — that is already an
enforced invariant of this codebase — so no handler needs to change and no future handler
can forget the indicator.

`paintBorder(tab)` is called without `await` on the result mattering, and its rejection is
swallowed. **Hard rule: a failure to paint must never turn into a tool error.** Pages where
injection is impossible (`chrome://`, `chrome-extension://`, `devtools://`, `about:blank`,
the PDF viewer) therefore behave exactly as they do today, just with no frame.

### Three handlers need extra work

1. **`take_screenshot`** — removes the frame immediately before capturing and repaints
   afterwards, on both branches (`chrome.tabs.captureVisibleTab` and CDP
   `Page.captureScreenshot`). Screenshots are used to inspect real visual defects
   (spacing, colour, overflow); a fake orange border in every image would corrupt that.
2. **`navigate`** — navigation and reload destroy the page DOM, taking the frame with it.
   Repaint after `waitForTabComplete()` so the frame survives a navigation that is part of
   an ongoing sequence.
3. **`close_tab`** — nothing to do; the tab is gone.

No other handler is touched.

### Security

The change adds no new permission (`scripting` and `<all_urls>` are already required) and
does not alter `resolveTab()`'s group check — the paint is a side effect appended after the
tab has already been resolved and authorised. The in-group restriction, and every message
it produces, is unchanged.

## Versioning

`test/build.test.mjs` fails when the three version strings drift, so all of them move to
**3.1.0**: `extension/manifest.json`, `VERSION` in `server/index.js`, and
`server/package.json` (with `npm install --package-lock-only` inside `server/` to refresh
the lock). A minor bump, not a patch: the recent keepalive incident showed that shipping
visible behaviour changes under an unchanged version leaves the server unable to tell which
build a user is running.

## Testing

Automated, in `test/e2e.mjs`:

1. Call a tool (e.g. `read_page`) on a normal page, then assert from Playwright that
   `document.getElementById("__cc_border")` exists and its shadow root contains the frame.
2. Wait ~2.5s with no further calls and assert the element is gone.
3. Call `navigate`, then assert the frame is present after the load completes.
4. Call `take_screenshot`, then assert the frame is present again afterwards (proving the
   repaint path runs).
5. Call a tool on a tab where injection is impossible (`about:blank`) and assert the result
   is byte-for-byte the behaviour that exists today — the same success, or the same existing
   error message. The indicator must add no new failure mode and must not reword an error.

Manual, once, through the live Chrome Bridge:

- Capture a screenshot of a plain white page while a sequence is running and confirm by eye
  that the image carries no orange edge. The test suite has no PNG decoder, so this one
  cannot be asserted in code; it is a deliberate manual check, not an oversight.

## Documentation

- `README.md`: describe the frame in the section about how a session works — what it means
  and that it clears itself, so nobody reports it as a rendering bug.
- `CLAUDE.md`: note that `resolveTab()` now also paints the indicator, so a new handler gets
  it for free by following the existing rule, and that `take_screenshot`-style handlers which
  capture pixels must suppress it.
