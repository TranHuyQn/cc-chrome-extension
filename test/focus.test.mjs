// The owner's whole requirement for the session's tab group is that it runs
// silently: driving a tab in it must never disturb whatever he is doing in
// another tab or window. focus-investigation.md (measurement-only, throwaway
// probe, no production code touched) found exactly two violations among the
// 22 handlers -- take_screenshot's default (non-fullPage) branch activates
// the target tab, and resize_window unconditionally raises the target's
// window -- plus one handler, switch_tab, whose whole job IS to steal both,
// on purpose. This suite proves all three against the real handlers, not
// against a description of them: same technique test/attach-tab.test.mjs
// uses (call handlers.<name>(...) directly in the service worker, bypassing
// the websocket), same launch args as its sibling suites.
//
// Usage: HEADED=1 node test/focus.test.mjs

import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = join(root, "extension");
const HTTP_PORT = 8936; // distinct from e2e.mjs (8931) and panel-protocol.test.mjs (8793)

let failures = 0;
function check(name, cond, detail = "") {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A real page with some visible content, not about:blank -- take_screenshot's
// positive assertion needs a non-trivial PNG, and a flat blank page compresses
// too well to prove much either way.
// margin:0 on body matters: without it the browser's default ~8px body
// margin pushes the header's actual top-left away from device-pixel (0,0),
// which cost a false-red the first time this was run at a devicePixelRatio
// > 1 (sampling landed just above the header, in the default white margin,
// not in a bug).
const TEST_PAGE = `<!DOCTYPE html>
<html><head><title>Focus test page</title><style>body{margin:0}</style></head>
<body>
<h1 style="color:#fff;background:#e8710a;padding:24px;margin:0">Focus test page</h1>
<p>Some paragraph text so the rendered pixels are not a flat fill.</p>
<div style="height:400px;background:linear-gradient(45deg,#123,#e8710a)"></div>
</body></html>`;

const httpServer = createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(TEST_PAGE);
});
await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));
const TEST_URL = `http://127.0.0.1:${HTTP_PORT}/`;

const userDataDir = mkdtempSync(join(tmpdir(), "cc-focus-"));
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

  // Calling handlers.<name> directly (not through handleRequest) skips the
  // error->response translation handleRequest normally does, so wrap it the
  // same way test/attach-tab.test.mjs does: a throw becomes { __ok:false }.
  /* eslint-disable no-undef -- handlers is a service-worker global, evaluated there by Playwright, not by this Node process */
  const callHandler = async (name, params) =>
    await sw.evaluate(async ([n, p]) => {
      try {
        return { __ok: true, result: await handlers[n](p) };
      } catch (e) {
        return { __ok: false, error: e.message };
      }
    }, [name, params]);
  /* eslint-enable no-undef */

  // Window creation reliably wins chrome.windows.getLastFocused() on this
  // platform even when the OS itself isn't giving the Chromium app focus;
  // re-focusing an OLDER window via chrome.windows.update() does not (see the
  // long comment on focusWindowAndWait in test/attach-tab.test.mjs). So every
  // window this suite needs "focused" is created that way, in the order that
  // makes it the newest -- nothing here fights that constraint by trying to
  // re-focus an older window from the harness side.
  async function waitForLastFocused(windowId) {
    for (let i = 0; i < 40; i++) {
      const lastFocused = await sw.evaluate(async () => (await chrome.windows.getLastFocused()).id);
      if (lastFocused === windowId) return true;
      await sleep(50);
    }
    return false;
  }

  const createWindow = async (url = "about:blank") =>
    await sw.evaluate(async (u) => {
      const w = await chrome.windows.create({ url: u, focused: true });
      return { windowId: w.id, tabId: w.tabs[0].id };
    }, url);

  const activeTabIdOf = async (windowId) =>
    await sw.evaluate(async (id) => {
      const [t] = await chrome.tabs.query({ windowId: id, active: true });
      return t ? t.id : null;
    }, windowId);

  const lastFocusedId = async () => await sw.evaluate(async () => (await chrome.windows.getLastFocused()).id);

  // The `focused` field on an individual chrome.windows.Window is a stricter,
  // OS-driven signal than chrome.windows.getLastFocused()/onFocusChanged --
  // this sandbox was found (throwaway probe, before this file was written) to
  // report getLastFocused() as some real window id at all times, yet EVERY
  // window's own `focused` field reads false throughout a run, never true,
  // even right after chrome.windows.create({focused:true}). So `focused`
  // tells us whether the OS has actually handed this Chromium process real
  // window-manager focus at all -- which decides whether a window-raise
  // side effect can be observed here, whether it's the bug's or a legitimate
  // one's. See the long comment further down for what this gates.
  const anyWindowReallyFocused = async () =>
    (await sw.evaluate(async () => (await chrome.windows.getAll()).map((w) => w.focused))).some(Boolean);

  // Decodes a captured screenshot back into pixels using a real <canvas> in
  // whichever Chromium page Playwright already has open -- data: URIs decode
  // in any page regardless of that page's own origin, so which page is used
  // doesn't matter. This is the same technique test/e2e.mjs's pngHasOrange
  // helper uses, just sampling a specific pixel instead of scanning for one
  // colour.
  const decodePngPixel = async (base64, x, y) => {
    const page = context.pages()[0];
    /* eslint-disable no-undef -- browser globals, evaluated inside the page by Playwright, not by this Node process */
    return await page.evaluate(async ([b64, px, py]) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const [r, g, b, a] = ctx.getImageData(Math.min(px, w - 1), Math.min(py, h - 1), 1, 1).data;
      return { width: w, height: h, pixel: [r, g, b, a] };
    }, [base64, x, y]);
    /* eslint-enable no-undef */
  };

  // ===========================================================================
  // take_screenshot (default, non-fullPage branch) must not steal TAB focus
  // ===========================================================================
  //
  // background.js:1230 (pre-fix) does chrome.tabs.update(tab.id,{active:true})
  // before chrome.tabs.captureVisibleTab, because that API can only capture
  // the visible (active) tab of a window -- so it always yanks whatever other
  // tab the user had open in that same window to the front first.

  const SESSION_SHOT = "aaaa-focus-screenshot-session";
  const winShot = await createWindow();
  check("winShot is last-focused right after creation", await waitForLastFocused(winShot.windowId));

  const shotTab = await callHandler("new_tab", { url: TEST_URL, __session: SESSION_SHOT });
  check("session tab (C) created and grouped", shotTab.__ok === true, JSON.stringify(shotTab));
  const cTabId = shotTab.result.tabId;

  // The stand-in for "what the user is doing" -- a second, unrelated tab in
  // the SAME window, made active. take_screenshot's steal (per the
  // investigation) is scoped to the tab within its own window, not the
  // window itself, so this is where it has to be observed.
  const userTabId = await sw.evaluate(async (windowId) => {
    const t = await chrome.tabs.create({ windowId, url: "about:blank", active: true });
    return t.id;
  }, winShot.windowId);
  await sleep(100);
  const activeBeforeShot = await activeTabIdOf(winShot.windowId);
  check("user's tab is active before take_screenshot", activeBeforeShot === userTabId, `got ${activeBeforeShot}`);

  // The real expectation to check the captured PNG against, read from the
  // actual page before the capture: its CSS viewport size and device pixel
  // ratio. CDP Page.captureScreenshot returns physical pixels, so the PNG's
  // own dimensions should equal viewport size * dpr (not a hardcoded
  // 1280x720 -- that would just be a second guess, no more "expected" than
  // the number this is replacing).
  const shotViewport = await sw.evaluate(async (tabId) => {
    /* eslint-disable no-undef -- `func` below runs injected into the page by chrome.scripting, not in this file's scope */
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio }),
    });
    /* eslint-enable no-undef */
    return result;
  }, cTabId);

  const shotResult = await callHandler("take_screenshot", { tabId: cTabId, __session: SESSION_SHOT });
  check("take_screenshot succeeded", shotResult.__ok === true, JSON.stringify(shotResult).slice(0, 300));

  const activeAfterShot = await activeTabIdOf(winShot.windowId);
  check(
    "take_screenshot (default branch) does not steal tab focus -- user's tab is still active",
    activeAfterShot === userTabId,
    `expected ${userTabId} (user's tab), got ${activeAfterShot} (session tab is ${cTabId})`
  );

  // Positive assertions: the fix must not turn take_screenshot into a no-op,
  // and it must be proven BY THE PIXELS, not by base64 length -- a fully
  // blank 1280x720 PNG was measured (independent review) at 27,780 base64
  // characters, 27x a bare ">1000" threshold, so length alone would have let
  // a screenshot that captures nothing pass silently. TEST_PAGE's #e8710a
  // header exists specifically so there is a known colour to check for.
  const base64 = shotResult.__ok ? shotResult.result.base64 : "";
  check(
    "take_screenshot still returns a base64 PNG",
    shotResult.__ok === true &&
      shotResult.result.mimeType === "image/png" &&
      shotResult.result.fullPage === false &&
      typeof base64 === "string" &&
      base64.length > 1000,
    `mimeType=${shotResult.result?.mimeType} fullPage=${shotResult.result?.fullPage} base64.length=${base64.length}`
  );

  // CSS point (15,15) -- comfortably inside the header's 24px padding, now
  // that TEST_PAGE zeroes the default body margin -- converted to device
  // pixels via the same dpr the dimensions check above already validated.
  const decodedShot = shotResult.__ok
    ? await decodePngPixel(base64, Math.round(15 * shotViewport.dpr), Math.round(15 * shotViewport.dpr))
    : null;
  check(
    "the PNG's own dimensions match the captured tab's real viewport (device pixels = CSS viewport * dpr), " +
    "not a blank/stub-sized image",
    !!decodedShot &&
      decodedShot.width > 0 &&
      decodedShot.height > 0 &&
      decodedShot.width === Math.round(shotViewport.width * shotViewport.dpr) &&
      decodedShot.height === Math.round(shotViewport.height * shotViewport.dpr),
    JSON.stringify({ decodedShot, shotViewport })
  );
  check(
    "a pixel near the top-left decodes to the #e8710a header background TEST_PAGE actually served " +
    "on the SESSION tab -- not blank, and not the user's about:blank tab",
    !!decodedShot &&
      Math.abs(decodedShot.pixel[0] - 0xe8) <= 8 &&
      Math.abs(decodedShot.pixel[1] - 0x71) <= 8 &&
      Math.abs(decodedShot.pixel[2] - 0x0a) <= 8,
    `pixel=${JSON.stringify(decodedShot && decodedShot.pixel)}`
  );

  // ===========================================================================
  // resize_window must not steal WINDOW focus
  // ===========================================================================
  //
  // background.js:1419-1423 (pre-fix) sends state:"normal" unconditionally on
  // every call; the investigation isolated that field alone as what raises a
  // background window, 3/3, even when the window is already normal.

  const SESSION_RESIZE = "bbbb-focus-resize-session";
  const winResize = await createWindow(); // holds the session tab (C2); the resize target
  check("winResize is last-focused right after creation", await waitForLastFocused(winResize.windowId));

  const resizeTab = await callHandler("new_tab", { url: TEST_URL, __session: SESSION_RESIZE });
  check("session tab (C2) created and grouped", resizeTab.__ok === true, JSON.stringify(resizeTab));
  const c2TabId = resizeTab.result.tabId;

  // The stand-in for "what the user is doing" -- a SEPARATE window, created
  // (and thus focused) after winResize, so it is unambiguously the
  // last-focused window before resize_window is ever called.
  const winUser = await createWindow();
  check("winUser is last-focused right after creation, ahead of winResize", await waitForLastFocused(winUser.windowId));
  const userTabId2 = await activeTabIdOf(winUser.windowId);

  // Read the regime BEFORE calling resize_window: does the OS currently give
  // this Chromium process real window-manager focus at all? See
  // anyWindowReallyFocused() above for what this checks and why it's a
  // different, stricter signal than getLastFocused().
  const focusIsObservableHere = await anyWindowReallyFocused();

  // Spy on chrome.windows.update in the service worker and capture the exact
  // arguments resize_window passes it. This is the deterministic half of the
  // proof, and it is the one that always gates pass/fail here: whether the
  // window-raise side effect is OS-observable in a given run turns out to be
  // environment-dependent, not absolute. A throwaway probe run before this
  // file was written found chrome.windows.getLastFocused() never moving off
  // whichever window was last CREATED in this particular sandbox, no matter
  // the technique tried against an older window afterwards. But
  // focus-investigation.md's own raw probe output (same Chrome 151, a
  // different run) shows the opposite: focusedWindowId DID move onto the
  // target window, 3/3, isolated to state:"normal" alone. Both were honest --
  // the raise is real and happens exactly when the OS has actually handed
  // the Chromium process real window-manager focus, and invisible otherwise;
  // nothing inside the test gets to choose which regime a given run lands in
  // (see anyWindowReallyFocused() above). So the argument resize_window
  // actually hands to the real chrome.windows.update -- still the real
  // handler calling the real Chrome API, just observed one layer earlier
  // than its OS-level side effect -- is the assertion that cannot go green
  // for the wrong reason regardless of which regime this run is in.
  await sw.evaluate(() => {
    globalThis.__updateCalls = [];
    globalThis.__origWindowsUpdate = chrome.windows.update;
    chrome.windows.update = (...args) => {
      globalThis.__updateCalls.push(args[1]);
      return globalThis.__origWindowsUpdate.apply(chrome.windows, args);
    };
  });

  const RESIZE_W = 900;
  const RESIZE_H = 700;
  const resizeResult = await callHandler("resize_window", {
    tabId: c2TabId,
    width: RESIZE_W,
    height: RESIZE_H,
    __session: SESSION_RESIZE,
  });
  check("resize_window succeeded", resizeResult.__ok === true, JSON.stringify(resizeResult));

  await sleep(300); // give any focus-stealing side effect time to land, for the informational check below

  const updateCalls = await sw.evaluate(() => globalThis.__updateCalls);
  await sw.evaluate(() => { chrome.windows.update = globalThis.__origWindowsUpdate; });

  check(
    "resize_window does not send state:\"normal\" unconditionally to a window that " +
    "is not minimized -- that field alone is what the investigation isolated as the cause of the steal",
    updateCalls.length >= 1 && updateCalls.every((u) => u.state !== "normal"),
    JSON.stringify(updateCalls)
  );

  // Conditional on the regime read before the call: when the OS is actually
  // giving this Chromium process real focus, the window-raise side effect IS
  // observable (per focus-investigation.md's own measurement) and gets
  // asserted for real, on top of the deterministic spy check above. When it
  // isn't (this sandbox, so far, every run), the effect cannot be observed by
  // definition, so this costs nothing to attempt and is skipped rather than
  // asserted false-negative.
  if (focusIsObservableHere) {
    const focusedAfterResize = await lastFocusedId();
    check(
      "resize_window does not steal window focus -- winUser is still last-focused",
      focusedAfterResize === winUser.windowId,
      `expected ${winUser.windowId} (winUser), got ${focusedAfterResize} (resize target window is ${winResize.windowId})`
    );
  } else {
    console.log(
      "SKIP  resize_window window-focus effect check -- this run's Chromium process does not currently hold " +
      "real OS-level window focus (chrome.windows.getAll() reports no window with focused:true), so the raise " +
      "this fix removes would not be observable here even if it still happened; see anyWindowReallyFocused()."
    );
  }

  const activeAfterResize = await activeTabIdOf(winUser.windowId);
  check(
    "resize_window leaves the user's active tab alone",
    activeAfterResize === userTabId2,
    `expected ${userTabId2}, got ${activeAfterResize}`
  );

  // Positive assertion: resize_window must still actually resize the window.
  const winResizeBounds = await sw.evaluate(async (id) => {
    const w = await chrome.windows.get(id);
    return { width: w.width, height: w.height, state: w.state };
  }, winResize.windowId);
  check(
    "resize_window still actually resizes the (background) window",
    winResizeBounds.width === RESIZE_W && winResizeBounds.height === RESIZE_H,
    JSON.stringify(winResizeBounds)
  );

  // The minimized case, briefly: a fix that just deletes the `state` field
  // outright (rather than sending it conditionally) would silently leave a
  // minimized window stuck minimized -- the opposite failure mode. Confirm
  // resize_window still un-minimizes a window that genuinely is minimized.
  const winMin = await createWindow();
  const minTab = await callHandler("new_tab", { url: TEST_URL, __session: SESSION_RESIZE });
  check("session tab for the minimized-window case created and grouped", minTab.__ok === true, JSON.stringify(minTab));
  await sw.evaluate(async (id) => { await chrome.windows.update(id, { state: "minimized" }); }, winMin.windowId);
  await sleep(200);
  const minResult = await callHandler("resize_window", {
    tabId: minTab.result.tabId,
    width: RESIZE_W,
    height: RESIZE_H,
    __session: SESSION_RESIZE,
  });
  check("resize_window succeeded on a minimized window", minResult.__ok === true, JSON.stringify(minResult));
  // The state transition lands asynchronously after chrome.windows.update()
  // resolves (confirmed with a throwaway probe: the update call's own
  // returned window object still reported "minimized" while a get() a moment
  // later already read "normal"), so this polls rather than reading once.
  let winMinState = "minimized";
  for (let i = 0; i < 20 && winMinState === "minimized"; i++) {
    await sleep(100);
    winMinState = await sw.evaluate(async (id) => (await chrome.windows.get(id)).state, winMin.windowId);
  }
  check(
    "resize_window still un-minimizes a genuinely minimized window",
    winMinState !== "minimized",
    `state=${winMinState}`
  );

  // ===========================================================================
  // switch_tab is the pinned EXCEPTION: it must keep stealing tab focus, on purpose
  // ===========================================================================
  //
  // Changing which tab is active is switch_tab's entire job. A later
  // "consistency" pass that made every handler focus-free, this one included,
  // would break the tool silently -- none of the assertions above would ever
  // notice, since they only ever check that focus did NOT move. This is what
  // would catch that.
  //
  // Reuses winResize/c2TabId from the resize_window case above, which is
  // currently the background window with an inactive session tab.
  //
  // The task only requires pinning the tab-activation half (below), which is
  // asserted unconditionally. switch_tab also raises winResize's WINDOW to
  // last-focused -- per background.js:1361 and per focus-investigation.md's
  // measurement table ("switch_tab ... Yes (intended)") -- and that half is
  // asserted too, but only when this run's regime can show it: see
  // anyWindowReallyFocused() and the long comment above the resize_window
  // spy for why that side effect is environment-dependent rather than
  // something this test can force.
  const switchFocusObservable = await anyWindowReallyFocused();

  const switchResult = await callHandler("switch_tab", { tabId: c2TabId, __session: SESSION_RESIZE });
  check("switch_tab succeeded", switchResult.__ok === true, JSON.stringify(switchResult));

  const activeAfterSwitch = await activeTabIdOf(winResize.windowId);
  check(
    "switch_tab DOES activate the target tab (the intended exception, still working after the fix)",
    activeAfterSwitch === c2TabId,
    `expected ${c2TabId}, got ${activeAfterSwitch}`
  );

  if (switchFocusObservable) {
    const raisedWindow = await waitForLastFocused(winResize.windowId);
    check(
      "switch_tab DOES also raise the target tab's window (the intended exception, observable in this run's regime)",
      raisedWindow,
      `winResize (${winResize.windowId}) never became last-focused`
    );
  } else {
    console.log(
      "SKIP  switch_tab window-raise effect check -- this run's Chromium process does not currently hold " +
      "real OS-level window focus, so this exception's window-raise half would not be observable here either."
    );
  }
}

try {
  await run();
} catch (err) {
  failures++;
  console.log(`CRASH  ${err && err.stack ? err.stack : String(err)}`);
} finally {
  console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
  await context.close().catch(() => {});
  rmSync(userDataDir, { recursive: true, force: true });
  httpServer.close();
}
process.exit(failures === 0 ? 0 : 1);
