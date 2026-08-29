# Panel UX, screenshot border, image input, tab-group cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the user a switch for the driving-tab frame and keep it out of screenshots, stop the chat log scrolling itself, let the panel send images, and dissolve a session's tab group when the session dies.

**Architecture:** Four independent changes across the same two large files. The border work adds two per-tab maps in `extension/background.js` (a serialising queue and a capture-suppression counter). The scroll work funnels three existing scroll calls in `extension/sidepanel.js` through one guard. Images add an optional `images` array to the panel's `prompt` frame, validated in `server/index.js` and turned into a single NDJSON line on `claude --input-format stream-json` in `server/agent.js` — a code path that only runs for turns carrying an image. Group cleanup adds one non-MCP extension handler the bridge calls whenever a session leaves the session map.

**Tech Stack:** Plain ES2022 JavaScript. Chrome MV3 extension (no build step, no bundler, no framework — never introduce one). Node 20+ on the server. Playwright for browser tests, a hand-rolled `vm`-sandbox fake browser for panel unit tests. ESLint flat config.

**Spec:** `docs/superpowers/specs/2026-08-28-panel-ux-and-group-cleanup-design.md` — read it first; it records three measurements this plan depends on and does not repeat.

## Global Constraints

- `npm run lint` must end at **0 errors**. A `PostToolUse` hook in `.claude/settings.json` lints every `.js`/`.mjs` right after it is written; fix what it reports before moving on.
- **No build step for `extension/`.** Plain JS loaded directly by Chrome. Do not add a bundler, a transpiler, or a `package.json` under `extension/`.
- **Never edit anything under `extension/vendor/`.** It is vendored byte for byte and ESLint ignores it.
- **No `innerHTML`, anywhere in the panel.** Build DOM with `createElement`/`createTextNode`. `test/panel-markdown.test.mjs` runs against a document that throws on `innerHTML`, and `test/panel-stream.test.mjs`'s fake elements do too.
- **No handler may take focus.** Never pass `active: true` to `chrome.tabs.update` or `focused: true` to `chrome.windows.update`, and never send `state: "normal"` to a window that is not minimised. `switch_tab` is the one pre-existing exception; nothing in this plan adds another.
- **Every handler reaches its tab through `resolveTab(params)`.** Never call `chrome.tabs.get`/`query`/`remove`/`update` on a caller-supplied tab id. `release_session_group` in Task 4 takes no caller tab id at all, which is how it stays inside this rule.
- `README.md` (English, primary) and `README.vi.md` (Vietnamese) must both change in the same commit. The rest of the user-facing surface — popup UI, panel strings, `.claude/commands/ccchrome.md` — is Vietnamese. Code, comments and commit messages are English.
- Commit messages end with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- Browser tests on macOS need `HEADED=1` and **no** `CHROME_PATH` (branded Chrome ≥137 ignores `--load-extension`; Playwright's bundled Chromium honours it). Run them as `HEADED=1 node test/<file>.test.mjs`.
- Versions live in three files that must agree and are bumped once, in Task 9: `extension/manifest.json` `version`, `VERSION` in `server/index.js`, `server/package.json` `version` (plus `server/package-lock.json` refreshed with `npm install --package-lock-only` inside `server/`). `test/build.test.mjs` fails if any drifts. Current version is `1.1.1`; the release this plan produces is `1.2.0`.

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `extension/background.js` | border toggle gate, `borderQueue`, `captureDepth`, `release_session_group`, `onStartup` sweep | 1, 2, 4, 5 |
| `extension/popup.html` / `popup.js` | the "Hiện viền cam" checkbox | 1 |
| `extension/sidepanel.js` | scroll guard, jump button, image tray, paste/drop/pick, downscale, `imageCount` journalling | 3, 8 |
| `extension/sidepanel.html` | markup + CSS for the jump button and the attachment tray | 3, 8 |
| `server/agent.js` | image argv, NDJSON write, stdin lifecycle | 6 |
| `server/index.js` | `images` validation, `features` in `ready`, cleanup call on session death | 5, 7 |
| `test/border.test.mjs` (new) | both border causes, mechanism + pixels | 2 |
| `test/focus.test.mjs` | sweep must list the new handler | 4 |
| `test/tabgroups.test.mjs` | ungroup leaves tabs alive | 4 |
| `test/panel-stream.test.mjs` | no auto-scroll, jump button, `imageCount` | 3, 8 |
| `test/agent-session.test.mjs` | image argv + NDJSON + stdin lifecycle | 6 |
| `test/panel-protocol.test.mjs` | server-side image validation, `features` | 7 |
| `README.md`, `README.vi.md`, `CLAUDE.md` | docs | 9 |

---

### Task 1: Orange-border toggle in the popup

**Files:**
- Modify: `extension/background.js` (constants near `BORDER_ID`, line ~55; `paintBorder` at ~461)
- Modify: `extension/popup.html:44-46` (after the `openPanel` button)
- Modify: `extension/popup.js` (end of file)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `borderEnabled()` → `Promise<boolean>` in `background.js`, read by `paintBorder` in Task 2. Storage key `showBorder` (boolean, default `true`) in `chrome.storage.local`.

- [ ] **Step 1: Add the storage-backed gate to `extension/background.js`**

Insert immediately after the `BORDER_LOOK` constant (after line ~75, before the `sessionGroupTitle` comment block):

```js
// The user's switch for the driving-tab frame. Cached rather than read per
// paint, and the cache is a module variable initialised lazily: MV3 restarts
// this worker at will, so a value captured at install time would be wrong for
// the rest of the browser session. `null` means "not read yet", which is
// distinct from `false`.
const BORDER_PREF_KEY = "showBorder";
let borderEnabledCache = null;

async function borderEnabled() {
  if (borderEnabledCache === null) {
    try {
      const stored = await chrome.storage.local.get({ [BORDER_PREF_KEY]: true });
      borderEnabledCache = stored[BORDER_PREF_KEY] !== false;
    } catch {
      // Storage can reject on an invalidated context. Defaulting to ON is the
      // safe direction: the frame's whole purpose is telling the user their tab
      // is being driven, so a failure must not silently hide it.
      borderEnabledCache = true;
    }
  }
  return borderEnabledCache;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[BORDER_PREF_KEY]) return;
  borderEnabledCache = changes[BORDER_PREF_KEY].newValue !== false;
  // Turning it off has to take frames off the screen NOW. Without this sweep
  // the frame stays up until its own 30s idle timer fires, which reads as the
  // switch not working.
  if (!borderEnabledCache) sweepBordersOffEveryTab();
});

// Best effort by construction: most tabs have no frame, and chrome:// tabs,
// the PDF viewer and discarded tabs cannot be injected into at all. Every one
// of those is an expected no-op, not an error worth surfacing.
async function sweepBordersOffEveryTab() {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  await Promise.all(tabs.map((tab) => clearBorder(tab.id).catch(() => {})));
}
```

- [ ] **Step 2: Gate `paintBorder` on it**

Replace the body of `paintBorder` (`extension/background.js:461-466`) with:

```js
function paintBorder(tabId) {
  // Async inside a sync signature on purpose: every caller treats this as
  // fire-and-forget, and making it awaitable would invite a caller to block a
  // tool call on an indicator.
  (async () => {
    if (!(await borderEnabled())) return;
    await chrome.scripting
      .executeScript({ target: { tabId }, func: pageShowBorder, args: [BORDER_ID, BORDER_IDLE_MS, BORDER_LOOK] })
      .catch(() => {});
  })();
}
```

- [ ] **Step 3: Add the checkbox to `extension/popup.html`**

Add this CSS rule inside the existing `<style>` block, after the `.hint` rule:

```css
    .pref { display: flex; align-items: center; gap: 6px; margin-top: 12px; font-size: 12px; color: #ccc; }
    .pref input { width: auto; margin: 0; }
```

And this markup immediately after the `<button id="openPanel">Mở khung chat</button>` line:

```html
  <label class="pref">
    <input type="checkbox" id="showBorder" />
    Hiện viền cam khi Claude dùng tab
  </label>
```

- [ ] **Step 4: Wire it up in `extension/popup.js`**

Append to the end of the file:

```js
// Read and written straight to storage rather than through the service worker:
// background.js listens on chrome.storage.onChanged, so a message round trip
// would add a second path to the same state for no gain.
const showBorderInput = document.getElementById("showBorder");

chrome.storage.local.get({ showBorder: true }, ({ showBorder }) => {
  showBorderInput.checked = showBorder !== false;
});

showBorderInput.addEventListener("change", () => {
  chrome.storage.local.set({ showBorder: showBorderInput.checked });
});
```

- [ ] **Step 5: Verify by hand in a real browser**

```bash
HEADED=1 node test/tabgroups.test.mjs
```

Expected: `ALL TESTS PASSED` (this suite only proves the extension still loads and its service worker boots — a syntax error in `background.js` fails it here).

Then load `extension/` unpacked in Chrome, open the popup, and confirm the checkbox is present and starts checked.

- [ ] **Step 6: Commit**

```bash
git add extension/background.js extension/popup.html extension/popup.js
git commit -m "feat(extension): add a popup switch for the driving-tab frame

The frame is the right default but it lands in screenshots the user
takes themselves, and there was no way to turn it off. Backed by
chrome.storage.local so the service worker can read it after any
restart; turning it off sweeps every tab immediately rather than
letting each frame wait out its own 30s idle timer.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The frame must never reach a screenshot

**Files:**
- Modify: `extension/background.js` (`paintBorder`/`clearBorder` at ~461-472, `take_screenshot` at ~1209-1275)
- Create: `test/border.test.mjs`
- Modify: `package.json` (add the suite to `test`)

**Interfaces:**
- Consumes: `borderEnabled()` from Task 1.
- Produces: `borderQueue: Map<number, Promise>` and `captureDepth: Map<number, number>` in `background.js`; `withBorderLock(tabId, fn)` → `Promise`. No other task depends on these.

Two independent causes, from spec §1b. Both fixes go in together because the test file proves both.

- [ ] **Step 1: Write the failing test**

Create `test/border.test.mjs`:

```js
// Usage: HEADED=1 node test/border.test.mjs
//
// The driving-tab frame must never appear in a screenshot Claude took. It
// already came off before the capture (background.js calls clearBorder), and it
// still reached the image two ways:
//
//   (i)  paintBorder() is fire-and-forget, so a paint issued a moment earlier
//        could land AFTER the clear and put the frame back.
//   (ii) Claude Code runs tool calls in parallel, so a read_page against the
//        same tab repaints the frame mid-capture. Serialising does not help
//        there: that repaint is legitimately after the clear.
//
// Both are races, so both are made deterministic here by slowing the paint
// script inside the service worker. Without that, this file would pass on a
// fast machine against the broken code, which is the failure mode that lets a
// race ship.

import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = join(root, "extension");
const HTTP_PORT = 8794;

let failures = 0;
function check(name, cond, detail = "") {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pure white with zero margin. The frame is an inset glow strongest at the very
// edge, so a white page makes "is there orange at (2,2)" a clean question.
const TEST_PAGE = `<!DOCTYPE html>
<html><head><title>Border test page</title><style>html,body{margin:0;background:#fff;height:100%}</style></head>
<body><h1 style="margin:0;padding:200px 0 0 200px;color:#000">Border test page</h1></body></html>`;

const httpServer = createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(TEST_PAGE);
});
await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));
const TEST_URL = `http://127.0.0.1:${HTTP_PORT}/`;

const userDataDir = mkdtempSync(join(tmpdir(), "cc-border-"));
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: process.env.HEADED !== "1",
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ],
});

async function run() {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 });

  /* eslint-disable no-undef -- service-worker globals, evaluated there by Playwright */
  const callHandler = async (name, params) =>
    await sw.evaluate(async ([n, p]) => {
      try {
        return { __ok: true, result: await handlers[n](p) };
      } catch (e) {
        return { __ok: false, error: e.message };
      }
    }, [name, params]);

  // Instrument executeScript: record which injected function ran, and make the
  // PAINT slow. That inversion is what turns both races into a certainty.
  await sw.evaluate(async (delayMs) => {
    globalThis.__scriptLog = [];
    const orig = chrome.scripting.executeScript.bind(chrome.scripting);
    chrome.scripting.executeScript = async (opts) => {
      const name = opts && opts.func ? opts.func.name : "(anonymous)";
      if (name === "pageShowBorder") await new Promise((r) => setTimeout(r, delayMs));
      globalThis.__scriptLog.push({ name, tabId: opts?.target?.tabId, at: Date.now() });
      return await orig(opts);
    };
  }, 300);

  const hasFrame = async (tabId) =>
    await sw.evaluate(async (id) => {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: id },
        func: () => !!document.getElementById("__cc_border"),
      });
      return res.result;
    }, tabId);
  /* eslint-enable no-undef */

  const SESSION = "bbbb-border-session";
  const created = await callHandler("new_tab", { url: TEST_URL, __session: SESSION });
  check("test tab created and grouped", created.__ok === true, JSON.stringify(created));
  const tabId = created.result.tabId;
  await sleep(500);

  // -------------------------------------------------------------------------
  // (i) clearBorder must not be able to overtake a paint that is still in flight
  // -------------------------------------------------------------------------
  await sw.evaluate(async (id) => {
    /* eslint-disable no-undef */
    paintBorder(id);        // fire-and-forget, artificially slowed to 300ms
    await clearBorder(id);  // must not return until that paint has landed and been undone
    /* eslint-enable no-undef */
  }, tabId);
  await sleep(500); // any late paint would have landed by now
  check(
    "clearBorder() waits out an in-flight paint instead of racing it",
    (await hasFrame(tabId)) === false,
    "the frame was still on the page after an awaited clearBorder"
  );

  // -------------------------------------------------------------------------
  // (ii) a concurrent tool call must not repaint the frame during a capture
  // -------------------------------------------------------------------------
  await sw.evaluate(() => { globalThis.__scriptLog = []; });

  const shotPromise = callHandler("take_screenshot", { tabId, __session: SESSION });
  // Same tick, no await: this is exactly what the http transport does when
  // Claude issues two tool calls together.
  const readPromise = callHandler("read_page", { tabId, __session: SESSION });
  const [shot, read] = await Promise.all([shotPromise, readPromise]);

  check("take_screenshot succeeded", shot.__ok === true, JSON.stringify(shot).slice(0, 300));
  check("the concurrent read_page also succeeded", read.__ok === true, JSON.stringify(read).slice(0, 200));

  // Mechanism half — deterministic on every machine, the way focus.test.mjs
  // asserts on the arguments actually passed rather than on what was observed.
  const log = await sw.evaluate(() => globalThis.__scriptLog);
  const forTab = log.filter((e) => e.tabId === tabId);
  const hideAt = forTab.findIndex((e) => e.name === "pageHideBorder");
  const paintedAfterHide = hideAt >= 0 && forTab.slice(hideAt + 1).some((e) => e.name === "pageShowBorder");
  check(
    "no paint is injected between the pre-capture clear and the capture",
    hideAt >= 0 && !paintedAfterHide,
    JSON.stringify(forTab)
  );

  // Observable half — the pixels, which is the property the user actually cares
  // about. base64 length would not do: a blank 1280x720 PNG measures ~27,000
  // characters, so length proves nothing about content.
  const base64 = shot.__ok ? shot.result.base64 : "";
  const page = context.pages()[0];
  /* eslint-disable no-undef -- browser globals, evaluated inside the page */
  const corner = base64
    ? await page.evaluate(async (b64) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        // Four samples hugging the edges, where the inset glow is strongest.
        const pts = [[2, 2], [img.naturalWidth - 3, 2], [2, img.naturalHeight - 3], [img.naturalWidth - 3, img.naturalHeight - 3]];
        return pts.map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3));
      }, base64)
    : null;
  /* eslint-enable no-undef */

  // The frame is rgb(232,113,10) at up to 50% alpha over white. Any orange wash
  // drops the blue channel well below 240 while red stays high; untouched white
  // is (255,255,255).
  const tinted = (corner || []).filter(([r, g, b]) => r - b > 12 || g < 235 || b < 235);
  check(
    "the captured PNG has no orange wash at any edge",
    !!corner && tinted.length === 0,
    JSON.stringify(corner)
  );

  // The frame must come BACK afterwards -- suppressing it permanently would be
  // a different bug with the same green test.
  await sleep(800);
  check("the frame is repainted after the capture", (await hasFrame(tabId)) === true);
}

try {
  await run();
} catch (err) {
  console.log(`FAIL  suite threw -- ${err.stack || err.message}`);
  failures++;
} finally {
  await context.close();
  httpServer.close();
  rmSync(userDataDir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it and confirm it fails for the right reasons**

```bash
HEADED=1 node test/border.test.mjs
```

Expected: **FAIL** on at least these two, and this is the fail-first evidence — record the actual output before continuing:
- `clearBorder() waits out an in-flight paint instead of racing it` — the slowed paint lands after the clear
- `no paint is injected between the pre-capture clear and the capture` — `read_page`'s `resolveTab` repaints

If either of those PASSES before the fix, stop: the instrumentation is not reaching the code under test, and continuing would ship an assertion that cannot fail.

- [ ] **Step 3: Add the per-tab serialising queue**

In `extension/background.js`, immediately above `paintBorder` (~line 458), add:

```js
// paintBorder is fire-and-forget by design, which means a paint and a clear
// issued microseconds apart can complete out of order — and if the clear wins
// the race, the frame goes back up in time to be captured. Chaining every
// border operation for one tab through a single promise makes `await
// clearBorder(id)` mean what it reads like: every paint asked for before it has
// landed and been undone.
//
// Keyed by tab id and pruned on resolve so a long browser session does not
// accumulate one entry per tab ever touched. Same shape as groupLocks above,
// and for the same class of reason.
const borderQueue = new Map();

function withBorderLock(tabId, fn) {
  const previous = borderQueue.get(tabId) || Promise.resolve();
  // .then(fn, fn) so one rejected operation does not wedge the chain for the
  // rest of this tab's lifetime.
  const next = previous.then(fn, fn);
  borderQueue.set(tabId, next);
  next.finally(() => {
    if (borderQueue.get(tabId) === next) borderQueue.delete(tabId);
  });
  return next;
}

// A tab being captured right now. take_screenshot raises this before it clears
// the frame and lowers it after the capture, and paintBorder refuses while it
// is up — which is the only thing that stops a CONCURRENT tool call (Claude
// Code issues them in parallel over http) from repainting mid-capture. A
// counter, not a boolean: two overlapping captures of the same tab would
// otherwise have the first one to finish re-enable painting for the second.
const captureDepth = new Map();

function beginCapture(tabId) {
  captureDepth.set(tabId, (captureDepth.get(tabId) || 0) + 1);
}

function endCapture(tabId) {
  const left = (captureDepth.get(tabId) || 1) - 1;
  if (left > 0) captureDepth.set(tabId, left);
  else captureDepth.delete(tabId);
}
```

- [ ] **Step 4: Route both border operations through it**

Replace `paintBorder` and `clearBorder` (`extension/background.js:461-472`, the versions Task 1 left behind) with:

```js
// Painting is deliberately not awaited by its callers and its rejection is
// swallowed: chrome:// pages, the PDF viewer and about:blank cannot be injected
// into, and an indicator failure must never become a tool error.
function paintBorder(tabId) {
  withBorderLock(tabId, async () => {
    if (captureDepth.has(tabId)) return;
    if (!(await borderEnabled())) return;
    await chrome.scripting
      .executeScript({ target: { tabId }, func: pageShowBorder, args: [BORDER_ID, BORDER_IDLE_MS, BORDER_LOOK] })
      .catch(() => {});
  });
}

// Awaited by take_screenshot, which must not capture the frame. Going through
// the same lock is what makes that await meaningful.
async function clearBorder(tabId) {
  await withBorderLock(tabId, async () => {
    await chrome.scripting
      .executeScript({ target: { tabId }, func: pageHideBorder, args: [BORDER_ID] })
      .catch(() => {});
  });
}
```

- [ ] **Step 5: Raise the suppression around the capture**

In `take_screenshot` (`extension/background.js`), replace the `await clearBorder(tab.id);` line and the `try`/`finally` that follows it with:

```js
    // Raised BEFORE the clear, lowered after the capture: between those two
    // points a parallel tool call's resolveTab() must not be able to put the
    // frame back. Serialising alone does not cover this — that repaint is
    // legitimately after the clear, not racing it.
    beginCapture(tab.id);
    await clearBorder(tab.id);
    try {
      const shot = await cdp(tab.id, "Page.captureScreenshot", {
        format: "png",
        ...(params.fullPage ? { captureBeyondViewport: true } : {}),
      });
      return { mimeType: "image/png", base64: shot.data, fullPage: !!params.fullPage };
    } finally {
      // Order matters: lower the gate first, or the repaint below is the very
      // call it refuses.
      endCapture(tab.id);
      paintBorder(tab.id);
    }
```

- [ ] **Step 6: Run the test and verify it passes**

```bash
HEADED=1 node test/border.test.mjs
```

Expected: `ALL TESTS PASSED`.

- [ ] **Step 7: Verify nothing else regressed**

```bash
npm run lint && HEADED=1 node test/focus.test.mjs
```

Expected: lint clean, `focus.test.mjs` prints `ALL TESTS PASSED`. It contains the pre-existing `take_screenshot` pixel assertion; if that one goes red, the capture itself broke.

- [ ] **Step 8: Register the suite in `package.json`**

In the `scripts` block, add `test:border` and chain it into `test`:

```json
    "test:border": "node test/border.test.mjs",
```

and append ` && npm run test:border` to the existing `test` script's chain.

- [ ] **Step 9: Commit**

```bash
git add extension/background.js test/border.test.mjs package.json
git commit -m "fix(extension): keep the driving-tab frame out of screenshots

take_screenshot already cleared the frame before capturing, and it
still reached the image two ways. paintBorder() is fire-and-forget, so
a paint issued moments earlier could land after the clear; and Claude
Code runs tool calls in parallel, so a read_page on the same tab
repainted the frame mid-capture -- legitimately after the clear, which
serialising alone cannot fix.

A per-tab promise chain makes 'await clearBorder(id)' mean every paint
asked for before it has landed and been undone; a per-tab capture
counter makes paintBorder a no-op for the duration of a capture. The
new suite slows the injected paint inside the service worker so both
races are deterministic -- without that it would pass against the
broken code on a fast machine.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The chat log must not scroll itself

**Files:**
- Modify: `extension/sidepanel.html` (CSS block; `<div id="log">` at line ~157)
- Modify: `extension/sidepanel.js:116, 148, 184` (the three scroll sites), plus the Enter handler at ~752 and `restore()` at ~360
- Modify: `test/panel-stream.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `stick` (module-level boolean), `scrollIfSticking()`, `scrollToBottom()`, `updateJumpButton()` in `sidepanel.js`. Task 8 calls `scrollToBottom()` from the send path.

- [ ] **Step 1: Write the failing test**

In `test/panel-stream.test.mjs`, add `clientHeight: 0` to the object literal in `makeElement` (right after `scrollHeight: 0,`) — the fake element has no such property today and the guard needs it.

Then append before the final `console.log`:

```js
// --- the log must not scroll itself while the user is reading back ---------

const jumpEl = byId.get("jumpToBottom");

// Simulate a tall log the user has scrolled up in. The panel decides by
// geometry, so the geometry is what the fake has to carry.
logEl.childNodes = [];
logEl.scrollHeight = 2000;
logEl.clientHeight = 400;
logEl.scrollTop = 2000 - 400; // pinned at the bottom
for (const fn of logEl.listeners.scroll || []) fn();

sandbox.render({ type: "delta", text: "một" });
flushFrames();
check("while pinned at the bottom, new content still scrolls into view",
  logEl.scrollTop === logEl.scrollHeight, `scrollTop=${logEl.scrollTop} scrollHeight=${logEl.scrollHeight}`);

// Now the user scrolls up to read something.
sandbox.resetStream();
logEl.scrollTop = 100;
for (const fn of logEl.listeners.scroll || []) fn();
const before = logEl.scrollTop;

sandbox.render({ type: "delta", text: "hai" });
flushFrames();
sandbox.render({ type: "step_start", id: "s1", name: "mcp__chrome__read_page" });
sandbox.render({ type: "error-line", text: "một dòng nữa" });

eq("a streaming delta does not yank the log back to the bottom", logEl.scrollTop, before);
check("neither does a new step row or a new message", logEl.scrollTop === before,
  `scrollTop=${logEl.scrollTop}, expected ${before}`);
check("the jump-to-bottom button is showing", jumpEl.hidden === false, `hidden=${jumpEl.hidden}`);

// Clicking it returns the user to the live end and re-arms following.
for (const fn of jumpEl.listeners.click || []) fn();
check("clicking the button scrolls to the bottom", logEl.scrollTop === logEl.scrollHeight,
  `scrollTop=${logEl.scrollTop} scrollHeight=${logEl.scrollHeight}`);
for (const fn of logEl.listeners.scroll || []) fn();
check("and hides itself again", jumpEl.hidden === true, `hidden=${jumpEl.hidden}`);
```

- [ ] **Step 2: Run it to verify it fails**

```bash
node test/panel-stream.test.mjs
```

Expected: FAIL on `a streaming delta does not yank the log back to the bottom` (today every render sets `scrollTop = scrollHeight` unconditionally) and on the two button assertions (no such element yet).

- [ ] **Step 3: Add the button markup and CSS**

In `extension/sidepanel.html`, add to the `<style>` block after the `#log` rule:

```css
    /* The log is the flex child that grows, so the button is positioned against
       a wrapper rather than the log itself -- a position:absolute child inside a
       scrolling box scrolls with the content. */
    #logWrap { flex: 1; position: relative; display: flex; min-height: 0; }
    #jumpToBottom {
      position: absolute; right: 14px; bottom: 12px;
      background: #d97757; border-color: #d97757; color: #fff;
      border-radius: 14px; padding: 4px 10px; font-size: 11px;
      box-shadow: 0 2px 8px rgba(0,0,0,.45);
    }
```

Then replace the `<div id="log"></div>` line with:

```html
  <div id="logWrap">
    <div id="log"></div>
    <button id="jumpToBottom" hidden>↓ Tin mới</button>
  </div>
```

and change the `#log` CSS rule's `flex: 1` to `flex: 1; min-height: 0;` so it scrolls inside the wrapper.

- [ ] **Step 4: Add the guard in `extension/sidepanel.js`**

After the `const updateActionEl = ...` line (~line 32), add:

```js
const jumpEl = document.getElementById("jumpToBottom");
```

After the `let localeInitialized = false;` block (~line 92), add:

```js
// Whether the log should follow new content. The user scrolling up turns this
// off, and it stays off until they come back to the bottom or press the button:
// yanking someone away from the message they are reading is the defect this
// exists to remove.
//
// 24px of slack, not 0: a scrolling box does not always land on an exact
// integer (fractional device pixels, a mid-flight smooth scroll), and demanding
// equality would drop out of follow mode at the bottom of the log.
let stick = true;
const STICK_SLACK_PX = 24;

function atBottom() {
  return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight <= STICK_SLACK_PX;
}

function updateJumpButton() {
  jumpEl.hidden = stick;
}

// Unconditional. Used where the user's own action means they want the live end:
// sending a message, and the one-off scroll after a journal replay.
function scrollToBottom() {
  logEl.scrollTop = logEl.scrollHeight;
  stick = true;
  updateJumpButton();
}

// Everything the SERVER causes goes through here instead.
function scrollIfSticking() {
  if (!stick) return;
  logEl.scrollTop = logEl.scrollHeight;
}

logEl.addEventListener("scroll", () => {
  stick = atBottom();
  updateJumpButton();
});

jumpEl.addEventListener("click", scrollToBottom);
```

- [ ] **Step 5: Replace the three unconditional scroll sites**

In `extension/sidepanel.js`, change each of these lines to `scrollIfSticking();`:
- line ~116, the last statement before `return el;` in `addMessage`
- line ~148, inside the `requestAnimationFrame` callback in `scheduleStreamRender`
- line ~184, before `steps.set(...)` in `addStep`

Each is currently the literal `logEl.scrollTop = logEl.scrollHeight;`.

- [ ] **Step 6: Force the scroll where the user asked for it**

In the Enter handler (`extension/sidepanel.js:752-763`), add `scrollToBottom();` as the last statement, after `send({ type: "prompt", text });`.

At the end of `restore()` (~line 375), after `streamingEntry = null;`, add:

```js
  // A reopened panel starts at the live end, whatever the user's scroll
  // position was when they closed it.
  scrollToBottom();
```

- [ ] **Step 7: Run the test and verify it passes**

```bash
node test/panel-stream.test.mjs && npm run lint
```

Expected: `ALL TESTS PASSED` and lint clean.

- [ ] **Step 8: Commit**

```bash
git add extension/sidepanel.js extension/sidepanel.html test/panel-stream.test.mjs
git commit -m "fix(panel): stop the chat log scrolling itself while reading back

Every render set scrollTop = scrollHeight unconditionally, so scrolling
up to re-read an earlier answer was undone by the next delta. The log
now follows only while the user is already at the bottom, and a
'↓ Tin mới' button returns them there. Sending a message and replaying
the journal still scroll unconditionally -- both are the user asking
for the live end.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---
### Task 4: `release_session_group` — the extension side

**Files:**
- Modify: `extension/background.js` (add a handler beside `attach_tab` at ~1423)
- Modify: `test/focus.test.mjs:653-676` (the `SWEEP` list)
- Modify: `test/tabgroups.test.mjs`

**Interfaces:**
- Consumes: `sessionGroupId(session, windowId)` (existing, `background.js:99`).
- Produces: the `release_session_group` handler, called as
  `handlers.release_session_group({ __session })` → `Promise<{ ok: true, ungrouped: number }>`.
  Task 5 calls it from the server as
  `conn.call("release_session_group", {}, timeoutMs, sessionId)`.

- [ ] **Step 1: Write the failing test**

Replace the tail of `test/tabgroups.test.mjs` (everything after the two `check(...)` calls on `result`) with:

```js
// A session's group must be dissolvable when the session dies -- and dissolving
// it must not touch the tabs. Chrome deletes a group when its last tab closes,
// so every group still on the tab strip has tabs in it; ungrouping is the only
// non-destructive way to clear one.
const SESSION = "cccc-release-session";

/* eslint-disable no-undef -- service-worker globals, evaluated there by Playwright */
const callHandler = async (name, params) =>
  await sw.evaluate(async ([n, p]) => {
    try {
      return { __ok: true, result: await handlers[n](p) };
    } catch (e) {
      return { __ok: false, error: e.message };
    }
  }, [name, params]);
/* eslint-enable no-undef */

const a = await callHandler("new_tab", { url: "about:blank", __session: SESSION });
const b = await callHandler("new_tab", { url: "about:blank", __session: SESSION });
check("two tabs opened in the session group", a.__ok && b.__ok, JSON.stringify([a, b]));

const grouped = await sw.evaluate(async (ids) => {
  const tabs = await Promise.all(ids.map((id) => chrome.tabs.get(id)));
  return tabs.map((t) => t.groupId);
}, [a.result.tabId, b.result.tabId]);
check("both tabs really are in one group", grouped[0] > 0 && grouped[0] === grouped[1], JSON.stringify(grouped));

const released = await callHandler("release_session_group", { __session: SESSION });
check("release_session_group succeeded", released.__ok === true, JSON.stringify(released));
check("it reports how many tabs it freed", released.result?.ungrouped === 2, JSON.stringify(released.result));

const after = await sw.evaluate(async (ids) => {
  const out = [];
  for (const id of ids) {
    try {
      const t = await chrome.tabs.get(id);
      out.push({ id, groupId: t.groupId });
    } catch (e) {
      out.push({ id, gone: e.message });
    }
  }
  return { tabs: out, groups: (await chrome.tabGroups.query({ title: `Claude · ${SESSION.replace(/-/g, "").slice(0, 4)}` })).length };
}, [a.result.tabId, b.result.tabId]);

check("the tabs are still open -- ungroup, never close",
  after.tabs.every((t) => !t.gone), JSON.stringify(after.tabs));
check("and no longer belong to any group",
  after.tabs.every((t) => t.groupId === chromeTabGroupIdNone), JSON.stringify(after.tabs));
check("the group itself is gone from the tab strip", after.groups === 0, JSON.stringify(after));
```

At the top of the file, after the `check` helper, add:

```js
// chrome.tabGroups.TAB_GROUP_ID_NONE is -1 and is not reachable from this Node
// process, only from the service worker.
const chromeTabGroupIdNone = -1;
```

- [ ] **Step 2: Run it to verify it fails**

```bash
HEADED=1 node test/tabgroups.test.mjs
```

Expected: FAIL on `release_session_group succeeded` with `Unknown method` — the handler does not exist. (`callHandler` reaches `handlers` directly, so the error text is `handlers[n] is not a function`; either wording is the expected red.)

- [ ] **Step 3: Add the handler**

In `extension/background.js`, insert immediately after the closing `},` of `attach_tab` (~line 1436):

```js
  // Dissolves the calling session's tab group. Deliberately NOT registered as
  // an MCP tool in server/index.js: like attach_tab, it exists for the bridge
  // to call, and Claude has no tool with which to reach it.
  //
  // It takes no caller parameters at all -- only the __session that
  // handleRequest injects -- so nobody can name a group to dissolve. A caller
  // can only dissolve the group belonging to the session it is already acting
  // as, which is the same shape attach_tab settled on after an earlier revision
  // let the panel name a windowId and turned out to be enumerable.
  //
  // Ungroup, never remove. Chrome deletes a group of its own accord when the
  // last tab in it closes, so every group still visible has real tabs in it and
  // closing them would throw away pages the user may still need.
  release_session_group: async (params) => {
    const session = params.__session;
    if (!session) throw new Error("release_session_group needs a session id");
    let ungrouped = 0;
    // Per window, because a session's group can exist once in each window --
    // sessionGroupId is window-scoped for the same reason (chrome.tabs.group
    // moves a tab into the group's window, so a browser-wide lookup would drag
    // tabs across windows).
    for (const win of await chrome.windows.getAll({ windowTypes: ["normal"] })) {
      const groupId = await sessionGroupId(session, win.id);
      if (groupId === null) continue;
      const tabs = await chrome.tabs.query({ groupId });
      if (!tabs.length) continue;
      await chrome.tabs.ungroup(tabs.map((t) => t.id));
      ungrouped += tabs.length;
    }
    return { ok: true, ungrouped };
  },
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
HEADED=1 node test/tabgroups.test.mjs
```

Expected: `ALL TESTS PASSED`.

- [ ] **Step 5: Add it to the focus sweep**

`test/focus.test.mjs` reads `Object.keys(handlers)` live and fails on any handler the sweep does not exercise, so this step is not optional — the suite is red until it is done.

In `test/focus.test.mjs`, append one row to the end of the `SWEEP` array (after the `close_tab` row, so its side effect cannot disturb an earlier case):

```js
    // Last on purpose: it dissolves SESSION_SWEEP's own group, so anything
    // above it that expects that group to exist must already have run.
    ["release_session_group", {}],
```

- [ ] **Step 6: Run the focus suite**

```bash
HEADED=1 node test/focus.test.mjs
```

Expected: `ALL TESTS PASSED`, including `sweep: release_session_group does not activate any tab`, `... does not raise a window` and `... leaves the owner's active tab alone`.

- [ ] **Step 7: Commit**

```bash
git add extension/background.js test/tabgroups.test.mjs test/focus.test.mjs
git commit -m "feat(extension): add release_session_group, a non-MCP group teardown

Chrome deletes a tab group only when its last tab closes, so a session
that ends leaves its group sitting on the tab strip forever. This
handler dissolves it with chrome.tabs.ungroup -- never remove: those
tabs hold real pages.

Not registered as an MCP tool, so Claude cannot call it, and it takes
no caller parameters at all: a caller can dissolve only the group of
the session it is already acting as. Added to focus.test.mjs's
all-handlers sweep, which reads the handlers object live and would
otherwise fail on it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Call the teardown when a session dies, plus a startup safety net

**Files:**
- Modify: `server/index.js` (near the session map at ~674; the three `sessions.delete(...)` sites at ~683, ~835, ~915)
- Modify: `extension/background.js` (near the other `chrome.runtime` listeners)

**Interfaces:**
- Consumes: `release_session_group` from Task 4; `registry.requireNow(token)` (existing, used at `server/index.js:840`).
- Produces: `dropSession(id)` in `server/index.js` — the single point that removes a session from the map and fires the teardown. Every later call site must use it instead of `sessions.delete`.

- [ ] **Step 1: Add `dropSession` beside the session map**

In `server/index.js`, immediately after the `const sessions = new Map();` line (~674), insert:

```js
  // The ONE place a session leaves the map. Hooking the deletion rather than
  // each of its callers is what keeps a call site added later from silently
  // skipping the tab-group teardown -- there are three today and there is no
  // reason to think that is the final number.
  //
  // Best effort in every direction: the extension may be disconnected, the
  // group may already be gone, the call may time out. None of that may break
  // the caller, which in the reaper's case is a loop over the OTHER sessions.
  const dropSession = (id) => {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    try {
      const conn = registry.requireNow(session.token);
      // requireNow, not require: require() waits for an extension that may
      // never come back, and a teardown is not worth holding a promise open
      // across a laptop lid being shut.
      Promise.resolve(conn.call("release_session_group", {}, 5000, id))
        .then((r) => log(`Released tab group for session ${id} (${r?.ungrouped ?? 0} tab(s) ungrouped)`))
        .catch((err) => log(`Could not release tab group for session ${id}: ${err.message}`));
    } catch (err) {
      log(`No extension connected to release tab group for session ${id}: ${err.message}`);
    }
  };
```

- [ ] **Step 2: Route the three existing deletions through it**

In `server/index.js`:

- In the idle reaper (~line 681-685), replace
  ```js
      sessions.delete(id);
      try { session.transport.close(); } catch {}
  ```
  with
  ```js
      dropSession(id);
      try { session.transport.close(); } catch {}
  ```

- In `transport.onclose` (~line 834-836), replace
  ```js
        if (transport.sessionId) sessions.delete(transport.sessionId);
  ```
  with
  ```js
        if (transport.sessionId) dropSession(transport.sessionId);
  ```

- In the panel session teardown (~line 915), replace
  ```js
        sessions.delete(panel.mcpSessionId);
  ```
  with
  ```js
        dropSession(panel.mcpSessionId);
  ```

- [ ] **Step 3: Add the startup safety net to `extension/background.js`**

A signal delivered once cannot cover a session that died while the extension was offline, or a Chrome that was killed outright. Add near the other `chrome.runtime` listeners:

```js
// After a browser restart there is no live MCP session anywhere: every socket
// this extension had is gone, and so is every `claude` that held one. So any
// "Claude · xxxx" group restored with the window is, by construction, a
// leftover, and it is the only class of leftover the per-session teardown
// cannot reach.
//
// Accepted trade-off, stated because it is a real behaviour change: restarting
// Chrome while a Claude Code session is still running also dissolves that live
// session's group. The tabs survive -- this only ever ungroups -- but the
// session loses track of which tabs were attached and opens a fresh one on its
// next tool call. That is judged better than groups nothing can ever clear.
chrome.runtime.onStartup.addListener(async () => {
  try {
    const stale = await chrome.tabGroups.query({});
    for (const group of stale) {
      if (!GROUP_TITLE_RE.test(group.title || "")) continue;
      const tabs = await chrome.tabs.query({ groupId: group.id });
      if (tabs.length) await chrome.tabs.ungroup(tabs.map((t) => t.id));
    }
  } catch (err) {
    console.warn("[cc-chrome] could not sweep stale session groups:", err);
  }
});
```

And beside `sessionGroupTitle` (~line 93), add the regex it shares with that function:

```js
// Must stay in step with sessionGroupTitle() directly above: it is the same
// name, read instead of written. Anchored on both ends so a group the user
// named "Claude · notes" by hand is not swept.
const GROUP_TITLE_RE = /^Claude · [0-9a-f]{4}$/;
```

- [ ] **Step 4: Verify the title regex actually matches what the extension writes**

```bash
node -e '
const title = (s) => `Claude · ${String(s).replace(/-/g, "").slice(0, 4)}`;
const RE = /^Claude · [0-9a-f]{4}$/;
const ids = [
  "11111111-2222-3333-4444-555555555555",
  "0a1b2c3d-4e5f-6789-abcd-ef0123456789",
  "deadbeef-0000-0000-0000-000000000000",
];
for (const id of ids) console.log(RE.test(title(id)) ? "MATCH" : "MISS ", JSON.stringify(title(id)));
console.log(RE.test("Claude · notes") ? "BAD: matched a user group" : "OK: a hand-named group is not swept");
'
```

Expected: three `MATCH` lines and `OK: a hand-named group is not swept`. If any line says `MISS`, the regex and `sessionGroupTitle()` have drifted and the sweep would do nothing — fix the regex before continuing.

- [ ] **Step 5: Verify the server still starts and serves**

```bash
node test/panel-protocol.test.mjs
```

Expected: `ALL TESTS PASSED`. This boots a real bridge on port 8793 and drives a panel session end to end, so a syntax error or a bad reference in `dropSession` fails here. Note: it binds a **fixed** port — if another run or another suite is holding 8793 it fails to start rather than picking a free one.

- [ ] **Step 6: Run lint and the group suite**

```bash
npm run lint && HEADED=1 node test/tabgroups.test.mjs
```

Expected: lint clean, `ALL TESTS PASSED`.

- [ ] **Step 7: Commit**

```bash
git add server/index.js extension/background.js
git commit -m "feat: dissolve a session's tab group when the session dies

Groups accumulated on the tab strip forever: Chrome only deletes one
when its last tab closes, and nothing ever told the extension a session
had ended. The bridge now calls release_session_group from
dropSession(), which is the single point a session leaves the map --
hooking the deletion rather than its three current callers is what
keeps a fourth call site from silently skipping the teardown.

Plus a startup sweep for the case one signal cannot cover: a session
that died while the extension was offline, or a Chrome that was killed.
After a restart no session is live, so every 'Claude · xxxx' group is a
leftover by construction.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: `AgentSession` learns to send images

**Files:**
- Modify: `server/agent.js` (`buildArgs` at 349-383, `send` at 386-493, the `result` branch of `translate` at ~570, `stop`, `endTurn`)
- Modify: `test/agent-session.test.mjs`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `AgentSession.send(text, images)` where `images` is
  `Array<{ mediaType: string, data: string }>` (base64, no data: prefix) and defaults to `[]`.
  Task 7 calls it as `panel.agent.send(text, images)`.

Read spec measurement **M2** before starting. The stdin lifecycle here is the opposite of the text path's, and getting it wrong produces a turn that silently never ran.

- [ ] **Step 1: Write the failing test**

Append to `test/agent-session.test.mjs`, before the final summary lines:

```js
// --- images go in as one stream-json line, and stdin stays open -------------
//
// Measured on CLI 2.1.197 (see the spec's M2): with --input-format stream-json,
// writing the message and closing stdin the way the text path does makes the
// CLI exit 0 having run NO turn at all -- no system/init, no assistant, no
// result, and nothing on stderr. Never closing it instead leaves the child
// alive indefinitely after the result. The only correct shape is: write, keep
// open, close when `result` arrives.

{
  const argvFile = join(workdir, "argv-images.json");
  const stdinFile = join(workdir, "stdin-images.txt");
  const { session, events } = makeSession({
    env: { CC_FAKE_ARGV: argvFile, CC_FAKE_STDIN: stdinFile },
  });

  const PNG_B64 = "iVBORw0KGgoAAAANSUhEUg==";
  session.send("cái này là gì?", [{ mediaType: "image/png", data: PNG_B64 }]);
  for (let i = 0; i < 100 && !events.some((e) => e.type === "turn_end"); i++) await sleep(50);

  const argv = JSON.parse(readFileSync(argvFile, "utf8"));
  const at = argv.indexOf("--input-format");
  check("a turn with images passes --input-format stream-json",
    at !== -1 && argv[at + 1] === "stream-json", JSON.stringify(argv));

  const written = readFileSync(stdinFile, "utf8").trim();
  let parsed = null;
  try { parsed = JSON.parse(written); } catch { /* asserted below */ }
  check("exactly one NDJSON line reaches stdin", written.split("\n").length === 1 && !!parsed,
    JSON.stringify(written).slice(0, 200));
  check("it is a user message", parsed?.type === "user" && parsed?.message?.role === "user",
    JSON.stringify(parsed).slice(0, 200));

  const content = parsed?.message?.content || [];
  check("carrying the text block first", content[0]?.type === "text" && content[0]?.text === "cái này là gì?",
    JSON.stringify(content).slice(0, 300));
  check("then the image as base64 with its media type",
    content[1]?.type === "image" &&
    content[1]?.source?.type === "base64" &&
    content[1]?.source?.media_type === "image/png" &&
    content[1]?.source?.data === PNG_B64,
    JSON.stringify(content).slice(0, 300));

  check("the turn still ends", events.at(-1)?.type === "turn_end", JSON.stringify(events.at(-1)));
}

// An image with no text at all is legal -- the panel allows sending one bare.
{
  const stdinFile = join(workdir, "stdin-image-only.txt");
  const { session, events } = makeSession({ env: { CC_FAKE_STDIN: stdinFile } });
  session.send("", [{ mediaType: "image/jpeg", data: "/9j/4AAQSkZJRg==" }]);
  for (let i = 0; i < 100 && !events.some((e) => e.type === "turn_end"); i++) await sleep(50);
  const content = JSON.parse(readFileSync(stdinFile, "utf8").trim()).message.content;
  check("an image-only turn omits the empty text block entirely",
    content.length === 1 && content[0].type === "image", JSON.stringify(content).slice(0, 200));
}

// The text path must be untouched: it is what every existing turn uses.
{
  const argvFile = join(workdir, "argv-textonly.json");
  const { session, events } = makeSession({ env: { CC_FAKE_ARGV: argvFile } });
  session.send("chỉ có chữ");
  for (let i = 0; i < 100 && !events.some((e) => e.type === "turn_end"); i++) await sleep(50);
  const argv = JSON.parse(readFileSync(argvFile, "utf8"));
  check("a text-only turn does NOT pass --input-format",
    !argv.includes("--input-format"), JSON.stringify(argv));
}
```

- [ ] **Step 2: Teach the fake `claude` to record stdin**

`test/fake-claude.mjs` currently drains stdin and throws it away, so there is nothing for the assertions above to read. Replace its drain block:

```js
// Drain stdin so a parent that writes the prompt there never blocks on a full pipe.
process.stdin.resume();
process.stdin.on("data", () => {});
```

with:

```js
// Drain stdin so a parent that writes the prompt there never blocks on a full
// pipe. CC_FAKE_STDIN additionally records what arrived, which is how the image
// tests assert on the NDJSON line without a real CLI.
let received = "";
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  received += chunk;
  if (process.env.CC_FAKE_STDIN) writeFileSync(process.env.CC_FAKE_STDIN, received);
});
```

and add `CC_FAKE_STDIN  path to write everything received on stdin to` to the env-var list in its header comment.

- [ ] **Step 3: Run the test to verify it fails**

```bash
node test/agent-session.test.mjs
```

Expected: FAIL on `a turn with images passes --input-format stream-json` and on every assertion about the NDJSON line — `send()` ignores its second argument today and writes the raw text.

- [ ] **Step 4: Make `buildArgs` aware of the pending turn's shape**

In `server/agent.js`, add a field beside the other per-turn state in the constructor (next to `this.finished = false;` at ~line 219):

```js
    // Set by send() for the duration of one turn. buildArgs() is called from
    // send() after this is assigned, so it never has to be passed around.
    this.turnImages = [];
```

Then in `buildArgs()` (~line 349), after the `"--allowedTools", this.allowedTools,` entry closes the array literal and before `const panelSettings = ...`, insert:

```js
    // Only for a turn that actually carries an image. The text path writes the
    // prompt and closes stdin; stream-json inverts that (see M2 in the spec),
    // and confining the new lifecycle to the turns that need it keeps every
    // text turn on the code that has been running unchanged for months.
    if (this.turnImages.length) args.push("--input-format", "stream-json");
```

- [ ] **Step 5: Accept and encode the images in `send`**

Change the signature at `server/agent.js:386` from `send(text) {` to:

```js
  send(text, images = []) {
```

and immediately after `this.finished = false;` inside it, add:

```js
    this.turnImages = Array.isArray(images) ? images : [];
```

Then replace the final two lines of `send` (`child.stdin.write(text); child.stdin.end();`) with:

```js
    if (this.turnImages.length) {
      // One NDJSON line, and stdin deliberately left OPEN. Measured on CLI
      // 2.1.197: write-then-end (what the branch below does) makes the CLI exit
      // 0 having run no turn at all -- no system/init, no assistant, no result,
      // nothing on stderr. It is closed when the `result` line arrives, in
      // translate(); never closing it leaves the child alive indefinitely.
      const content = [];
      if (text) content.push({ type: "text", text });
      for (const image of this.turnImages) {
        content.push({
          type: "image",
          source: { type: "base64", media_type: image.mediaType, data: image.data },
        });
      }
      child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
    } else {
      child.stdin.write(text);
      child.stdin.end();
    }
```

- [ ] **Step 6: Close stdin when the turn's result arrives**

In `translate()` (`server/agent.js:570`), inside the `if (event.type === "result")` branch, add as its first statement:

```js
      // The stream-json input path leaves stdin open (see send()), and the CLI
      // waits on it rather than exiting. This line is what ends the turn's
      // process. Harmless on the text path, where stdin is already ended.
      this.endStdin();
```

- [ ] **Step 7: Add `endStdin` and call it from every other turn-ending path**

Add this method to `AgentSession`, immediately above `endTurn` (~line 279):

```js
  // Idempotent and never throws: a turn can end through `result`, through
  // stop(), through a spawn failure, or through the child dying on its own, and
  // an already-ended or already-destroyed pipe must not turn any of those into
  // an exception. Leaving it open on the image path is what wedges a child
  // forever, so every one of those paths calls this.
  endStdin() {
    try {
      if (this.child && this.child.stdin && !this.child.stdin.destroyed) this.child.stdin.end();
    } catch { /* the pipe is already gone, which is the state we wanted */ }
  }
```

and add `this.endStdin();` as the first statement of `endTurn(payload)` and of `stop()`.

- [ ] **Step 8: Run the test and verify it passes**

```bash
node test/agent-session.test.mjs && npm run lint
```

Expected: `ALL TESTS PASSED` and lint clean. Every pre-existing case in that file must still pass — the text path is meant to be untouched.

- [ ] **Step 9: Commit**

```bash
git add server/agent.js test/agent-session.test.mjs test/fake-claude.mjs
git commit -m "feat(panel): let a turn carry images into the claude CLI

Measured on CLI 2.1.197: --input-format stream-json accepts base64
image content blocks (an 8x8 blue PNG came back correctly described),
but it inverts the stdin lifecycle. Writing and closing -- what the
text path does -- makes the CLI exit 0 having run no turn at all: no
system/init, no assistant, no result, nothing on stderr. Never closing
leaves the child alive indefinitely after the result.

So the new path writes one NDJSON line, keeps stdin open, and closes it
on the result line. Confined to turns that actually carry an image; a
text-only turn still takes the code every existing turn has used.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Server-side image validation and capability advertisement

**Files:**
- Modify: `server/index.js` (the `ready` frame at ~1028-1037; the `prompt` branch at ~1093-1099)
- Modify: `test/panel-protocol.test.mjs`

**Interfaces:**
- Consumes: `AgentSession.send(text, images)` from Task 6.
- Produces: the `images` field on the `prompt` frame
  (`Array<{ mediaType: string, data: string }>`, optional) and `features: string[]`
  on the `ready` frame. Task 8 reads `features` in the panel.

- [ ] **Step 1: Write the failing test**

In `test/panel-protocol.test.mjs`, find where the suite receives a `ready` frame and add assertions after it, then append a validation block. Add near the other constants at the top:

```js
// A 1x1 transparent PNG, small enough to keep the frames readable in a failure
// message and real enough to be a valid base64 payload.
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
```

and append this block before the final summary. It uses the file's own
`openPanel()` helper (line ~308), whose `waitFor(predicate, ms)` searches every
frame that panel has **ever** received and returns `null` on timeout — both of
which shape the assertions below:

```js
// --- images: the server advertises the capability and polices the payload ---

{
  const panel = openPanel();
  await panel.waitFor((f) => f.type === "hello");
  panel.send({ type: "start", sessionId: null, model: "sonnet" });
  const ready = await panel.waitFor((f) => f.type === "ready");
  check("ready advertises the image capability",
    Array.isArray(ready?.features) && ready.features.includes("images"),
    JSON.stringify(ready?.features));

  // waitFor finds the FIRST matching frame in this panel's whole history, so a
  // bare "did an error arrive" would be satisfied for every case by the first
  // refusal. Count new frames instead.
  const errorsSoFar = () => panel.frames.filter((f) => f.type === "error").length;
  const turnsSoFar = () => panel.frames.filter((f) => f.type === "turn_start").length;

  const refuses = async (name, images, expect) => {
    const before = errorsSoFar();
    panel.send({ type: "prompt", text: "x", images });
    const got = await panel.waitFor((f) => f.type === "error" && expect.test(f.message || ""), 3000);
    check(name, errorsSoFar() > before && !!got,
      JSON.stringify(panel.frames.filter((f) => f.type === "error").at(-1)));
  };

  await refuses("six images are refused",
    Array.from({ length: 6 }, () => ({ mediaType: "image/png", data: TINY_PNG })), /5/);
  await refuses("a non-image media type is refused",
    [{ mediaType: "application/pdf", data: TINY_PNG }], /định dạng/);
  await refuses("a payload that is not base64 is refused",
    [{ mediaType: "image/png", data: "not base64!!" }], /base64/);

  // Empty text and no images is ignored outright -- no turn, and no error
  // either. Asserted by waiting out a window rather than by a missing frame.
  const turnsBefore = turnsSoFar();
  panel.send({ type: "prompt", text: "   " });
  await sleep(800);
  check("an empty prompt with no images starts no turn",
    turnsSoFar() === turnsBefore, `${turnsSoFar()} vs ${turnsBefore}`);

  // An image with no text is a complete message -- "what is this?" is implied.
  panel.send({ type: "prompt", text: "", images: [{ mediaType: "image/png", data: TINY_PNG }] });
  const started = await panel.waitFor((f) => f.type === "turn_start", 10000);
  check("an image with no text does start a turn",
    !!started && turnsSoFar() > turnsBefore, JSON.stringify(started));
  await panel.waitFor((f) => f.type === "turn_end", 15000);

  panel.socket.close();
}
```

> `test/fake-claude-mcp.mjs` — the CLI stand-in this suite spawns — drains stdin
> and exits on its own without ever emitting a `result` line, so the image
> turn's `endStdin()` never fires there and the turn ends through the child's
> `close` instead. That is why this suite does not hang despite Task 6 leaving
> stdin open; do not "fix" the fake to emit a result.

- [ ] **Step 2: Run it to verify it fails**

```bash
node test/panel-protocol.test.mjs
```

Expected: FAIL on `ready advertises the image capability` (no `features` field yet) and on each refusal (the server ignores `images` entirely today, so a six-image prompt starts a turn instead of erroring).

- [ ] **Step 3: Advertise the capability**

In `server/index.js`, add one field to the `ready` frame (~line 1036, after `groupTitle`):

```js
        // What this bridge can accept, so a panel newer than the bridge can
        // hide UI the bridge would silently drop. A bridge is upgraded by the
        // installer while the extension only changes when the user reloads it
        // in chrome://extensions, so the two versions routinely disagree.
        features: ["images"],
```

- [ ] **Step 4: Validate and forward the images**

In `server/index.js`, replace the `prompt` branch (~1093-1099) with:

```js
    if (msg.type === "prompt") {
      const text = String(msg.text || "").trim();
      const images = validateImages(msg.images);
      if (!text && !images.length) return;
      if (panel.agent.busy) throw new Error("Claude đang chạy — bấm dừng trước đã.");
      panel.agent.send(text, images);
      return;
    }
```

And add the validator near the other module-level helpers in `server/index.js` (above `mainHttp`, beside the other constants):

```js
// The panel is the only caller, but "the only caller is ours" has never been a
// reason to skip validation: these bytes are about to be spent as model input
// and written to a child process's stdin.
const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_IMAGES_PER_TURN = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES_TOTAL_BYTES = 20 * 1024 * 1024;
// Standard base64 only: the panel produces it with canvas.toDataURL, so there
// is no reason to accept the URL-safe alphabet and every reason not to widen
// what reaches JSON.stringify and a child's stdin.
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function validateImages(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error("Trường 'images' phải là một mảng.");
  if (raw.length > MAX_IMAGES_PER_TURN) {
    throw new Error(`Tối đa ${MAX_IMAGES_PER_TURN} ảnh mỗi tin nhắn (nhận được ${raw.length}).`);
  }
  let total = 0;
  const out = [];
  for (const [index, image] of raw.entries()) {
    const at = `Ảnh thứ ${index + 1}`;
    if (!image || typeof image !== "object") throw new Error(`${at} không hợp lệ.`);
    const mediaType = String(image.mediaType || "");
    if (!IMAGE_MEDIA_TYPES.has(mediaType)) {
      throw new Error(`${at} có định dạng không hỗ trợ (${mediaType || "không rõ"}). Chỉ nhận PNG, JPEG, WebP, GIF.`);
    }
    const data = String(image.data || "");
    if (!data || !BASE64_RE.test(data)) throw new Error(`${at} không phải dữ liệu base64 hợp lệ.`);
    // Exact, from the encoding itself: 4 base64 characters carry 3 bytes, minus
    // one per '=' of padding. Cheaper and more honest than decoding a 5MB
    // buffer just to measure it.
    const bytes = Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
    if (bytes > MAX_IMAGE_BYTES) {
      throw new Error(`${at} nặng ${(bytes / 1048576).toFixed(1)}MB, vượt giới hạn ${MAX_IMAGE_BYTES / 1048576}MB.`);
    }
    total += bytes;
    if (total > MAX_IMAGES_TOTAL_BYTES) {
      throw new Error(`Tổng dung lượng ảnh vượt ${MAX_IMAGES_TOTAL_BYTES / 1048576}MB.`);
    }
    out.push({ mediaType, data });
  }
  return out;
}
```

- [ ] **Step 5: Run the test and verify it passes**

```bash
node test/panel-protocol.test.mjs && npm run lint
```

Expected: `ALL TESTS PASSED` and lint clean.

- [ ] **Step 6: Commit**

```bash
git add server/index.js test/panel-protocol.test.mjs
git commit -m "feat(bridge): accept and police images on the panel prompt frame

Caps at 5 images, 5MB each and 20MB per turn, and refuses anything that
is not PNG/JPEG/WebP/GIF or not standard base64 -- these bytes go
straight into a child process's stdin and are spent as model input, so
'the only caller is our own panel' is not a reason to skip any of it.

ready now carries features:['images'] so a panel newer than the bridge
can hide UI this bridge would silently drop. That mismatch is the
normal state, not an edge case: the installer upgrades the bridge while
the extension only changes when the user reloads it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---
### Task 8: The panel's image UI

**Files:**
- Modify: `extension/sidepanel.html` (CSS block; the `<footer>` at ~163-171)
- Modify: `extension/sidepanel.js` (element refs at ~20-32; `render()`'s `user` case at ~515; the `ready` handler at ~575; the Enter handler at ~752)
- Modify: `test/panel-stream.test.mjs`

**Interfaces:**
- Consumes: `features` on `ready` and the `images` field on `prompt` from Task 7; `scrollToBottom()` from Task 3.
- Produces: nothing other tasks depend on. `attachments` is module-local:
  `Array<{ mediaType: string, data: string }>`.

- [ ] **Step 1: Write the failing test**

Append to `test/panel-stream.test.mjs`, before the final summary:

```js
// --- images: what the journal keeps, and what a replay draws ---------------
//
// Only the journal/render half is exercised here. Encoding runs on
// createImageBitmap + OffscreenCanvas, which this fake browser does not have
// and should not grow a stub for: a stub would assert that our stub works.
// The encoder is covered by hand in Task 8's manual step.

logEl.childNodes = [];
sandbox.record({ type: "user", text: "cái này là gì?", imageCount: 2 });

const userEntry = sandbox.ccJournal.entries().filter((e) => e.type === "user").at(-1);
eq("the journal records how many images were sent", userEntry?.imageCount, 2);
check("and never the image data itself",
  !JSON.stringify(userEntry).includes("base64") && !("images" in userEntry),
  JSON.stringify(userEntry));

logEl.childNodes = [];
sandbox.render(userEntry);
check("a replay draws the count beside the message",
  plainText(logEl.childNodes[0]).includes("2 ảnh"),
  JSON.stringify(plainText(logEl.childNodes[0])));

// An image sent with no text at all still has to leave a visible bubble.
logEl.childNodes = [];
sandbox.render({ type: "user", text: "", imageCount: 1 });
check("an image-only message is not an empty bubble",
  plainText(logEl.childNodes[0]).includes("1 ảnh"),
  JSON.stringify(plainText(logEl.childNodes[0])));
```

- [ ] **Step 2: Run it to verify it fails**

```bash
node test/panel-stream.test.mjs
```

Expected: FAIL on `the journal records how many images were sent` (the field is dropped) and on both replay assertions (nothing renders a count).

- [ ] **Step 3: Add the markup and CSS**

In `extension/sidepanel.html`, add to the `<style>` block:

```css
    .img-badge { font-size: 11px; color: #aaa; margin-top: 4px; }
    #tray { display: none; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; align-items: center; }
    #tray.on { display: flex; }
    .thumb { position: relative; width: 46px; height: 46px; border-radius: 6px; overflow: hidden; border: 1px solid #444; }
    .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .thumb button {
      position: absolute; top: 0; right: 0; padding: 0; width: 16px; height: 16px;
      line-height: 14px; font-size: 11px; border: 0; border-radius: 0 0 0 6px;
      background: rgba(0,0,0,.65); color: #fff;
    }
    #trayCount { font-size: 11px; color: #888; }
    footer.dragging { outline: 2px dashed #d97757; outline-offset: -4px; }
```

Replace the `<footer>` block's contents so it reads:

```html
  <footer>
    <div id="status"><span id="statusText"></span><span id="statusTime"></span></div>
    <div class="toolbar">
      <button id="attach">Đưa tab này vào phiên</button>
      <button id="pickImage" title="Đính ảnh" hidden>📎</button>
      <button id="newSession">Phiên mới</button>
      <button id="stop" disabled>Dừng</button>
    </div>
    <div id="tray"><span id="trayCount"></span></div>
    <input type="file" id="imageInput" accept="image/*" multiple hidden />
    <textarea id="input" placeholder="Nhắn cho Claude… (Enter để gửi)"></textarea>
  </footer>
```

- [ ] **Step 4: Add the element refs and state**

In `extension/sidepanel.js`, after the `const jumpEl = ...` line from Task 3, add:

```js
const pickImageEl = document.getElementById("pickImage");
const imageInputEl = document.getElementById("imageInput");
const trayEl = document.getElementById("tray");
const trayCountEl = document.getElementById("trayCount");
const footerEl = document.querySelector("footer");
```

and beside the other module state (after `let stick = true;`):

```js
// Staged for the next message. Already downscaled and base64-encoded, because
// the encode is async and doing it at Enter time would put a visible pause
// between the keypress and the message appearing.
let attachments = [];
// What the bridge said it can accept, from `ready`. A bridge is upgraded by the
// installer while the extension only changes when the user reloads it in
// chrome://extensions, so a panel newer than its bridge is the normal state --
// and a bridge that does not know about `images` drops them in silence, which
// is the one outcome the user could not diagnose.
let serverFeatures = [];

const MAX_IMAGES = 5;
// The longest edge the model actually uses. Sending more costs tokens without
// adding any detail it can read.
const MAX_IMAGE_EDGE = 1568;
```

- [ ] **Step 5: Add the encoder and the tray**

Add these functions above the Enter handler:

```js
// Re-encoding follows the SOURCE, not a single house format. A pasted
// screenshot is the common case here and is full of text, which JPEG ringing
// smears; a phone photo re-encoded as PNG inflates several times over. Anything
// that is neither (WebP, GIF) lands on PNG -- a GIF loses its animation, which
// is the intended degradation: the model reads one frame regardless.
async function encodeImage(file) {
  const bitmap = await createImageBitmap(file);
  const longest = Math.max(bitmap.width, bitmap.height);
  const scale = longest > MAX_IMAGE_EDGE ? MAX_IMAGE_EDGE / longest : 1;
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = file.type === "image/jpeg"
    ? await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 })
    : await canvas.convertToBlob({ type: "image/png" });
  return { mediaType: blob.type, data: await blobToBase64(blob) };
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("không đọc được ảnh"));
    reader.onload = () => {
      const url = String(reader.result);
      // readAsDataURL gives "data:<type>;base64,<payload>" -- the server wants
      // the payload alone, and so does the CLI's image block.
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}

async function addFiles(files) {
  for (const file of files) {
    if (!file || !file.type || !file.type.startsWith("image/")) continue;
    if (attachments.length >= MAX_IMAGES) {
      addMessage("error", `Tối đa ${MAX_IMAGES} ảnh mỗi tin nhắn.`);
      break;
    }
    try {
      attachments.push(await encodeImage(file));
    } catch (err) {
      addMessage("error", `Không xử lý được ảnh: ${err.message}`);
    }
  }
  paintTray();
}

// Rebuilt whole rather than patched: five thumbnails is nothing to redraw, and
// an index-based patch is how a removal ends up deleting the wrong one.
function paintTray() {
  trayEl.classList.toggle("on", attachments.length > 0);
  trayEl.textContent = "";
  attachments.forEach((image, index) => {
    const box = document.createElement("div");
    box.className = "thumb";
    const img = document.createElement("img");
    // A data: URL, not URL.createObjectURL: the base64 is already in hand, and
    // an object URL would have to be revoked on every path that clears the tray.
    img.src = `data:${image.mediaType};base64,${image.data}`;
    img.alt = "";
    const remove = document.createElement("button");
    remove.textContent = "×";
    remove.title = "Bỏ ảnh này";
    remove.addEventListener("click", () => {
      attachments.splice(index, 1);
      paintTray();
    });
    box.append(img, remove);
    trayEl.appendChild(box);
  });
  trayCountEl.textContent = attachments.length ? `${attachments.length}/${MAX_IMAGES}` : "";
  trayEl.appendChild(trayCountEl);
}

function clearAttachments() {
  attachments = [];
  paintTray();
}
```

- [ ] **Step 6: Wire the three ways in**

Add after the encoder block:

```js
pickImageEl.addEventListener("click", () => imageInputEl.click());

imageInputEl.addEventListener("change", async () => {
  await addFiles([...imageInputEl.files]);
  // Cleared so picking the same file twice in a row still fires `change`.
  imageInputEl.value = "";
});

inputEl.addEventListener("paste", (event) => {
  if (!serverFeatures.includes("images")) return;
  const files = [...(event.clipboardData?.items || [])]
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (!files.length) return;
  // Only when an image is actually present: a normal text paste must stay a
  // normal text paste.
  event.preventDefault();
  addFiles(files);
});

footerEl.addEventListener("dragover", (event) => {
  if (!serverFeatures.includes("images")) return;
  event.preventDefault();
  footerEl.classList.add("dragging");
});
footerEl.addEventListener("dragleave", () => footerEl.classList.remove("dragging"));
footerEl.addEventListener("drop", (event) => {
  if (!serverFeatures.includes("images")) return;
  event.preventDefault();
  footerEl.classList.remove("dragging");
  addFiles([...(event.dataTransfer?.files || [])]);
});
```

- [ ] **Step 7: Read the capability on `ready`**

In `handle()`'s `case "ready":` (~line 575), after `groupEl.textContent = msg.groupTitle || "";`, add:

```js
      // An older bridge sends no `features` at all. Hiding the button (and the
      // paste/drop paths above, which check the same list) is the honest
      // response: that bridge would accept the frame and drop the images
      // without a word.
      serverFeatures = Array.isArray(msg.features) ? msg.features : [];
      pickImageEl.hidden = !serverFeatures.includes("images");
      if (!serverFeatures.includes("images") && attachments.length) clearAttachments();
```

- [ ] **Step 8: Send them**

Replace the Enter handler's body (`extension/sidepanel.js:752-763`, as Task 3 left it) with:

```js
inputEl.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey) return;
  event.preventDefault();
  const text = inputEl.value.trim();
  // An image with no words is a complete message -- "what is this?" is implied.
  if ((!text && !attachments.length) || busy) return;
  locale = ccLabels.detectLocale(text, locale);
  saveState();
  // Only the COUNT is journalled. panel-journal.js caps at 400 entries and
  // 512KB total; one screenshot's base64 exceeds that cap by itself and would
  // evict the entire conversation behind it.
  record({ type: "user", text, imageCount: attachments.length });
  inputEl.value = "";
  send({ type: "prompt", text, images: attachments });
  clearAttachments();
  scrollToBottom();
});
```

- [ ] **Step 9: Render the count**

In `render()`, replace `case "user":` (~line 515) with:

```js
    case "user": {
      const el = addMessage("user", msg.text || "");
      if (typeof msg.imageCount === "number" && msg.imageCount > 0) {
        const badge = document.createElement("div");
        badge.className = "img-badge";
        badge.textContent = `🖼 ${msg.imageCount} ảnh`;
        el.appendChild(badge);
        scrollIfSticking();
      }
      break;
    }
```

- [ ] **Step 10: Run the test and verify it passes**

```bash
node test/panel-stream.test.mjs && npm run lint
```

Expected: `ALL TESTS PASSED` and lint clean.

- [ ] **Step 11: Verify the encoder by hand, against a real bridge**

The encode path runs on `createImageBitmap` and `OffscreenCanvas`, which the fake browser deliberately does not provide, so this half is only ever proven in a real Chrome.

```bash
npm run verify:sidepanel
```

> This spawns the real `claude` CLI and spends real API usage on the logged-in account. It is not part of `npm test` for that reason.

Then, in the panel that opens:
1. paste a screenshot with `Cmd+V` — a thumbnail appears, the counter reads `1/5`
2. drag an image file onto the footer — the footer outlines, a second thumbnail appears
3. press 📎 and pick a `.jpg` — a third thumbnail appears
4. press × on one — the right one disappears
5. send with no text at all — the bubble reads `🖼 2 ảnh` and Claude answers about the images
6. close and reopen the panel — the bubble still reads `🖼 2 ảnh`, and `chrome.storage.local` holds no base64:
   run this in the panel's devtools console and expect `0`:
   ```js
   (async () => { const all = await chrome.storage.local.get(null);
     console.log(JSON.stringify(all).match(/iVBORw0KGgo|\/9j\/4AAQ/g)?.length || 0); })()
   ```

Record the outcome of each of the six. If step 6 prints anything but `0`, image data is reaching the journal and Step 8's `record(...)` is wrong.

- [ ] **Step 12: Commit**

```bash
git add extension/sidepanel.js extension/sidepanel.html test/panel-stream.test.mjs
git commit -m "feat(panel): attach images by file picker, paste or drag and drop

Downscaled to a 1568px long edge before sending -- the largest edge the
model actually reads -- and re-encoded following the source: JPEG stays
JPEG, everything else becomes PNG. A pasted screenshot is the common
case here and is full of text, which JPEG ringing smears.

The journal keeps only the COUNT. It caps at 400 entries and 512KB
total, so one screenshot's base64 would evict the whole conversation
behind it. The attach button hides itself against a bridge whose `ready`
does not advertise the capability, because that bridge accepts the
frame and drops the images without a word.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Docs, version bump, and the full suite

**Files:**
- Modify: `README.md`, `README.vi.md`, `CLAUDE.md`
- Modify: `extension/manifest.json`, `server/index.js` (`VERSION`), `server/package.json`, `server/package-lock.json`

**Interfaces:**
- Consumes: everything above.
- Produces: release `1.2.0`.

- [ ] **Step 1: Document the four changes in `README.md`**

Place each near the existing section it belongs to (the popup section, the side
panel section, the tab-group section). Exact copy:

> **Driving-tab frame.** The orange frame that marks a tab Claude is using can be
> switched off from the extension popup ("Hiện viền cam khi Claude dùng tab"); it
> is on by default. The switch is about screenshots *you* take — `take_screenshot`
> removes the frame before capturing either way, and a parallel tool call cannot
> repaint it mid-capture.

> **Images in the side panel.** Attach up to 5 images per message with the 📎
> button, by pasting from the clipboard, or by dropping files onto the composer.
> Each is downscaled to a 1568px long edge before sending — the largest edge the
> model reads. A message with images and no text is fine. Note that a reopened
> panel shows the *count* ("🖼 2 ảnh"), not the images themselves: the panel's
> replay journal is capped at 512KB and one screenshot would fill it. The 📎
> button is hidden when the bridge is older than the extension and cannot accept
> images.

> **The chat log no longer follows new output while you are scrolled up.** Scroll
> back to read an earlier answer and it stays where you put it; a "↓ Tin mới"
> button appears to take you to the live end. Sending a message always scrolls
> down.

> **Tab groups clean themselves up.** When an MCP session ends — the client
> disconnects, or it idles past `CC_CHROME_SESSION_TTL_MS` — its "Claude · xxxx"
> group is dissolved. The tabs are **ungrouped, never closed**. Every leftover
> group is also swept when Chrome starts, which is the only way to reach a group
> whose session died while the extension was disconnected; the trade-off is that
> restarting Chrome mid-session dissolves that live session's group too, and it
> will open a fresh tab on its next tool call.

- [ ] **Step 2: Mirror all four into `README.vi.md`**

The repo rule is that a change to one README is not done until the other has it.
Same four items, same positions, translated — `README.vi.md` is the Vietnamese
README, not an abridged one.

- [ ] **Step 3: Record the new invariants in `CLAUDE.md`**

Add to the sections they belong to:
- under the border rules: `paintBorder`/`clearBorder` both go through `withBorderLock`, and `paintBorder` is a no-op while `captureDepth` holds that tab. A handler that captures pixels must call `beginCapture`/`endCapture` around it, not just `clearBorder`. `test/border.test.mjs` slows the injected paint inside the service worker on purpose — without that inversion the suite passes against the broken code.
- under the security invariants: `release_session_group` is the second non-MCP handler after `attach_tab`, takes no caller parameters, and only ever ungroups.
- under the side-panel operational notes: **M2** from the spec, verbatim in substance — `--input-format stream-json` inverts the stdin lifecycle; write-then-close runs no turn and says nothing; never closing wedges the child; close on the `result` line. Include the measured numbers.
- under the side-panel operational notes: the journal stores `imageCount` only, and why (the 512KB cap).

- [ ] **Step 4: Bump the version in all three files plus the lockfile**

```bash
node -e '
const fs = require("fs");
const bump = (p, fn) => fs.writeFileSync(p, fn(fs.readFileSync(p, "utf8")));
bump("extension/manifest.json", (s) => s.replace(/"version": "1\.1\.1"/, `"version": "1.2.0"`));
bump("server/package.json",     (s) => s.replace(/"version": "1\.1\.1"/, `"version": "1.2.0"`));
bump("server/index.js",         (s) => s.replace(/VERSION = "1\.1\.1"/, `VERSION = "1.2.0"`));
'
grep -n '"version"' extension/manifest.json server/package.json
grep -n 'VERSION = ' server/index.js
cd server && npm install --package-lock-only && cd ..
```

Expected: all three read `1.2.0`. If the `VERSION = ` grep finds nothing, the constant is written differently in this file — find it with `grep -n VERSION server/index.js` and edit it by hand rather than leaving it stale.

- [ ] **Step 5: Run the whole suite**

```bash
npm run lint
HEADED=1 npm test
```

Expected: lint at 0 errors, and every suite printing `ALL TESTS PASSED`. Note the suites are chained with `&&`, so the first failure hides the rest — if one fails, fix it and re-run rather than reading the run as "only one problem".

Suites that must be green and are the ones most likely to catch a regression from this work:
`build.test.mjs` (version agreement), `focus.test.mjs` (the all-handlers sweep), `border.test.mjs`, `tabgroups.test.mjs`, `panel-stream.test.mjs`, `panel-protocol.test.mjs`, `agent-session.test.mjs`, `panel-journal.test.mjs`.

- [ ] **Step 6: Commit**

```bash
git add README.md README.vi.md CLAUDE.md extension/manifest.json server/index.js server/package.json server/package-lock.json
git commit -m "release: 1.2.0

Panel image input, no more self-scrolling chat log, a switch for the
driving-tab frame plus two fixes that keep it out of screenshots, and
tab groups that clean themselves up.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Stop here**

Building and publishing a GitHub Release is a separate, manual step with its own four-asset checklist in `CLAUDE.md`, and it is not part of this plan. Do not run `npm run build:release` or create a tag without being asked.

---

## Notes for whoever executes this

- **Task order is not arbitrary.** 6 and 7 must land before 8 — the panel's image UI hides itself unless the bridge advertises the capability, so building the UI first gives you a button that does nothing and no way to tell whether that is the bug.
- **Task 4 makes `test/focus.test.mjs` red the moment the handler exists** and green again only after Step 5 of that task. That is the repo working as designed, not a regression you introduced.
- **`test/panel-protocol.test.mjs` binds a fixed port (8793)** and creates `~/.cc-chrome-bridge/panel` on the machine that runs it. A second concurrent run fails to start rather than picking a free port.
- **`npm run verify:sidepanel` spends real API usage.** It is the only way to prove Task 8's encoder, and it is deliberately not in `npm test`.
- **Do not "fix" `take_screenshot`'s missing `assertScriptableUrl`.** Its absence is a documented decision (capture mutates nothing) and `test/security-eval.test.mjs` asserts the screenshot still succeeds against a `chrome-extension://` target specifically so nobody tidies it away.

## Two deliberate deviations from the approved spec

Both are small, and both are written down here rather than made silently. Raise
them with the owner if either looks wrong.

1. **The panel keeps `protocol: 2`; the spec said bump it to 3.** `protocol`
   means "which server→panel EVENT shapes this panel understands", and images
   change none of them — `server/agent.js:554` is the only reader, and it asks
   `this.protocol < 2`. The real need is the opposite direction (can this
   *bridge* accept images), and `features` on `ready` answers exactly that. A
   version number nothing reads is worse than no version number: the next
   person has to work out that it means nothing before they can ignore it.

2. **The `imageCount` assertions live in `test/panel-stream.test.mjs`, not
   `test/panel-journal.test.mjs`.** The spec named the latter. But
   `panel-journal.test.mjs` tests the journal MODULE — push, resize, the entry
   and byte caps — while the property at stake here is what `sidepanel.js`
   records and re-renders, and `panel-stream.test.mjs` is the suite that drives
   `sidepanel.js` against a fake browser. Putting it there tests the behaviour;
   putting it in the other file would have tested that an object literal keeps
   its own fields.
