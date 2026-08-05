// attach_tab is the one deliberate way a tab outside the session's group gets
// in (see the comment on `attach_tab` in extension/background.js and on
// `attachPanelTab` in server/index.js). Getting its constraints wrong is the
// worst possible outcome for this codebase, so this proves them against real
// chrome.tabGroups/chrome.tabs/chrome.windows state rather than the
// handler's return value:
//
//   - attach_tab takes NO parameters. An earlier version accepted a
//     caller-supplied windowId, guarded against non-numeric values and
//     Chrome's window-id sentinels — but Chrome window ids are small
//     sequential integers, so a local process holding the panel token could
//     enumerate 1..N and pull an *arbitrary* window's active tab into its
//     group regardless of any guard on the value. The fix was removing the
//     parameter, not tightening its validation: the extension derives the
//     focused window itself, at handling time.
//   - the active tab of the FOCUSED window is pulled into the session's
//     group; switching focus between two windows and calling again acts on
//     the newly focused window's tab, never the other one — this is the
//     assertion that would fail if a caller-supplied id or windows.getAll()[0]
//     ever crept back in
//   - within that focused window, it is specifically the active tab, not
//     just the first tab in tab-strip order
//   - a browser-internal page (chrome://settings) is refused, not grouped
//   - a focused popup window is never acted on (windowTypes: ["normal"])
//
// Usage: HEADED=1 node test/attach-tab.test.mjs

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = join(root, "extension");

let failures = 0;
function check(name, cond, detail = "") {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userDataDir = mkdtempSync(join(tmpdir(), "cc-attachtab-"));
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: process.env.HEADED !== "1",
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ],
});

let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 });

// `handlers` and `sessionGroupTitle` are top-level bindings inside
// extension/background.js, evaluated by Playwright inside the service
// worker's own global scope — not identifiers this Node process defines.
/* eslint-disable no-undef -- handlers/sessionGroupTitle are service-worker globals, evaluated there by Playwright, not by this Node process */

// Calling handlers.attach_tab directly (not through handleRequest) skips the
// error->response translation handleRequest normally does, so wrap it the
// same way here: a throw becomes { ok: false, error }. No windowId is ever
// passed — the handler takes none.
const attachTab = async (session) =>
  await sw.evaluate(async (sess) => {
    try {
      return await handlers.attach_tab({ __session: sess });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }, session);

const sessionGroupTitleOf = async (session) => await sw.evaluate((s) => sessionGroupTitle(s), session);

/* eslint-enable no-undef */

// chrome.windows.update() returns once the change is applied, but this still
// polls chrome.windows.getLastFocused() to assert against real state rather
// than trusting the update call's own promise resolution — focus changes in
// a real browser are asynchronous and this is what the handler itself reads.
async function focusWindowAndWait(windowId) {
  await sw.evaluate(async (id) => { await chrome.windows.update(id, { focused: true }); }, windowId);
  for (let i = 0; i < 40; i++) {
    const lastFocused = await sw.evaluate(async () => (await chrome.windows.getLastFocused()).id);
    if (lastFocused === windowId) return true;
    await sleep(50);
  }
  return false;
}

const createWindow = async (url = "about:blank", extra = {}) =>
  await sw.evaluate(async ([u, opts]) => {
    const w = await chrome.windows.create({ url: u, focused: true, ...opts });
    return { windowId: w.id, tabId: w.tabs[0].id, type: w.type };
  }, [url, extra]);

// --- attach_tab follows FOCUS, not a fixed or first window -------------------
//
// The core constraint the whole redesign exists to prove: switching which
// window is focused switches which window's tab attach_tab acts on. A
// handler that ignored focus (a caller-supplied id, or windows.getAll()[0])
// would either always act on the same window or act on the wrong one here.

const SESSION_FOCUS = "aaaa-focus-follows-session";
const winA = await createWindow();
const winB = await createWindow();

const focusedA = await focusWindowAndWait(winA.windowId);
check("test harness can focus window A", focusedA);

const resultA = await attachTab(SESSION_FOCUS);
check("attach_tab (A focused) reports ok and A's active tab id", resultA.ok === true && resultA.tabId === winA.tabId, JSON.stringify(resultA));

const afterA = await sw.evaluate(async ([a, b]) => {
  const ta = await chrome.tabs.get(a);
  const tb = await chrome.tabs.get(b);
  return { aGroup: ta.groupId, bGroup: tb.groupId };
}, [winA.tabId, winB.tabId]);
check(
  "with A focused: A's active tab moved and B's active tab did not",
  afterA.aGroup >= 0 && afterA.bGroup === -1,
  JSON.stringify(afterA)
);

const focusedB = await focusWindowAndWait(winB.windowId);
check("test harness can focus window B", focusedB);

const resultB = await attachTab(SESSION_FOCUS);
check("attach_tab (B focused) reports ok and B's active tab id", resultB.ok === true && resultB.tabId === winB.tabId, JSON.stringify(resultB));

const afterB = await sw.evaluate(async ([a, b]) => {
  const ta = await chrome.tabs.get(a);
  const tb = await chrome.tabs.get(b);
  return { aGroup: ta.groupId, bGroup: tb.groupId };
}, [winA.tabId, winB.tabId]);
check(
  "with B focused (the reverse): B's active tab moved too, and A's earlier grouping was left untouched",
  afterB.bGroup >= 0 && afterB.aGroup === afterA.aGroup,
  JSON.stringify({ afterA, afterB })
);

const expectedTitleFocus = await sessionGroupTitleOf(SESSION_FOCUS);
const focusGroupTitles = await sw.evaluate(async ([a, b]) => {
  const ta = await chrome.tabs.get(a);
  const tb = await chrome.tabs.get(b);
  const ga = await chrome.tabGroups.get(ta.groupId);
  const gb = await chrome.tabGroups.get(tb.groupId);
  return { aTitle: ga.title, bTitle: gb.title };
}, [winA.tabId, winB.tabId]);
check(
  "both tabs, attached from different focused windows in the same session, land in the one group sessionGroupTitle() names",
  focusGroupTitles.aTitle === expectedTitleFocus && focusGroupTitles.bTitle === expectedTitleFocus,
  JSON.stringify({ focusGroupTitles, expectedTitleFocus })
);

// --- within the focused window: the ACTIVE tab, not just the first tab ------
//
// firstTabId is deliberately left as the window's first tab AND left
// inactive, while secondTabId is created after it and made active. A handler
// that did chrome.tabs.query({ windowId }) and took the first result — rather
// than filtering on `active: true` — would pass a test where the active tab
// happens to also be tab index 0. Only activating the *second* tab pins the
// actual constraint.

const SESSION_ACTIVE = "bbbb-active-not-first-session";
const winC = await createWindow();
await focusWindowAndWait(winC.windowId);
const firstTabId = winC.tabId;
const secondTabId = await sw.evaluate(async (windowId) => {
  // active: true (the default) — this is the tab attach_tab must pick.
  const t = await chrome.tabs.create({ windowId, url: "about:blank", active: true });
  return t.id;
}, winC.windowId);

const resultActive = await attachTab(SESSION_ACTIVE);
check(
  "attach_tab acts on the active (second, not first) tab of the focused window",
  resultActive.ok === true && resultActive.tabId === secondTabId,
  JSON.stringify(resultActive)
);

const firstGroupId = await sw.evaluate(async (id) => (await chrome.tabs.get(id)).groupId, firstTabId);
check(
  "the first tab in the window, which was never active, was NOT moved",
  firstGroupId === -1,
  String(firstGroupId)
);

// --- a browser-internal page is refused, not grouped -------------------------

const SESSION_INTERNAL = "cccc-browser-internal-session";
const winD = await createWindow("chrome://settings/");
await focusWindowAndWait(winD.windowId);
await sleep(500);

const resultInternal = await attachTab(SESSION_INTERNAL);
check(
  "a chrome:// page is refused rather than grouped",
  resultInternal.ok === false && /browser-internal page/.test(resultInternal.error || ""),
  JSON.stringify(resultInternal)
);
const settingsGroupId = await sw.evaluate(async (id) => (await chrome.tabs.get(id)).groupId, winD.tabId);
check("the refused chrome:// tab stayed ungrouped", settingsGroupId === -1, String(settingsGroupId));

// --- a focused popup window is never acted on --------------------------------
//
// windowTypes: ["normal"] on the chrome.windows.getLastFocused() call inside
// attach_tab means a devtools window or a popup cannot be selected even while
// focused. chrome.windows.create({ type: "popup" }) is a plain extension API
// call (not a Playwright-level browser window), so the test harness can
// exercise this directly.
//
// The popup is deliberately given a chrome:// page (not about:blank) so the
// discriminator runs through the REAL deployed handler instead of a
// standalone call to the same Chrome API the handler happens to use (which
// would pass even if windowTypes were silently dropped from
// extension/background.js, since it doesn't touch that file's code at all):
// if getLastFocused() ever picked the popup instead of skipping it,
// assertScriptableUrl would throw its distinct "browser-internal page"
// message. Any other outcome proves resolution landed on some other window.
//
// (Grouping winE's tab is not asserted to succeed here: while writing this
// case, a bare chrome.tabs.group() call on a backgrounded NORMAL window was
// observed to fail with Chrome's own "Grouping is not supported by tabs in
// this window." whenever a popup-type window currently holds OS focus — a
// real Chrome restriction unrelated to attach_tab, reproduced with no
// extension code involved. It fires for the correctly-resolved window too,
// so asserting end-to-end success would make this case fail for a reason
// that has nothing to do with whether the popup itself got selected.)

const SESSION_POPUP = "eeee-popup-session";
const winE = await createWindow();
await focusWindowAndWait(winE.windowId);

const popup = await createWindow("chrome://settings/", { type: "popup" });
check("test harness can create a popup window", popup.type === "popup", JSON.stringify(popup));

if (popup.type === "popup") {
  const focusedPopup = await focusWindowAndWait(popup.windowId);
  check("test harness can focus the popup window", focusedPopup);
  await sleep(500); // let chrome://settings/ actually finish loading in the popup

  const resultPopup = await attachTab(SESSION_POPUP);
  check(
    "attach_tab, called while the popup is focused, does not resolve to the popup's own chrome:// tab " +
    "(a dropped windowTypes filter would surface as a 'browser-internal page' refusal here)",
    !/browser-internal page/.test(resultPopup.error || ""),
    JSON.stringify(resultPopup)
  );
  check(
    "attach_tab never returns the popup's own tab id",
    resultPopup.tabId !== popup.tabId,
    JSON.stringify(resultPopup)
  );

  const popupTabGroupId = await sw.evaluate(async (id) => (await chrome.tabs.get(id)).groupId, popup.tabId);
  check(
    "the focused popup's own tab was NOT grouped as a side effect",
    popupTabGroupId === -1,
    String(popupTabGroupId)
  );
} else {
  console.log("SKIP  popup-window exclusion checks -- test harness could not create a popup window");
}

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
await context.close();
rmSync(userDataDir, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
