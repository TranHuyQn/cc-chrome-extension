# Orange Border Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Paint an orange frame inside the viewport of the tab Claude Code is driving, and let it disappear on its own ~2 seconds after Claude stops touching that tab.

**Architecture:** One injected page function paints (or refreshes) a shadow-DOM overlay and re-arms a self-destruct `setTimeout` **inside the page**, so the frame clears itself even when Chrome kills the MV3 service worker. The only call site is a thin wrapper around `resolveTab()` in `extension/background.js`, which every tool already routes through. `take_screenshot` suppresses the frame around the capture; `navigate` repaints after the load.

**Tech Stack:** Chrome MV3 extension (plain JS, no build step), `chrome.scripting.executeScript`, Playwright + a hand-rolled MCP stdio client in `test/e2e.mjs`.

**Spec:** `docs/superpowers/specs/2026-08-04-tab-border-indicator-design.md`

## Global Constraints

- No build step for `extension/` — plain JS loaded directly by Chrome. Never introduce one.
- Injected page functions may not use closures: inline every helper, wrap the whole body in `try/catch`, and return `{ __cc_err: e.message }` on failure.
- A failure to paint or clear the frame must never turn into a tool error and must never reword an existing error message.
- `resolveTab()`'s in-group security check is untouched. The frame is a side effect appended *after* a tab has been resolved and authorised.
- Frame colour is exactly `#E8710A`, border width exactly `3px`, idle timeout exactly `2000` ms.
- Element id is exactly `__cc_border`; the isolated-world timer handle is exactly `window.__cc_borderTimer`.
- Version 3.1.0 must appear in all three of `extension/manifest.json`, `server/index.js` (`VERSION`), `server/package.json`, or `test/build.test.mjs` fails.
- `npm run lint` must stay at 0 errors. A `PostToolUse` hook lints every `.js`/`.mjs` right after it is written; fix what it reports before moving on.
- Test command on macOS is `HEADED=1 npm run test:stdio` — **leave `CHROME_PATH` unset** (branded Chrome ≥137 ignores `--load-extension`; Playwright's bundled Chromium does not) and `HEADED=1` is required or the service worker never appears.
- Code, comments and commit messages in English. README and popup copy in Vietnamese.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `extension/background.js` | Border constants, the two injected page functions, `paintBorder`/`clearBorder`, the `resolveTab` wrapper, screenshot + navigate adjustments | Modify |
| `test/e2e.mjs` | End-to-end assertions: appears, self-expires, repaints after navigate/screenshot, never breaks about:blank | Modify |
| `extension/manifest.json`, `server/index.js`, `server/package.json`, `server/package-lock.json` | Version 3.1.0 | Modify |
| `README.md`, `CLAUDE.md` | User-facing explanation + the rule for future handlers | Modify |

No new files. `extension/background.js` is already the single place where injected page functions live; adding a third pair there follows the existing layout (constants at top, `pageXxx` functions in the "In-page functions" block, helpers above `handlers`).

---

### Task 1: Paint the frame from `resolveTab`, with a page-side self-destruct

**Files:**
- Modify: `extension/background.js` (constants near line 34; new page functions in the "In-page functions" section after `pageWaitCheck`, around line 799; new helpers + `resolveTab` wrapper around line 325)
- Test: `test/e2e.mjs` (new block inserted after the `take_screenshot fullPage` check, around line 248)

**Interfaces:**
- Consumes: existing `resolveTab(params)` logic, unchanged.
- Produces:
  - `BORDER_ID = "__cc_border"`, `BORDER_IDLE_MS = 2000`, `BORDER_COLOR = "#E8710A"` (module constants)
  - `pageShowBorder(id, idleMs, color)` / `pageHideBorder(id)` — injected page functions
  - `paintBorder(tabId)` — fire-and-forget, returns nothing, never rejects
  - `clearBorder(tabId)` — returns `Promise<void>`, never rejects; awaited by Task 2

- [ ] **Step 1: Write the failing test**

In `test/e2e.mjs`, insert this block immediately after the `check("take_screenshot fullPage", …)` line:

```js
// --- orange "Claude is driving this tab" border ---------------------------
// Observed through Playwright, not through javascript_eval: every tool call
// repaints the frame, so a tool-based probe could never see it expire.
const drivenPage = () =>
  context.pages().find((p) => p.url().startsWith(`http://127.0.0.1:${HTTP_PORT}`)) || null;

async function borderState() {
  const p = drivenPage();
  if (!p) return "no-page";
  return await p.evaluate(() => {
    const host = document.getElementById("__cc_border");
    if (!host) return "absent";
    if (host.parentElement !== document.documentElement) return "wrong-parent";
    if (!host.shadowRoot) return "no-shadow";
    const frame = host.shadowRoot.firstElementChild;
    if (!frame) return "no-frame";
    const s = getComputedStyle(frame);
    return s.borderTopWidth === "3px" && s.position === "fixed" && s.pointerEvents === "none"
      ? "present"
      : `bad-style:${s.borderTopWidth}/${s.position}/${s.pointerEvents}`;
  });
}

check("tìm được tab Claude đang lái để quan sát", drivenPage() !== null);

r = await client.callTool("read_page", {});
let border = await borderState();
check("khung cam xuất hiện khi Claude thao tác", border === "present", border);

// The frame lives outside <body> so it never shows up in read_page/get_page_text.
r = await client.callTool("get_page_text", {});
check("khung cam không lọt vào get_page_text", !toolText(r).includes("__cc_border"), toolText(r).slice(0, 200));

// Nothing must touch this tab during the wait, so the page-side timer fires.
await sleep(2600);
border = await borderState();
check("khung cam tự tắt sau ~2s không thao tác", border === "absent", border);

// A tab where injection is impossible must behave exactly as it did before:
// same error, no new failure mode from the painter.
const blankTab = JSON.parse(toolText(await client.callTool("new_tab", {})));
r = await client.callTool("read_page", { tabId: blankTab.tabId });
check(
  "about:blank giữ nguyên thông báo lỗi cũ",
  r.isError === true && toolText(r).includes("has no page open yet"),
  toolText(r).slice(0, 200)
);
await client.callTool("close_tab", { tabId: blankTab.tabId });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `HEADED=1 npm run test:stdio`
Expected: FAIL on `khung cam xuất hiện khi Claude thao tác` with detail `absent`. The `tự tắt` and `about:blank` checks pass already (nothing is painted yet) — that is fine, they are regression guards.

- [ ] **Step 3: Add the constants**

In `extension/background.js`, right after `const GROUP_COLOR = "orange";` (line 34):

```js
// Orange viewport frame that tells the user Claude is driving this tab.
// The idle timeout lives in the page (see pageShowBorder), not here: Chrome
// terminates this service worker at will, and a timer held on this side would
// leave a permanent ghost frame on the user's page every time that happens.
const BORDER_ID = "__cc_border";
const BORDER_IDLE_MS = 2000;
const BORDER_COLOR = "#E8710A";
```

- [ ] **Step 4: Add the injected page functions**

In `extension/background.js`, at the end of the "In-page functions" section (after `pageWaitCheck`, before `const handlers = {`):

```js
// Appended to documentElement, not body, so it stays out of read_page,
// get_page_text and find results. Styles are set property-by-property with
// "important" and no <style> element is inserted, so a page with a strict
// style-src CSP is unaffected. The shadow root keeps page CSS from restyling
// or hiding the frame.
function pageShowBorder(id, idleMs, color) {
  try {
    let host = document.getElementById(id);
    if (host && !host.shadowRoot) { host.remove(); host = null; }
    if (!host) {
      host = document.createElement("div");
      host.id = id;
      host.setAttribute("aria-hidden", "true");
      const frame = document.createElement("div");
      const style = {
        position: "fixed",
        top: "0",
        left: "0",
        right: "0",
        bottom: "0",
        border: `3px solid ${color}`,
        "box-sizing": "border-box",
        "box-shadow": "inset 0 0 0 1px rgba(0,0,0,0.15)",
        "pointer-events": "none",
        margin: "0",
        padding: "0",
        "z-index": "2147483647",
      };
      for (const prop of Object.keys(style)) frame.style.setProperty(prop, style[prop], "important");
      host.attachShadow({ mode: "open" }).appendChild(frame);
      document.documentElement.appendChild(host);
    }
    // window here is the isolated world's global, which persists between
    // executeScript calls on the same frame and is invisible to page scripts.
    clearTimeout(window.__cc_borderTimer);
    window.__cc_borderTimer = setTimeout(() => {
      const el = document.getElementById(id);
      if (el) el.remove();
    }, idleMs);
    return { shown: true };
  } catch (e) {
    return { __cc_err: e.message };
  }
}

function pageHideBorder(id) {
  try {
    clearTimeout(window.__cc_borderTimer);
    const el = document.getElementById(id);
    if (el) el.remove();
    return { hidden: true };
  } catch (e) {
    return { __cc_err: e.message };
  }
}
```

- [ ] **Step 5: Add the helpers and wrap `resolveTab`**

In `extension/background.js`, rename the existing `async function resolveTab(params)` (line 325) to `async function resolveTabInGroup(params)` — leave its body and its doc comment completely untouched — and add directly below it:

```js
// Painting is deliberately not awaited and its rejection is swallowed:
// chrome:// pages, the PDF viewer and about:blank cannot be injected into, and
// an indicator failure must never become a tool error.
function paintBorder(tabId) {
  chrome.scripting
    .executeScript({ target: { tabId }, func: pageShowBorder, args: [BORDER_ID, BORDER_IDLE_MS, BORDER_COLOR] })
    .catch(() => {});
}

// Awaited by take_screenshot, which must not capture the frame.
async function clearBorder(tabId) {
  await chrome.scripting
    .executeScript({ target: { tabId }, func: pageHideBorder, args: [BORDER_ID] })
    .catch(() => {});
}

// Every tool reaches its tab through here, so this wrapper is the only place
// the indicator has to be triggered — a new handler gets it by following the
// existing rule that it must call resolveTab().
async function resolveTab(params) {
  const tab = await resolveTabInGroup(params);
  paintBorder(tab.id);
  return tab;
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `HEADED=1 npm run test:stdio`
Expected: PASS on all four new checks (`khung cam xuất hiện`, `không lọt vào get_page_text`, `tự tắt sau ~2s`, `about:blank giữ nguyên thông báo lỗi cũ`) and no regression in the pre-existing checks. Watch the visible window: an orange frame should flash on the test page during the tool calls.

- [ ] **Step 7: Lint**

Run: `npm run lint`
Expected: 0 errors, 0 warnings.

- [ ] **Step 8: Commit**

```bash
git add extension/background.js test/e2e.mjs
git commit -m "Show an orange frame on the tab Claude is driving

The frame is painted from resolveTab, the one place every tool reaches its
tab through, and removes itself two seconds later from a timer held in the
page rather than in the service worker, so a worker Chrome terminates
mid-sequence cannot leave a ghost frame behind.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Keep the frame out of screenshots and restore it after navigation

**Files:**
- Modify: `extension/background.js` (`take_screenshot` handler around line 923, `navigate` handler around line 811)
- Test: `test/e2e.mjs` (extend the border block from Task 1)

**Interfaces:**
- Consumes: `paintBorder(tabId)` and `clearBorder(tabId)` from Task 1.
- Produces: no new symbols.

- [ ] **Step 1: Write the failing test**

In `test/e2e.mjs`, append to the border block, immediately after the `close_tab` line that ends Task 1's block:

```js
// Navigation destroys the DOM and the frame with it; an ongoing sequence must
// get it back.
await client.callTool("navigate", { url: `http://127.0.0.1:${HTTP_PORT}/` });
border = await borderState();
check("khung cam vẽ lại sau navigate", border === "present", border);

// take_screenshot removes the frame to capture a clean image, then repaints.
// Seeing it back afterwards is the observable proof the suppression ran: if
// the handler had not removed it, there would be nothing to repaint.
await client.callTool("take_screenshot", {});
border = await borderState();
check("khung cam vẽ lại sau screenshot (viewport)", border === "present", border);

await client.callTool("take_screenshot", { fullPage: true });
border = await borderState();
check("khung cam vẽ lại sau screenshot (fullPage)", border === "present", border);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `HEADED=1 npm run test:stdio`
Expected: FAIL on `khung cam vẽ lại sau navigate` with detail `absent` (`navigate` paints before it navigates, and the load wipes the frame). The two screenshot checks pass at this point — they only become meaningful once Step 3 lands, and they are what guards the repaint.

- [ ] **Step 3: Repaint after navigation**

In the `navigate` handler, the tail currently reads:

```js
    await waitForTabComplete(tab.id);
    await sleep(300);
    const updated = await chrome.tabs.get(tab.id);
```

Change it to:

```js
    await waitForTabComplete(tab.id);
    await sleep(300);
    // The load replaced the document, taking the frame with it.
    paintBorder(tab.id);
    const updated = await chrome.tabs.get(tab.id);
```

- [ ] **Step 4: Suppress the frame around both capture paths**

Replace the whole `take_screenshot` handler body with:

```js
  async take_screenshot(params) {
    const tab = await resolveTab(params);
    // Screenshots are used to inspect real visual defects (spacing, colour,
    // overflow). A fake orange edge in every image would corrupt that, so the
    // frame comes off for the capture and goes straight back on.
    if (params.fullPage) {
      await ensureDebugger(tab.id, ["Page"]);
      await clearBorder(tab.id);
      try {
        const shot = await cdp(tab.id, "Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: true,
        });
        return { mimeType: "image/png", base64: shot.data, fullPage: true };
      } finally {
        paintBorder(tab.id);
      }
    }
    await chrome.tabs.update(tab.id, { active: true });
    await clearBorder(tab.id);
    await sleep(150);
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      return { mimeType: "image/png", base64: dataUrl.split(",", 2)[1], fullPage: false };
    } finally {
      paintBorder(tab.id);
    }
  },
```

`clearBorder` is awaited before `sleep(150)` on the viewport path so the compositor has settled by the time the capture runs. `finally` repaints even when the capture throws, otherwise a failed screenshot would silently leave the user's tab unmarked while Claude keeps working.

- [ ] **Step 5: Run the test to verify it passes**

Run: `HEADED=1 npm run test:stdio`
Expected: PASS on all three new checks plus everything from Task 1, and `take_screenshot viewport` / `take_screenshot fullPage` still PASS.

- [ ] **Step 6: Lint**

Run: `npm run lint`
Expected: 0 errors, 0 warnings.

- [ ] **Step 7: Commit**

```bash
git add extension/background.js test/e2e.mjs
git commit -m "Keep the driving frame out of screenshots and restore it after navigation

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Release as 3.1.0

**Files:**
- Modify: `extension/manifest.json:4`, `server/index.js:45`, `server/package.json:3`, `server/package-lock.json`
- Test: `test/build.test.mjs` (existing, no edits)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `VERSION === "3.1.0"`, reported by `chrome_status` and used to name build artifacts.

A minor bump, not a patch: the keepalive incident showed that shipping a visible behaviour change under an unchanged version leaves the server unable to tell which build a user is running.

- [ ] **Step 1: Write the failing test**

No new test — `test/build.test.mjs` already fails when the three version strings drift. Make it fail on purpose by bumping only the manifest:

In `extension/manifest.json`, change `"version": "3.0.0"` to `"version": "3.1.0"`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:build`
Expected: FAIL, reporting a version mismatch between `extension/manifest.json` and `server/index.js` / `server/package.json`.

- [ ] **Step 3: Bump the remaining two and refresh the lock**

In `server/index.js` line 45: `const VERSION = "3.1.0";`
In `server/package.json` line 3: `"version": "3.1.0",`

Then:

```bash
cd server && npm install --package-lock-only && cd ..
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:build`
Expected: PASS.

Run: `grep -c '"version": "3.1.0"' server/package-lock.json`
Expected: at least `1` (the root package entry carries the version).

- [ ] **Step 5: Commit**

```bash
git add extension/manifest.json server/index.js server/package.json server/package-lock.json
git commit -m "Release 3.1.0

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Document it, then verify the screenshots by eye

**Files:**
- Modify: `README.md` (the section describing how a session and its tab group work), `CLAUDE.md` (the "Adding or changing a browser tool" section)

**Interfaces:**
- Consumes: the behaviour shipped in Tasks 1–3.
- Produces: no code.

- [ ] **Step 1: Document the frame for users**

In `README.md`, find the section that explains the per-session tab group (search for `Claude ·`) and add, in Vietnamese, after the explanation of the orange tab group:

```markdown
Trong lúc Claude thao tác, tab đó còn được viền một khung cam mỏng quanh khung
nhìn. Khung tự biến mất khoảng 2 giây sau khi Claude ngừng đụng vào tab, nên khi
không thấy khung nghĩa là không có lệnh nào đang chạy trên tab đó. Khung do
extension vẽ đè lên trang, không phải lỗi hiển thị của website, không nhận chuột
và không lọt vào ảnh `take_screenshot`. Một số trang extension không chèn được
(`chrome://`, trình xem PDF, tab trắng `about:blank`) sẽ không có khung.
```

- [ ] **Step 2: Document the rule for future handlers**

In `CLAUDE.md`, in the "Adding or changing a browser tool" section, extend the paragraph about `resolveTab(params)` with:

```markdown
`resolveTab()` also paints the orange "Claude is driving this tab" frame, so a handler that
uses it gets the indicator for free and must not paint one itself. The frame removes itself
~2s later from a timer held in the page — never move that timer into the service worker,
Chrome terminates the worker mid-sequence and a ghost frame would survive on the user's page.
A handler that captures pixels must call `await clearBorder(tab.id)` before the capture and
`paintBorder(tab.id)` in a `finally`, the way `take_screenshot` does.
```

- [ ] **Step 3: Run the whole suite**

Run: `HEADED=1 npm test`
Expected: `ALL TESTS PASSED` from every suite (build, origin, e2e stdio, e2e http).

- [ ] **Step 4: Manual check — the one thing the suite cannot assert**

The test suite has no PNG decoder, so "the captured image carries no orange edge" must be confirmed by eye, once. Reload the extension in Chrome (`chrome://extensions` → reload), reconnect with `/ccchrome connect` if needed, then:

1. `navigate` to any plain page with a white background.
2. While a short sequence of tool calls is running, confirm visually that the orange frame is drawn and stays steady rather than blinking per call.
3. Stop issuing calls, count ~2 seconds, confirm the frame disappears on its own.
4. Take a screenshot through `take_screenshot` and look at the returned image: it must have no orange edge on any side.

Record the outcome of all four in the report. If step 4 shows an orange edge, the capture is racing the removal — the fix is in Task 2's ordering, not a longer sleep.

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "Document the driving-tab frame and the rule for new handlers

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```
