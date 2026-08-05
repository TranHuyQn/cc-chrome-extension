// attach_tab is the one deliberate way a tab outside the session's group gets
// in (see the comment on `attach_tab` in extension/background.js and on
// `attachPanelTab` in server/index.js). Getting its constraints wrong is the
// worst possible outcome for this codebase, so this proves them against real
// chrome.tabGroups/chrome.tabs state rather than the handler's return value:
//
//   - the ACTIVE tab of a given windowId is pulled into the session's group,
//     under the exact title sessionGroupTitle() derives for that session id
//   - a second, non-active tab in the same window is left alone — this is
//     what catches someone later adding tabId support to the handler
//   - a browser-internal page (chrome://settings) is refused, not grouped
//   - a missing or non-numeric windowId is rejected rather than silently
//     acting on some default window
//   - Chrome's window-id sentinels (WINDOW_ID_CURRENT = -2, WINDOW_ID_NONE =
//     -1) are rejected too: chrome.tabs.query() honours both, so a bare
//     Number.isInteger() guard lets them straight through to "some default
//     window" — exactly what this handler exists to refuse. Confirmed
//     against real Chromium: before the `windowId <= 0` guard was added,
//     `handlers.attach_tab({ windowId: -2 })` returned `{ ok: true, tabId:
//     ..., groupId: ... }` for the active tab of the *current* window, and
//     `windowId: -1` did the same.
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
// same way here: a throw becomes { ok: false, error }.
const attachTab = async (windowId, session) =>
  await sw.evaluate(
    async ([win, sess]) => {
      try {
        return await handlers.attach_tab({ windowId: win, __session: sess });
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
    [windowId, session]
  );

const sessionGroupTitleOf = async (session) => await sw.evaluate((s) => sessionGroupTitle(s), session);

/* eslint-enable no-undef */

// --- the active tab of a given window gets pulled into the session's group --

// sessionGroupTitle() derives the title from only the first 4 characters left
// after stripping dashes, so these must differ in their LEADING characters —
// a shared "attach-tab-session-" prefix would collapse every one of them into
// the same tab group title and silently defeat the isolation these checks
// are meant to prove.
const SESSION_A = "aaaa-attach-tab-session";
const expectedTitleA = await sessionGroupTitleOf(SESSION_A);

const win1 = await sw.evaluate(async (url) => {
  const w = await chrome.windows.create({ url, focused: true });
  return { windowId: w.id, tabId: w.tabs[0].id };
}, "about:blank");

const result1 = await attachTab(win1.windowId, SESSION_A);
check("attach_tab reports ok and the active tab's id", result1.ok === true && result1.tabId === win1.tabId, JSON.stringify(result1));

const grouped1 = await sw.evaluate(async (id) => {
  const t = await chrome.tabs.get(id);
  const g = t.groupId >= 0 ? await chrome.tabGroups.get(t.groupId) : null;
  return { groupId: t.groupId, groupTitle: g ? g.title : null };
}, win1.tabId);
check("real chrome.tabGroups state: the tab is actually grouped", grouped1.groupId >= 0, JSON.stringify(grouped1));
check(
  "the group's title is exactly what sessionGroupTitle() derives for this session id",
  grouped1.groupTitle === expectedTitleA,
  JSON.stringify({ got: grouped1.groupTitle, expected: expectedTitleA })
);

// --- only the ACTIVE tab moves, and specifically the active one, not just --
// --- "whichever tab query() returns first" ----------------------------------
//
// firstTabId is deliberately left as the window's first tab AND left
// inactive, while secondTabId is created after it and made active. A handler
// that did chrome.tabs.query({ windowId }) and took the first result — rather
// than filtering on `active: true` — would pass a test where the active tab
// happens to also be tab index 0. Only activating the *second* tab pins the
// actual constraint.

const SESSION_B = "bbbb-attach-tab-session";
const win2 = await sw.evaluate(async (url) => {
  const w = await chrome.windows.create({ url, focused: true });
  return { windowId: w.id, tabId: w.tabs[0].id };
}, "about:blank");
const firstTabId = win2.tabId;
const secondTabId = await sw.evaluate(async (windowId) => {
  // active: true (the default) — this is the tab attach_tab must pick.
  const t = await chrome.tabs.create({ windowId, url: "about:blank", active: true });
  return t.id;
}, win2.windowId);

const result2 = await attachTab(win2.windowId, SESSION_B);
check("attach_tab acts on the active (second, not first) tab of the window", result2.ok === true && result2.tabId === secondTabId, JSON.stringify(result2));

const firstGroupId = await sw.evaluate(async (id) => (await chrome.tabs.get(id)).groupId, firstTabId);
check(
  "the first tab in the window, which was never active, was NOT moved (would fail if tabId support were added, or if the handler took query()[0])",
  firstGroupId === -1,
  String(firstGroupId)
);

// --- a browser-internal page is refused, not grouped -------------------------

const SESSION_C = "cccc-attach-tab-session";
const win3 = await sw.evaluate(async (url) => {
  const w = await chrome.windows.create({ url, focused: true });
  return { windowId: w.id, tabId: w.tabs[0].id };
}, "chrome://settings/");
await sleep(500);

const result3 = await attachTab(win3.windowId, SESSION_C);
check(
  "a chrome:// page is refused rather than grouped",
  result3.ok === false && /browser-internal page/.test(result3.error || ""),
  JSON.stringify(result3)
);
const settingsGroupId = await sw.evaluate(async (id) => (await chrome.tabs.get(id)).groupId, win3.tabId);
check("the refused chrome:// tab stayed ungrouped", settingsGroupId === -1, String(settingsGroupId));

// --- a missing or non-numeric windowId is rejected, not defaulted -----------

const SESSION_D = "dddd-attach-tab-session";

const resultMissing = await attachTab(undefined, SESSION_D);
check(
  "a missing windowId is rejected with an error",
  resultMissing.ok === false && /numeric windowId/.test(resultMissing.error || ""),
  JSON.stringify(resultMissing)
);

const resultNonNumeric = await attachTab("not-a-window", SESSION_D);
check(
  "a non-numeric windowId is rejected with an error",
  resultNonNumeric.ok === false && /numeric windowId/.test(resultNonNumeric.error || ""),
  JSON.stringify(resultNonNumeric)
);

// Neither bad call should have created the group or grouped any tab under it.
const noGroupForD = await sw.evaluate(
  async (title) => (await chrome.tabGroups.query({ title })).length,
  await sessionGroupTitleOf(SESSION_D)
);
check("no group was silently created for the rejected calls", noGroupForD === 0, String(noGroupForD));

// --- Chrome's window-id sentinels are rejected, not honoured -----------------
//
// -2 is WINDOW_ID_CURRENT and -1 is WINDOW_ID_NONE. chrome.tabs.query() still
// honours both, so a guard that only checks Number.isInteger() lets a caller
// reach "whatever window Chrome considers current" or an arbitrary window's
// tab — silently acting on a default window is precisely what a windowId
// requirement is supposed to prevent. A dedicated window with a known active
// tab proves the negative: none of these calls may group it.

const SESSION_E = "eeee-attach-tab-session";
const winE = await sw.evaluate(async (url) => {
  const w = await chrome.windows.create({ url, focused: true });
  return { windowId: w.id, tabId: w.tabs[0].id };
}, "about:blank");

for (const bad of [-2, -1, 0, null]) {
  const r = await attachTab(bad, SESSION_E);
  check(
    `windowId ${JSON.stringify(bad)} is rejected rather than resolving to some other window`,
    r.ok === false && /numeric windowId/.test(r.error || ""),
    JSON.stringify(r)
  );
}

const winETabGroupId = await sw.evaluate(async (id) => (await chrome.tabs.get(id)).groupId, winE.tabId);
check(
  "none of the rejected sentinel/invalid windowIds grouped winE's active tab as a side effect",
  winETabGroupId === -1,
  String(winETabGroupId)
);

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
await context.close();
rmSync(userDataDir, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
