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
const TEST_PAGE = `<!DOCTYPE html>
<html><head><title>Focus test page</title></head>
<body>
<h1 style="color:#fff;background:#e8710a;padding:24px">Focus test page</h1>
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

  const shotResult = await callHandler("take_screenshot", { tabId: cTabId, __session: SESSION_SHOT });
  check("take_screenshot succeeded", shotResult.__ok === true, JSON.stringify(shotResult).slice(0, 300));

  const activeAfterShot = await activeTabIdOf(winShot.windowId);
  check(
    "take_screenshot (default branch) does not steal tab focus -- user's tab is still active",
    activeAfterShot === userTabId,
    `expected ${userTabId} (user's tab), got ${activeAfterShot} (session tab is ${cTabId})`
  );

  // Positive assertion: the fix must not turn take_screenshot into a no-op.
  const base64 = shotResult.__ok ? shotResult.result.base64 : "";
  check(
    "take_screenshot still returns a non-trivial base64 PNG",
    shotResult.__ok === true &&
      shotResult.result.mimeType === "image/png" &&
      shotResult.result.fullPage === false &&
      typeof base64 === "string" &&
      base64.length > 1000,
    `mimeType=${shotResult.result?.mimeType} fullPage=${shotResult.result?.fullPage} base64.length=${base64.length}`
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

  // Spy on chrome.windows.update in the service worker and capture the exact
  // arguments resize_window passes it. This is the deterministic half of the
  // proof: a throwaway probe run before this file was written found that in
  // THIS sandbox, chrome.windows.getLastFocused() never moves off whichever
  // window was last CREATED, no matter the technique tried against an OLDER
  // window afterwards -- chrome.windows.update({focused:true}) retried 20x,
  // chrome.windows.update({state:"normal"}) (the exact field under test)
  // retried, a real minimized->normal transition, and even Playwright's own
  // page.bringToFront(). chrome.windows.onFocusChanged only ever fired for
  // the two window-creation events, never for any post-hoc attempt. This
  // matches focus-investigation.md's own "Could not measure: OS-level
  // window-manager effects" caveat and CLAUDE.md's documented note that an
  // unattended headed run cannot reliably re-raise an older window -- it is
  // apparently absolute here, not just unreliable. So the OS-observable
  // "did the window actually get raised" side effect cannot be used as the
  // load-bearing assertion in this environment; inspecting the real argument
  // resize_window hands to the real chrome.windows.update (still exercising
  // the actual handler and the actual Chrome API, just observed one layer
  // earlier) is what can.
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

  // Informational only -- not counted towards pass/fail, see the long comment
  // above. Printed anyway so a run in an environment where OS-level window
  // focus IS observable (e.g. the one focus-investigation.md was measured in)
  // shows the corroborating evidence.
  const focusedAfterResize = await lastFocusedId();
  console.log(
    `INFO  chrome.windows.getLastFocused() after resize_window = ${focusedAfterResize} ` +
    `(winUser=${winUser.windowId}, winResize=${winResize.windowId}) -- informational only, not asserted`
  );

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
  // Not asserted here: that switch_tab also raises winResize's WINDOW to
  // last-focused. It does, per background.js:1361 and per
  // focus-investigation.md's measurement table ("switch_tab ... Yes
  // (intended)") -- but that is the same OS-level window-focus signal the
  // long comment above the resize_window spy explains this sandbox cannot
  // observe (chrome.windows.getLastFocused() never moved off the
  // last-CREATED window here, for ANY window-raise attempt, intended or not).
  // Pinning window-raise here would be just as unobservable as it was for
  // resize_window, for the same reason, so this sticks to the one exception
  // the task actually calls for: switch_tab must still change the active tab.

  const switchResult = await callHandler("switch_tab", { tabId: c2TabId, __session: SESSION_RESIZE });
  check("switch_tab succeeded", switchResult.__ok === true, JSON.stringify(switchResult));

  const activeAfterSwitch = await activeTabIdOf(winResize.windowId);
  check(
    "switch_tab DOES activate the target tab (the intended exception, still working after the fix)",
    activeAfterSwitch === c2TabId,
    `expected ${c2TabId}, got ${activeAfterSwitch}`
  );
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
