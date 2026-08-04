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

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
await context.close();
rmSync(userDataDir, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
