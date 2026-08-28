# Design — panel UX, screenshot border, image input, tab-group cleanup

Date: 2026-08-28
Status: approved design, not yet planned

Four independent user-reported defects/gaps, bundled because they touch the same
two files (`extension/background.js`, `extension/sidepanel.js`) and one release.

---

## Measurements taken before designing

These were measured, not inferred. They decide the design and must not be
re-litigated from memory.

### M1 — `claude --input-format stream-json` accepts base64 image blocks

CLI 2.1.197, macOS. An 8x8 solid-blue PNG (73 bytes) sent as

```json
{"type":"user","message":{"role":"user","content":[
  {"type":"text","text":"Tra loi dung mot tu: mau cua anh nay la gi?"},
  {"type":"image","source":{"type":"base64","media_type":"image/png","data":"<b64>"}}]}}
```

produced `assistant` text `"Xanh lam."` and `result/success`. The image path is
real; no temp file and no `Read` tool are needed. This matters because the panel
spawns `claude` with `--tools ""`, so a filesystem-based image hand-off could
not have worked at all.

### M2 — stdin lifecycle for `--input-format stream-json` is the opposite of the text path

Three runs, same input:

| stdin handling | outcome |
|---|---|
| `write(line)` then `end()` immediately (what `send()` does today) | exit 0, **no turn ran** — stdout carried only `system/hook_*`, no `system/init`, no `assistant`, no `result` |
| `write(line)`, leave open | `result` at 6.1s, then child **still alive at 45s**, killed by SIGTERM (exit 143) |
| `write(line)`, leave open, `end()` on the `result` line | `result` at 7.3s, child exits **code 0 at 7.9s** (0.7s later) |

So the image path must write, keep stdin open, and close it when `result`
arrives. Doing what the text path does silently produces a turn that never ran;
doing the naive fix (never close) wedges the panel forever.

### M3 — Chrome deletes a tab group when its last tab closes

Therefore every group still visible in the tab strip has tabs in it, and
"cleaning up groups" is necessarily a decision about those tabs. Ungrouping is
the only non-destructive option.

---

## 1. Orange border: a toggle, and never in a screenshot

### 1a. Toggle

`chrome.storage.local` key `showBorder`, default `true`. A checkbox in
`popup.html` ("Hiện viền cam khi Claude dùng tab") reads and writes it directly.

`background.js` keeps a cached copy initialised at top level and refreshed by a
`chrome.storage.onChanged` listener, so it survives every service-worker
restart. `paintBorder()` returns early when the value is false.

Turning the toggle **off** must also sweep existing frames: query all tabs and
`clearBorder` each. Without this the frame stays on screen for up to
`BORDER_IDLE_MS` (30s) after the user asked for it to stop, which reads as the
button not working.

### 1b. Two independent causes of a border in a screenshot

`take_screenshot` already calls `clearBorder()` before capturing
(`extension/background.js:1265`). It is still reachable for two reasons, and
both are fixed:

**(i) Paint/clear race.** `resolveTab()` calls `paintBorder()` fire-and-forget
and never awaits it. `clearBorder()` awaits only its own `executeScript`, so a
paint issued microseconds earlier can land *after* the clear and put the frame
back before the capture.

Fix: a `borderQueue` Map keyed by `tabId` chaining paint and clear operations,
the same shape as the existing `groupLocks`. `await clearBorder(tabId)` then
genuinely means "every paint requested before this one has landed and been
undone".

**(ii) Concurrent tool calls.** Claude Code issues tool calls in parallel over
the http transport. A `read_page` running alongside the capture calls
`resolveTab()`, which repaints the frame mid-capture. Serialising per tab does
not help — the repaint is legitimately *after* the clear.

Fix: a `captureDepth` Map keyed by `tabId`. `take_screenshot` increments it
before `clearBorder`, decrements in its `finally`. `paintBorder()` is a no-op
while the depth for that tab is above zero.

Order inside `take_screenshot`: `depth++` -> `await clearBorder` -> capture ->
`finally { depth--; paintBorder }`.

### Testing

New `test/border.test.mjs`. It must fail before the fix: drive a real capture
with a concurrent `read_page` against the same tab, decode the returned PNG in
the browser and assert the edge pixels carry no orange wash. Decoding PNGs
in-browser is already established practice in this repo's e2e tests.

---

## 2. The chat log must not scroll itself

A `stick` flag, default `true`, maintained by a `scroll` listener on `#log`:

```
stick = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight <= 24
```

All three existing `logEl.scrollTop = logEl.scrollHeight` sites (`addMessage`,
`scheduleStreamRender`, `addStep`) go through one `scrollIfSticking()` helper.

Exceptions where scrolling is forced regardless of `stick`:

- pressing Enter to send — the user always wants to see the message they just
  sent, and this also resets `stick` to `true`
- the one-off scroll after a journal replay when the panel opens

A floating "↓ Tin mới" button sits at the bottom of the log, hidden while
`stick` is true. Clicking it scrolls to the bottom and sets `stick = true`.

### Testing

`test/panel-stream.test.mjs` already drives `sidepanel.js` against a fake
browser. Extend it: scroll the fake log up, feed deltas, assert `scrollTop` did
not move and the button became visible.

---

## 3. Images in the panel chat

### Wire protocol

`prompt` gains an optional `images` array:

```json
{"type":"prompt","text":"...","images":[{"mediaType":"image/png","data":"<b64>"}]}
```

The panel declares `protocol: 3` in `start`. The server's `ready` event gains
`features: ["images"]`. A panel that sees no `features` (an older bridge, which
is the normal state right after an extension reload but before a bridge update)
hides the attach button and ignores paste and drop — otherwise it would send
images the server silently drops.

### Server validation (`server/index.js`, `prompt` branch)

- at most 5 images
- `mediaType` in `image/png`, `image/jpeg`, `image/webp`, `image/gif`
- `data` matches a strict base64 shape
- each decoded image at most 5MB, all of them at most 20MB together
- empty `text` is valid only when at least one image is present

Refusals are Vietnamese error strings in the existing style, thrown the same way
as the current unknown-command error.

### `AgentSession.send(text, images)`

The text-only path is left byte-for-byte as it is today, deliberately. It has
run for months and carries every existing panel turn; the new stdin lifecycle is
confined to turns that actually carry an image.

When images are present:

- `buildArgs()` adds `--input-format stream-json`
- one NDJSON line is written: `{"type":"user","message":{"role":"user","content":[...]}}`,
  with the text block included only when the text is non-empty
- `stdin` is **not** ended after the write
- `translate()` already handles `event.type === "result"` (`server/agent.js:570`);
  that is where `this.child?.stdin.end()` goes
- `stop()` and every `endTurn()` path also end stdin defensively, so a turn that
  errors before emitting `result` cannot leave a child holding an open pipe

Rationale for each of these three lines is M2 above.

### Panel UI

- a 📎 button plus a hidden `<input type="file" accept="image/*" multiple>`
- a `paste` listener on the textarea reading `clipboardData.items` for
  `kind === "file"` with an `image/` type
- `dragover`/`drop` on the footer reading `dataTransfer.files`
- an attachment tray above the textarea: thumbnails, a × per image, an `n/5`
  counter
- downscaling via `createImageBitmap` + `OffscreenCanvas` to a long edge of
  1568px, which is the largest edge the model actually uses — sending more costs
  tokens without adding detail
- re-encoding follows the source: a JPEG source stays JPEG (quality 0.85), every
  other source becomes PNG. A screenshot pasted from the clipboard is the most
  common input and is full of text, which JPEG ringing damages; a phone photo
  re-encoded as PNG would inflate several times over

### Journal

`panel-journal.js` is capped at 400 entries and 512KB total. A single
screenshot's base64 exceeds that cap on its own and would evict the entire chat
history. So the journal records only `imageCount` on the `user` entry, and a
replay renders "🖼 2 ảnh" beneath the bubble. The image data itself is never
journalled.

### Testing

- `test/agent-session.test.mjs` — the image path builds the right argv, writes
  one well-formed NDJSON line, leaves stdin open, and ends it on `result`
- `test/panel-protocol.test.mjs` — each server validation rule refuses
- `test/panel-journal.test.mjs` — `imageCount` survives a replay and no base64
  reaches storage

---

## 4. Tab-group cleanup

### The handler

A new `release_session_group` entry in `extension/background.js`'s `handlers`
object, with **no matching MCP tool** in `server/index.js`. That is the same
boundary `attach_tab` uses: `handleRequest` dispatches whatever `method` arrives
on `/ws`, so the bridge can call it, but Claude has no tool with which to.

It takes **no caller parameters at all** — only the `__session` that
`handleRequest` injects. Nobody can name a group to dissolve; a caller can only
dissolve the group belonging to the session it is already acting as.

Body: for each normal window, resolve `sessionGroupId(session, win.id)`; when
found, `chrome.tabs.query({ groupId })` and `chrome.tabs.ungroup(tabIds)`. It
never calls `chrome.tabs.remove`, and it touches neither `active` nor `focused`.

### When the server calls it

The rule is every place a session leaves the map, not a hand-picked list of
two — `sessions.delete(...)` is the single point that means "this session is
gone", and at the time of writing it runs in three: the idle reaper
(`server/index.js:683`), `transport.onclose` (`:835`), and the panel's own
session teardown (`:915`). Hooking the deletion rather than its callers is what
keeps a fourth call site added later from silently skipping cleanup.

Best effort everywhere: the extension may be disconnected, and a rejected
`registry.call` must not break the reaper loop for the remaining sessions.

### Safety net

A signal delivered once cannot cover a session that dies while the extension is
offline, or a Chrome that is killed outright. So `chrome.runtime.onStartup`
sweeps every group whose title starts with `Claude · ` and ungroups it.

Accepted trade-off, stated explicitly: restarting Chrome while a Claude Code
session is still running also dissolves that live session's group. The tabs
survive; the session loses track of which tabs were attached and opens a fresh
one on its next tool call. This is judged better than groups that accumulate
forever with no way to clear them but by hand.

### The test that will go red first

`test/focus.test.mjs` ends with a sweep that reads `Object.keys(handlers)` live
and calls every one of them. A new handler that the sweep does not list fails
the suite. That is deliberate repo design, and `release_session_group` must be
added to it — asserting, like every other handler, that it passes neither
`active: true` to `chrome.tabs.update` nor `focused: true` to
`chrome.windows.update`.

`test/tabgroups.test.mjs` gains a case: create a group, call the handler, assert
the tabs still exist and their `groupId` is `TAB_GROUP_ID_NONE`.

---

## Cross-cutting

- `README.md` and `README.vi.md` both change, in the same commit — the repo rule
  is that a change to one is not done until the other has it
- `CLAUDE.md` gains the new invariants: the two border guards, the no-MCP-tool
  boundary on `release_session_group`, and M2's stdin lifecycle
- version bumped in `extension/manifest.json`, `VERSION` in `server/index.js`,
  `server/package.json`, and `server/package-lock.json` refreshed —
  `test/build.test.mjs` fails if any drifts
- `npm run lint` stays at 0 errors

## Out of scope

- no formatter, bundler or build step for `extension/`
- images in the terminal MCP tools — this is panel-only
- pruning `PANEL_CWD`, which nothing in this repo has ever done
