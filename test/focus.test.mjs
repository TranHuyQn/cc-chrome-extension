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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
<!-- Targets for the all-handlers sweep at the end of this file. They sit
     BELOW the header on purpose: the screenshot assertion samples a pixel at
     the top-left and must keep landing in the #e8710a header. -->
<button id="btn">Click me</button>
<input id="name"><input id="email"><input type="file" id="up">
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
  // Decoded once for its dimensions, then re-sampled at the scale the image
  // itself proves. The page's own devicePixelRatio is NOT authoritative here:
  // measured on this machine, a tab reported dpr 1 while CDP captured at 2 —
  // the window had landed on the Retina display rather than the external one,
  // and a background tab's reading does not have to match the display its
  // pixels are finally rasterised for. That made this assertion fail on a
  // capture that was entirely correct (the sampled pixel was the right colour).
  //
  // So the property asserted is the one actually under test — the PNG is the
  // captured viewport, not a blank or stub-sized image — expressed as: both
  // axes scale from the CSS viewport by the SAME integer factor between 1 and
  // 3. A stub of any other size fails that; a legitimate 1x or 2x capture
  // passes it on either display.
  const firstDecode = shotResult.__ok ? await decodePngPixel(base64, 0, 0) : null;
  const scaleX = firstDecode ? firstDecode.width / shotViewport.width : 0;
  const scaleY = firstDecode ? firstDecode.height / shotViewport.height : 0;
  check(
    "the PNG's own dimensions are the captured tab's viewport at a whole-number device scale, " +
    "not a blank/stub-sized image",
    !!firstDecode &&
      Number.isInteger(scaleX) && scaleX >= 1 && scaleX <= 3 &&
      scaleY === scaleX,
    JSON.stringify({ firstDecode, shotViewport, scaleX, scaleY })
  );
  if (firstDecode && scaleX !== shotViewport.dpr) {
    console.log(
      `NOTE  the page reported devicePixelRatio ${shotViewport.dpr} but the capture is ${scaleX}x ` +
      "-- a display mismatch, not a capture fault; the pixel sample below uses the capture's own scale."
    );
  }
  const decodedShot = firstDecode
    ? await decodePngPixel(base64, Math.round(15 * scaleX), Math.round(15 * scaleX))
    : null;
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

  // Positive assertion, deterministic half: a "fix" that stopped resizing
  // altogether -- dropping width/height along with `state` -- must be caught
  // everywhere, including on a machine whose window manager overrides bounds.
  // This reads the same spy as the check above, so it is the real guard.
  check(
    "resize_window still asks Chrome for the requested width and height",
    updateCalls.some((u) => u.width === RESIZE_W && u.height === RESIZE_H),
    JSON.stringify(updateCalls)
  );

  // Positive assertion, OS-observable half: the window really ends up that
  // size. This is the one part of the suite the machine's window manager gets
  // a vote in -- macOS 26 tiles Chrome's windows on its own as soon as a few
  // exist (measured on the machine this was written against: full-height
  // columns, 500x1169 at left 480/960/1440 on a 1920x1200 display), and a
  // tiled window ignores bounds changes: Chrome accepts the width/height,
  // returns no error, and nothing moves. That is the environment, not this
  // branch's fix -- the pre-fix handler (unconditional state:"normal") misses
  // the same assertion identically on the same machine.
  //
  // So a mismatch is not reported until a CONTROL has separated the two
  // causes: ask chrome.windows.update for a distinctive size DIRECTLY, with no
  // handler in the path. If the direct call cannot move the window either, the
  // window manager is deciding the bounds and there is nothing here to assert;
  // if it CAN, then the API works on this machine and resize_window failing to
  // use it is a real bug, reported as one. Only ever runs after the mismatch,
  // i.e. exactly when the window is already pinned by the WM, and it sends
  // width/height only -- never `state` -- so it cannot raise a window ahead of
  // the switch_tab section below (bounds alone raise nothing; that is
  // focus-investigation.md's isolated finding and what this suite pins).
  const PROBE_W = 640;
  const PROBE_H = 480;
  const winResizeBounds = await sw.evaluate(async (id) => {
    const w = await chrome.windows.get(id);
    return { width: w.width, height: w.height, state: w.state };
  }, winResize.windowId);
  if (winResizeBounds.width === RESIZE_W && winResizeBounds.height === RESIZE_H) {
    check("resize_window still actually resizes the (background) window", true);
  } else {
    const directResizeWorks = await sw.evaluate(async ([id, pw, ph, settle]) => {
      const before = await chrome.windows.get(id);
      await chrome.windows.update(id, { width: pw, height: ph });
      // Settle before reading, for the same span the assertion above waited.
      // A tiled window accepts the new bounds and reports them back
      // immediately -- measured: an immediate get() returns the requested
      // 640x480 -- and only snaps back to its tile a moment later (measured:
      // 500x1169 again 500ms on, same left/top). Reading without this wait is
      // what made an earlier version of this control claim the window manager
      // was innocent.
      await new Promise((r) => setTimeout(r, settle));
      const after = await chrome.windows.get(id);
      await chrome.windows.update(id, { width: before.width, height: before.height });
      return after.width === pw && after.height === ph;
    }, [winResize.windowId, PROBE_W, PROBE_H, 500]);
    if (directResizeWorks) {
      check(
        "resize_window still actually resizes the (background) window",
        false,
        `${JSON.stringify(winResizeBounds)} -- and a direct chrome.windows.update({width:${PROBE_W},height:${PROBE_H}}) ` +
        "on the same window DID move it, so the window manager is not what stopped resize_window"
      );
    } else {
      console.log(
        "SKIP  resize_window real-bounds check -- this machine's window manager pins this window's bounds: a direct " +
        `chrome.windows.update({width:${PROBE_W},height:${PROBE_H}}), with no handler in the path, could not move it ` +
        `either (window is ${winResizeBounds.width}x${winResizeBounds.height}). macOS 26 window tiling does this. The ` +
        "requested-size assertion above is what gates this case here."
      );
    }
  }

  // The minimized case, briefly: a fix that just deletes the `state` field
  // outright (rather than sending it conditionally) would silently leave a
  // minimized window stuck minimized -- the opposite failure mode. Confirm
  // resize_window still un-minimizes a window that genuinely is minimized.
  const winMin = await createWindow();
  const minTab = await callHandler("new_tab", { url: TEST_URL, __session: SESSION_RESIZE });
  check("session tab for the minimized-window case created and grouped", minTab.__ok === true, JSON.stringify(minTab));
  // Park it at the top-left corner while it is still normal. Chrome validates
  // the RESULT of a bounds update against the visible screen and refuses
  // anything that would sit more than half off it ("Bounds must be at least 50%
  // within visible screen space") — and where the window manager has parked
  // these windows varies by run and by which display is attached (measured:
  // full-height columns 1169px tall on one run, 948px on another after the
  // external monitor changed). Without this, the resize_window call below is
  // refused for a reason that has nothing to do with what this case tests,
  // which is that a minimized window still gets state:"normal".
  await sw.evaluate(async (id) => { await chrome.windows.update(id, { left: 0, top: 0 }); }, winMin.windowId);
  await sw.evaluate(async (id) => { await chrome.windows.update(id, { state: "minimized" }); }, winMin.windowId);
  // Poll, don't sleep: the minimize lands asynchronously and a fixed 200ms was
  // measured too short here. resize_window reads chrome.windows.get() to decide
  // whether to send state:"normal", so calling it while Chrome still reports
  // the window as "normal" means the field is (correctly, on that reading)
  // omitted -- and Chrome then rejects the bounds of a window that is on its
  // way off-screen with "Bounds must be at least 50% within visible screen
  // space", which looks exactly like a broken handler and is not one.
  let winMinReady = "normal";
  for (let i = 0; i < 40 && winMinReady !== "minimized"; i++) {
    winMinReady = await sw.evaluate(async (id) => (await chrome.windows.get(id)).state, winMin.windowId);
    if (winMinReady !== "minimized") await sleep(50);
  }
  check("the window under test really is minimized before resize_window is called", winMinReady === "minimized", `state=${winMinReady}`);
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
  // The exception is now NARROW, and the narrowing is the point. switch_tab
  // may change which TAB is active inside its own window -- that is the whole
  // tool. It may not raise that window over whatever application the owner is
  // actually looking at. Earlier revisions of this file pinned the window
  // raise as intended behaviour, on the strength of focus-investigation.md's
  // measurement table ("switch_tab ... Yes (intended)"); the owner ruled that
  // the raise is a defect, not a feature, so the assertion is inverted here
  // rather than deleted -- a later "restore the old behaviour" edit has to
  // fail a test to land.
  const switchFocusObservable = await anyWindowReallyFocused();
  const lastFocusedBeforeSwitch = await lastFocusedId();

  await sw.evaluate(() => {
    globalThis.__switchCalls = [];
    globalThis.__origWindowsUpdateSwitch = chrome.windows.update;
    chrome.windows.update = (...args) => {
      globalThis.__switchCalls.push(args[1]);
      return globalThis.__origWindowsUpdateSwitch.apply(chrome.windows, args);
    };
  });

  const switchResult = await callHandler("switch_tab", { tabId: c2TabId, __session: SESSION_RESIZE });
  check("switch_tab succeeded", switchResult.__ok === true, JSON.stringify(switchResult));

  const switchCalls = await sw.evaluate(() => globalThis.__switchCalls);
  await sw.evaluate(() => { chrome.windows.update = globalThis.__origWindowsUpdateSwitch; });

  const activeAfterSwitch = await activeTabIdOf(winResize.windowId);
  check(
    "switch_tab DOES activate the target tab (the narrow exception, and the tool's entire job)",
    activeAfterSwitch === c2TabId,
    `expected ${c2TabId}, got ${activeAfterSwitch}`
  );

  // Deterministic half: the raise is gone from the arguments, so this holds on
  // every machine regardless of whether the effect would have been visible.
  check(
    "switch_tab does not ask Chrome to focus the window (no chrome.windows.update({focused:true}))",
    switchCalls.every((u) => !u || u.focused !== true),
    JSON.stringify(switchCalls)
  );

  if (switchFocusObservable) {
    check(
      "switch_tab does not raise the target tab's window over the user's",
      (await lastFocusedId()) === lastFocusedBeforeSwitch,
      `last-focused moved from ${lastFocusedBeforeSwitch} to ${await lastFocusedId()} (switch target window is ${winResize.windowId})`
    );
  } else {
    console.log(
      "SKIP  switch_tab window-raise effect check -- this run's Chromium process does not currently hold " +
      "real OS-level window focus, so a raise would not be observable here. The argument assertion above " +
      "gates this case instead."
    );
  }

  // ===========================================================================
  // SWEEP: no handler at all may activate a tab or raise a window
  // ===========================================================================
  //
  // The three cases above were found by reading all 22 handlers by hand. That
  // method is what classified switch_tab's window raise as intended for two
  // revisions, and it has to be repeated in full every time a handler is
  // added. This sweep asserts the property directly against every handler
  // instead, and fails when a NEW handler is added without being listed here
  // (see the coverage check below) -- so the guarantee cannot quietly decay.
  //
  // Deterministic half: one spy over chrome.tabs.update and
  // chrome.windows.update. A handler is caught by the arguments it passes,
  // whether or not this machine's window manager would have shown the effect
  // (macOS 26 tiling, and the OS-focus regime described above, make the
  // visible effect unreliable -- the arguments are not).
  //
  // switch_tab is the single exception and it is narrow: it may activate its
  // own target tab; it still may not raise a window.
  const SESSION_SWEEP = "cccc-focus-sweep-session";
  const winSweepSession = await createWindow();
  check("sweep session window created", typeof winSweepSession.windowId === "number");
  const sweepTab = await callHandler("new_tab", { url: TEST_URL, __session: SESSION_SWEEP });
  check("sweep session tab created and grouped", sweepTab.__ok === true, JSON.stringify(sweepTab));
  const sweepTabId = sweepTab.result.tabId;
  // close_tab needs its own victim: closing sweepTabId would strand the rest.
  const doomedTab = await callHandler("new_tab", { url: TEST_URL, __session: SESSION_SWEEP });
  check("sweep throwaway tab created", doomedTab.__ok === true, JSON.stringify(doomedTab));

  // The owner's window, created last so it is unambiguously last-focused, and
  // given a second tab so that a handler activating "some other tab in this
  // window" is visible rather than a no-op.
  const winSweepUser = await createWindow();
  const userSecondTab = await sw.evaluate(async ([winId, url]) => {
    const t = await chrome.tabs.create({ windowId: winId, url, active: true });
    return t.id;
  }, [winSweepUser.windowId, TEST_URL]);
  check("owner's window is last-focused before the sweep", await waitForLastFocused(winSweepUser.windowId));
  const userActiveBefore = await activeTabIdOf(winSweepUser.windowId);
  check("owner's second tab is the active one before the sweep", userActiveBefore === userSecondTab,
    `expected ${userSecondTab}, got ${userActiveBefore}`);

  const uploadPath = join(userDataDir, "focus-sweep-upload.txt");
  writeFileSync(uploadPath, "focus sweep fixture\n");

  // resize_window is called with the window's CURRENT size: this sweep is
  // about focus, not geometry, and a different size can be refused outright
  // ("Bounds must be at least 50% within visible screen space") depending on
  // where the window manager has parked the window -- measured on macOS 26,
  // which tiles these windows. A no-op resize still runs the whole handler,
  // which is what the focus assertions below need. Real resizing has its own
  // dedicated case earlier in this file.
  // Resolved lazily, immediately before the call, and not from a value read
  // when the sweep was built: Chrome refuses ANY bounds update -- a same-size
  // one included -- when the resulting rect would sit more than half
  // off-screen, and macOS 26's tiling moves these windows around while the
  // sweep runs. Measured: the window read left:22 top:52 1282x846 when the
  // sweep was built and the call ~19 handlers later was still refused with
  // "Bounds must be at least 50% within visible screen space". So park the
  // window at a known-good origin first, then ask for the size it actually
  // has. Geometry is not what this sweep asserts -- running the handler is.
  const resizeParams = async () => {
    const w = await sw.evaluate(async (id) => {
      try {
        await chrome.windows.update(id, { left: 0, top: 0 });
      } catch {
        // Parking is best effort; the assertion below reports the real bounds.
      }
      const win = await chrome.windows.get(id);
      return { width: win.width, height: win.height, left: win.left, top: win.top };
    }, winSweepSession.windowId);
    return { tabId: t, width: w.width, height: w.height, __bounds: w };
  };

  const t = sweepTabId;
  const SWEEP = [
    ["status", {}],
    ["list_tabs", {}],
    ["read_page", { tabId: t }],
    ["get_page_text", { tabId: t }],
    ["find", { query: "Focus", tabId: t }],
    ["wait_for", { selector: "h1", tabId: t }],
    ["scroll", { direction: "down", tabId: t }],
    ["click", { selector: "#btn", tabId: t }],
    ["fill", { selector: "#name", value: "abc", tabId: t }],
    ["fill_form", { fields: [{ selector: "#email", value: "a@b.c" }], tabId: t }],
    ["javascript_eval", { code: "1+1", tabId: t }],
    ["press_key", { key: "Escape", tabId: t }],
    ["type_text", { text: "hi", tabId: t }],
    ["upload_file", { selector: "#up", filePath: uploadPath, tabId: t }],
    ["read_console_messages", { tabId: t }],
    ["read_network_requests", { tabId: t }],
    ["take_screenshot", { tabId: t }],
    ["navigate", { url: TEST_URL, tabId: t }],
    ["resize_window", resizeParams],
    ["new_tab", { url: TEST_URL }],
    ["switch_tab", { tabId: t }],
    ["close_tab", { tabId: doomedTab.result.tabId }],
    // Last on purpose: it dissolves SESSION_SWEEP's own group, so anything
    // above it that expects that group to exist must already have run.
    ["release_session_group", {}],
  ];

  // Coverage, read off the live handlers object rather than a list kept by
  // hand: adding a handler without adding it here fails right here.
  /* eslint-disable no-undef -- handlers is a service-worker global */
  const allHandlers = await sw.evaluate(() => Object.keys(handlers));
  /* eslint-enable no-undef */
  const uncovered = allHandlers.filter((h) => h !== "attach_tab" && !SWEEP.some(([n]) => n === h));
  check(
    "the sweep covers every handler in background.js (attach_tab excluded: not an MCP tool, panel-only)",
    uncovered.length === 0,
    `not covered: ${uncovered.join(", ")}`
  );

  await sw.evaluate(() => {
    globalThis.__sweepCalls = [];
    globalThis.__origTabsUpdateSweep = chrome.tabs.update;
    globalThis.__origWindowsUpdateSweep = chrome.windows.update;
    chrome.tabs.update = (...args) => {
      globalThis.__sweepCalls.push({ api: "tabs.update", target: args[0], props: args[1] });
      return globalThis.__origTabsUpdateSweep.apply(chrome.tabs, args);
    };
    chrome.windows.update = (...args) => {
      globalThis.__sweepCalls.push({ api: "windows.update", target: args[0], props: args[1] });
      return globalThis.__origWindowsUpdateSweep.apply(chrome.windows, args);
    };
  });

  for (const [method, paramsOrFn] of SWEEP) {
    const params = typeof paramsOrFn === "function" ? await paramsOrFn() : paramsOrFn;
    const { __bounds, ...callParams } = params; // diagnostics only, never sent
    await sw.evaluate(() => { globalThis.__sweepCalls = []; });
    const res = await callHandler(method, { ...callParams, __session: SESSION_SWEEP });
    const calls = await sw.evaluate(() => globalThis.__sweepCalls);

    // A handler that threw would make every assertion below vacuously true.
    check(
      `sweep: ${method} ran`,
      res.__ok === true,
      `${JSON.stringify(res)}${__bounds ? ` (window was at ${JSON.stringify(__bounds)})` : ""}`
    );

    const activated = calls.filter((c) => c.api === "tabs.update" && c.props && c.props.active === true);
    const raised = calls.filter(
      (c) => c.api === "windows.update" && c.props && (c.props.focused === true || c.props.state === "normal")
    );
    // No window in this sweep is minimized, so state:"normal" here is a raise
    // and nothing else -- resize_window's legitimate un-minimise path has its
    // own dedicated case earlier in this file.
    check(`sweep: ${method} does not raise a window`, raised.length === 0, JSON.stringify(raised));
    if (method === "switch_tab") {
      check(
        "sweep: switch_tab activates only its own target tab (the one allowed exception)",
        activated.length === 1 && activated[0].target === t,
        JSON.stringify(activated)
      );
    } else {
      check(`sweep: ${method} does not activate any tab`, activated.length === 0, JSON.stringify(activated));
    }

    const userActiveNow = await activeTabIdOf(winSweepUser.windowId);
    check(
      `sweep: ${method} leaves the owner's active tab alone`,
      userActiveNow === userActiveBefore,
      `expected ${userActiveBefore}, got ${userActiveNow}`
    );
  }

  await sw.evaluate(() => {
    chrome.tabs.update = globalThis.__origTabsUpdateSweep;
    chrome.windows.update = globalThis.__origWindowsUpdateSweep;
  });
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
