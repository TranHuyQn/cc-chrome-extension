// Pins the escape that shipped in 3.3.0 and survived into 3.4.0: three ordinary
// tool calls reached the extension's own privileged realm and read every tab in
// the browser, defeating resolveTabInGroup entirely.
//
//   new_tab                                      -> tab lands in the session group
//   navigate chrome-extension://<id>/popup.html  -> navigate never checked the target
//   javascript_eval chrome.tabs.query({})        -> ran via chrome.debugger, so
//                                                   execInTab's guard never applied
//
// Both halves are asserted separately on purpose: removing either guard must
// turn this suite red on its own. Guard 2 is therefore reached by moving the
// tab onto the extension page with chrome.tabs.update directly, bypassing
// `navigate`, so guard 1 cannot shield it.
//
// Usage: HEADED=1 node test/security-eval.test.mjs

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

const userDataDir = mkdtempSync(join(tmpdir(), "cc-seceval-"));
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: process.env.HEADED !== "1",
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});

async function run() {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 });
  const extensionId = new URL(sw.url()).host;

  const SESSION = "aaaaaaaa-1111-2222-3333-444444444444";

  // `handlers` is a top-level binding inside extension/background.js, evaluated
  // by Playwright inside the service worker's own global scope — not an
  // identifier this Node process defines.
  /* eslint-disable no-undef -- handlers is a service-worker global, evaluated there by Playwright, not by this Node process */

  // Open a tab inside the session's own group, the way a model legitimately would.
  const opened = await sw.evaluate(async (session) => {
    try {
      return { ok: true, value: await handlers.new_tab({ url: "https://example.com/", __session: session }) };
    } catch (e) { return { ok: false, error: e.message }; }
  }, SESSION);
  check("new_tab opened a tab in the session group", opened.ok, JSON.stringify(opened));
  const tabId = opened.value?.tabId;

  // --- guard 1: navigate must refuse the extension's own origin --------------

  const navigated = await sw.evaluate(async ([session, tid, id]) => {
    try {
      return { ok: true, value: await handlers.navigate({ tabId: tid, url: `chrome-extension://${id}/popup.html`, __session: session }) };
    } catch (e) { return { ok: false, error: e.message }; }
  }, [SESSION, tabId, extensionId]);
  check("navigate refuses a chrome-extension:// target", navigated.ok === false, JSON.stringify(navigated));

  const landed = await sw.evaluate(async (tid) => (await chrome.tabs.get(tid)).url, tabId);
  check("the tab did not move to the extension page", !landed.startsWith("chrome-extension://"), landed);

  // --- guard 2: javascript_eval must refuse an extension page ---------------
  // Reached here by putting the tab on that page directly, bypassing `navigate`,
  // so this guard is proven on its own rather than shielded by guard 1.

  await sw.evaluate(async ([tid, id]) => {
    await chrome.tabs.update(tid, { url: `chrome-extension://${id}/popup.html` });
    await new Promise((r) => setTimeout(r, 1500));
  }, [tabId, extensionId]);

  const evaled = await sw.evaluate(async ([session, tid]) => {
    try {
      return { ok: true, value: await handlers.javascript_eval({ tabId: tid, code: "chrome.tabs.query({}).then(t => t.length)", __session: session }) };
    } catch (e) { return { ok: false, error: e.message }; }
  }, [SESSION, tabId]);

  /* eslint-enable no-undef */

  check("javascript_eval refuses an extension page", evaled.ok === false, JSON.stringify(evaled));
  check("the refusal names the browser-internal rule",
    /browser-internal page/.test(evaled.error || ""), evaled.error);
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
}
process.exit(failures === 0 ? 0 : 1);
