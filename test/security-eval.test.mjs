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
  // Asserting the message too, not just "it threw": otherwise an unrelated
  // future error out of navigate would masquerade as this guard firing.
  check("navigate's refusal names the browser-internal rule",
    /browser-internal page/.test(navigated.error || ""), navigated.error);

  const landed = await sw.evaluate(async (tid) => (await chrome.tabs.get(tid)).url, tabId);
  check("the tab did not move to the extension page", !landed.startsWith("chrome-extension://"), landed);

  // --- guard 1b: new_tab is the other door onto a tab's url ------------------
  // Blocking navigate alone leaves new_tab({url:"chrome-extension://…"}) as a
  // one-call way to put the extension's own page inside the session group.

  const openedInternal = await sw.evaluate(async ([session, id]) => {
    try {
      return { ok: true, value: await handlers.new_tab({ url: `chrome-extension://${id}/popup.html`, __session: session }) };
    } catch (e) { return { ok: false, error: e.message }; }
  }, [SESSION, extensionId]);
  check("new_tab refuses a chrome-extension:// url",
    openedInternal.ok === false && /browser-internal page/.test(openedInternal.error || ""),
    JSON.stringify(openedInternal));

  // The quiet half of the same door: chrome.tabs.create resolves a RELATIVE url
  // against the extension's own base, so this payload contains nothing
  // scheme-shaped and still used to open chrome-extension://<id>/popup.html.
  const openedRelative = await sw.evaluate(async (session) => {
    try {
      return { ok: true, value: await handlers.new_tab({ url: "popup.html", __session: session }) };
    } catch (e) { return { ok: false, error: e.message }; }
  }, SESSION);
  check("a relative new_tab url does not resolve to the extension's own page",
    !String(openedRelative.value?.url || "").startsWith("chrome-extension://"),
    JSON.stringify(openedRelative));

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

  // --- guard 2b: a tab that is merely on its way to an extension page --------
  // assertScriptableUrl read only tab.url, the snapshot resolveTab took. While
  // a navigation is in flight Chrome carries the destination in tab.pendingUrl
  // instead, and javascript_eval spends a whole chrome.debugger attach +
  // Runtime.enable in that window before the evaluate reaches the renderer —
  // with tool calls dispatched concurrently, that is a reachable race, not a
  // theoretical one. Driven against a synthetic tab record rather than a real
  // in-flight navigation so the assertion is deterministic: racing a real one
  // would pass or fail on timing, which is worse than not testing it.
  const pendingCase = await sw.evaluate((id) => {
    try {
      assertScriptableUrl({ url: "https://example.com/", pendingUrl: `chrome-extension://${id}/popup.html` });
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }, extensionId);

  // --- guard 3: the other two debugger tools that MUTATE the page -----------
  // press_key and type_text reach chrome.debugger exactly the way
  // javascript_eval did, so execInTab's guard never applied to them either.
  // Concretely: type_text into this extension's own "Địa chỉ MCP server" field
  // plus press_key Tab/Enter onto "Lưu & kết nối lại" repoints the bridge at an
  // arbitrary WebSocket endpoint, and that setting persists in chrome.storage —
  // a durable compromise, not a one-shot read.
  //
  // The tab is still parked on the extension page from guard 2 above, put there
  // with chrome.tabs.update inside the service worker, so none of this depends
  // on navigate or new_tab having a guard.

  const pressed = await sw.evaluate(async ([session, tid]) => {
    try {
      return { ok: true, value: await handlers.press_key({ tabId: tid, key: "Enter", __session: session }) };
    } catch (e) { return { ok: false, error: e.message }; }
  }, [SESSION, tabId]);

  const typed = await sw.evaluate(async ([session, tid]) => {
    try {
      return { ok: true, value: await handlers.type_text({ tabId: tid, text: "ws://attacker.example/ws", __session: session }) };
    } catch (e) { return { ok: false, error: e.message }; }
  }, [SESSION, tabId]);

  // take_screenshot deliberately has NO such guard, and this asserts the
  // decision rather than the absence of code: capturing pixels mutates nothing
  // and screenshotting an internal page is genuinely useful when diagnosing,
  // whereas injecting keystrokes into one has no legitimate use. Someone will
  // eventually notice the inconsistency and "fix" it — this check is what tells
  // them it was chosen.
  const shot = await sw.evaluate(async ([session, tid]) => {
    try {
      return { ok: true, value: await handlers.take_screenshot({ tabId: tid, __session: session }) };
    } catch (e) { return { ok: false, error: e.message }; }
  }, [SESSION, tabId]);

  /* eslint-enable no-undef */

  check("press_key is refused on an extension page",
    pressed.ok === false && /browser-internal page/.test(pressed.error || ""), JSON.stringify(pressed));
  check("type_text is refused on an extension page",
    typed.ok === false && /browser-internal page/.test(typed.error || ""), JSON.stringify(typed));
  check("take_screenshot on the same page still SUCCEEDS (deliberate asymmetry, not an oversight)",
    shot.ok === true && typeof shot.value?.base64 === "string" && shot.value.base64.length > 0,
    JSON.stringify({ ok: shot.ok, error: shot.error, base64Length: shot.value?.base64?.length }));

  check("a tab navigating to an extension page is not scriptable (pendingUrl, not just url)",
    pendingCase.ok === false && /browser-internal page/.test(pendingCase.error || ""),
    JSON.stringify(pendingCase));

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
