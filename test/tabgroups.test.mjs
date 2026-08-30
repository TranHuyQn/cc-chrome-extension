// Proves the assumption the whole 3.0.0 design rests on: chrome.tabGroups is
// available to this extension's service worker in the browser the tests use.
// If it is not, per-session tab groups cannot be verified automatically and
// the plan needs rethinking before any of it is built.
//
// Usage: HEADED=1 node test/tabgroups.test.mjs

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

const userDataDir = mkdtempSync(join(tmpdir(), "cc-tabgroups-"));
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

check("chrome.tabGroups exists in the service worker", await sw.evaluate(() => typeof chrome.tabGroups === "object"));
check("chrome.tabs.group exists", await sw.evaluate(() => typeof chrome.tabs.group === "function"));

const result = await sw.evaluate(async () => {
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
  await chrome.tabGroups.update(groupId, { title: "Claude · test", color: "orange" });
  const [found] = await chrome.tabGroups.query({ title: "Claude · test" });
  const after = await chrome.tabs.get(tab.id);
  return { groupId, foundId: found ? found.id : null, foundTitle: found ? found.title : null, tabGroupId: after.groupId };
});

check("tạo được group và gán tab vào", result.groupId >= 0 && result.tabGroupId === result.groupId, JSON.stringify(result));
check("query theo title tìm lại được group", result.foundId === result.groupId, JSON.stringify(result));
check("title đặt được", result.foundTitle === "Claude · test", String(result.foundTitle));

// A session's group must be dissolvable when the session dies -- and dissolving
// it must not touch the tabs. Chrome deletes a group when its last tab closes,
// so every group still on the tab strip has tabs in it; ungrouping is the only
// non-destructive way to clear one.
//
// chrome.tabGroups.TAB_GROUP_ID_NONE is -1 and is not reachable from this Node
// process, only from the service worker.
const TAB_GROUP_ID_NONE = -1;
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

const after = await sw.evaluate(async ([ids, title]) => {
  const out = [];
  for (const id of ids) {
    try {
      const t = await chrome.tabs.get(id);
      out.push({ id, groupId: t.groupId });
    } catch (e) {
      out.push({ id, gone: e.message });
    }
  }
  return { tabs: out, groups: (await chrome.tabGroups.query({ title })).length };
}, [[a.result.tabId, b.result.tabId], `Claude · ${SESSION.replace(/-/g, "").slice(0, 4)}`]);

check("the tabs are still open -- ungroup, never close",
  after.tabs.every((t) => !t.gone), JSON.stringify(after.tabs));
check("and no longer belong to any group",
  after.tabs.every((t) => t.groupId === TAB_GROUP_ID_NONE), JSON.stringify(after.tabs));
check("the group itself is gone from the tab strip", after.groups === 0, JSON.stringify(after));

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
await context.close();
rmSync(userDataDir, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
