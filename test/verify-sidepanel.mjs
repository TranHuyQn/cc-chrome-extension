// Manual verification for the side panel chat UI (extension/sidepanel.{html,js}),
// run against a real bridge in http mode and a real Chromium with the extension
// loaded. NOT part of `npm test`: unlike every other suite in this directory it
// spawns the real `claude` CLI (no test/fake-claude*.mjs stand-in) for the live
// chat sections, so it costs real API usage, needs a machine that is actually
// logged in, and is not deterministic enough to run unattended in CI.
//
// Playwright cannot drive an actual Chrome side-panel host, but it CAN
// navigate an ordinary tab straight to the panel's own extension-origin page
// (chrome-extension://<id>/sidepanel.html) -- same origin, same script, same
// socket logic. This proves the socket, hello/ready handshake, reconnect
// path, and a real chat turn end-to-end. It does not and cannot prove
// chrome.sidePanel.open() itself or the popup's "Mở khung chat" button --
// those need the side-panel host, which is a manual step (see
// .superpowers/sdd/2026-08-05-sidepanel-chat/task-6-manual-acceptance.md).
//
// A few sections drive extension/sidepanel.js's top-level `handle()` function
// directly (it is a plain global in a classic, non-module script, so
// `window.handle` inside the page) to reproduce specific event orderings a
// live model call may not happen to produce on any given run -- these cost no
// tokens and need no server turn at all.
//
// Usage: npm run verify:sidepanel   (headed is baked into that npm script --
//   see package.json -- because on macOS the extension's service worker never
//   appears in headless mode; running this file directly needs HEADED=1).
//   macOS: CHROME_PATH must stay unset -- see CLAUDE.md.
//
// The whole run past server-health/context-launch is wrapped in
// try/catch/finally: a crash mid-suite must still print a summary and still
// kill the spawned bridge process and clean up the Chromium profile, not leak
// port 8787 and a temp dir into the next run (see test/attach-tab.test.mjs for
// the same pattern and the leak it was written to fix).

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = join(REPO, "extension");
const MCP_PORT = 8787;
const TOKEN = "paneltoken12345";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, detail = "") {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}

const serverProc = spawn("node", [join(REPO, "server", "index.js"), "--http"], {
  env: {
    ...process.env,
    CC_CHROME_TOKENS: `${TOKEN}=huy`,
    CC_CHROME_HOST: "127.0.0.1",
  },
  stdio: ["ignore", "inherit", "inherit"],
});

let healthy = false;
for (let i = 0; i < 40; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${MCP_PORT}/health`);
    if (res.ok) { healthy = true; break; }
  } catch {}
  await sleep(250);
}
check("bridge /health", healthy);
if (!healthy) { serverProc.kill(); process.exit(1); }

let userDataDir;
let context;

async function run() {
  userDataDir = mkdtempSync(join(tmpdir(), "cc-bridge-panel-e2e-"));
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: process.env.HEADED !== "1",
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 });
  const extensionId = new URL(sw.url()).host;
  check("service worker present, extension id resolved", !!extensionId, extensionId);

  // --- F2: a token-less wsUrl must never open a WebSocket at all --------------
  // The stdio bridge's default URL (ws://127.0.0.1:9876) has no /panel routing
  // at all -- dialing /panel there lands straight in the extension bridge's
  // own connection handler and evicts the real extension socket, and the 4004
  // refusal made for exactly this class of mistake never fires, because stdio
  // has no route to refuse it from. Proven here without a real server on the
  // other end (nothing is listening on 9876 in this test) and without
  // reproducing the eviction itself: patch the page's own WebSocket
  // constructor before sidepanel.js runs and assert it is never called. This
  // is also the truest reproduction of the bug -- a brand new profile has
  // never written chrome.storage.local.wsUrl, so it falls back to
  // DEFAULT_WS_URL exactly the way a first-time user's panel would.
  const noTokenPage = await context.newPage();
  /* eslint-disable no-undef -- browser globals, evaluated inside the page by Playwright, not by this Node process */
  await noTokenPage.addInitScript(() => {
    window.__wsConstructCount = 0;
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args) {
        window.__wsConstructCount++;
        return Reflect.construct(target, args);
      },
    });
  });
  /* eslint-enable no-undef */
  await noTokenPage.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await sleep(1000); // give connect() a chance to run -- and, pre-fix, to actually dial
  /* eslint-disable no-undef */
  const wsAttempts = await noTokenPage.evaluate(() => window.__wsConstructCount);
  /* eslint-enable no-undef */
  check("F2: a token-less wsUrl (the stdio default) never opens a WebSocket at all", wsAttempts === 0, `constructed ${wsAttempts} times`);
  const dotClassNoToken = await noTokenPage.getAttribute("#dot", "class");
  check("F2: dot stays 'disconnected' for a token-less URL (never flashes 'connecting')", dotClassNoToken === "dot disconnected", dotClassNoToken);
  const noTokenLog = await noTokenPage.textContent("#log");
  check("F2: the log explains the http-bridge/token requirement in Vietnamese, pointing at the popup", /token/.test(noTokenLog) && /popup/.test(noTokenLog), noTokenLog);
  await noTokenPage.close();

  // From here on, point the extension at the real bridge for the live-chat
  // sections. Also clear any stale panel session id from a previous run of
  // this script (a fresh userDataDir normally makes this a no-op).
  await sw.evaluate(async (wsUrl) => {
    await chrome.storage.local.set({ wsUrl });
  }, `ws://127.0.0.1:${MCP_PORT}/ws?token=${TOKEN}`);
  await sw.evaluate(async () => {
    await chrome.storage.local.remove(["panelSessionId", "panelModel"]);
  });

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  // --- 1: connects, hello/ready handshake, dot turns green --------------------
  await page.waitForSelector("#dot.connected", { timeout: 15000 }).catch(() => {});
  const dotClass = await page.getAttribute("#dot", "class");
  check("panel connects (dot green)", dotClass === "dot connected", dotClass);

  let groupText = "";
  for (let i = 0; i < 20; i++) {
    groupText = await page.textContent("#group");
    if (groupText && groupText.trim()) break;
    await sleep(250);
  }
  check("ready carries a groupTitle, shown in header", /^Claude · [0-9a-f]{4}$/.test(groupText || ""), groupText);

  // --- 2: a real chat turn streams text ---------------------------------------
  await page.fill("#input", "Nói \"xin chào\" bằng một câu ngắn, không dùng tool nào.");
  await page.press("#input", "Enter");

  await page.waitForSelector(".msg.user", { timeout: 5000 });
  const userMsg = await page.textContent(".msg.user");
  check("user message rendered", userMsg.includes("xin chào"), userMsg);

  // wait for turn_end: stop button goes back to disabled
  /* eslint-disable no-undef -- browser globals, evaluated inside the page by Playwright, not by this Node process */
  await page.waitForFunction(() => document.getElementById("stop").disabled === true, { timeout: 60000 }).catch(() => {});
  /* eslint-enable no-undef */
  const stopDisabledAfter = await page.getAttribute("#stop", "disabled");
  check("turn completes (stop re-disabled)", stopDisabledAfter !== null);

  const assistantMsgs = await page.$$eval(".msg.assistant", (els) => els.map((e) => e.textContent));
  check("assistant produced a reply", assistantMsgs.length > 0 && assistantMsgs[assistantMsgs.length - 1].trim().length > 0, JSON.stringify(assistantMsgs));

  const errorMsgs = await page.$$eval(".msg.error", (els) => els.map((e) => e.textContent));
  check("no error rendered during the turn", errorMsgs.length === 0, JSON.stringify(errorMsgs));

  console.log("\n--- transcript ---");
  console.log("user:", userMsg);
  console.log("assistant:", assistantMsgs.join("\n"));
  console.log("errors:", JSON.stringify(errorMsgs));
  console.log("------------------\n");

  // --- 3: stop mid-turn ---------------------------------------------------------
  await page.fill("#input", "Đếm chậm rãi từ 1 đến 50, mỗi số một dòng, đừng dùng tool nào.");
  await page.press("#input", "Enter");
  /* eslint-disable no-undef -- browser globals, evaluated inside the page by Playwright, not by this Node process */
  await page.waitForFunction(() => document.getElementById("stop").disabled === false, { timeout: 15000 });
  await sleep(300); // let a little streaming happen before stopping
  await page.click("#stop");
  await page.waitForFunction(() => document.getElementById("stop").disabled === true, { timeout: 15000 });
  /* eslint-enable no-undef */
  const errorMsgsAfterStop = await page.$$eval(".msg.error", (els) => els.map((e) => e.textContent));
  check("stop produces the expected error line", errorMsgsAfterStop.some((t) => t.includes("đã dừng theo yêu cầu")), JSON.stringify(errorMsgsAfterStop));

  // --- 4: attach_tab ------------------------------------------------------------
  // Deliberately do NOT bring the panel's own tab to the front here: a real side
  // panel is not a tab and never competes for chrome.tabs' "active" flag, so the
  // fair simulation is leaving example.com as the active tab and clicking the
  // button on the (backgrounded, from Chrome's point of view) panel tab via CDP.
  const otherPage = await context.newPage();
  await otherPage.goto("https://example.com/");
  await sleep(500);
  await page.click("#attach");
  /* eslint-disable no-undef -- browser globals, evaluated inside the page by Playwright, not by this Node process */
  await page.waitForFunction(
    () => [...document.querySelectorAll(".tool, .msg.error")].some((e) => e.textContent.includes("Đã đưa vào phiên") || e.textContent.includes("Không đưa được")),
    { timeout: 10000 }
  );
  /* eslint-enable no-undef */
  const attachMsgs = await page.$$eval(".tool, .msg.error", (els) => els.map((e) => e.textContent));
  const attachLine = attachMsgs.find((t) => t.includes("Đã đưa vào phiên") || t.includes("Không đưa được"));
  check("attach_tab_result rendered", !!attachLine, JSON.stringify(attachMsgs));
  console.log("attach_tab result:", attachLine);
  await otherPage.close();

  // --- 5: session persists across reopen (proves --resume) --------------------
  const storedSessionId = await sw.evaluate(async () => (await chrome.storage.local.get("panelSessionId")).panelSessionId);
  check("panelSessionId persisted to storage", !!storedSessionId, storedSessionId);

  await page.close();
  const page2 = await context.newPage();
  await page2.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page2.waitForSelector("#dot.connected", { timeout: 15000 });
  await page2.fill("#input", "Câu đầu tiên tôi nhờ bạn nói là câu gì? Trả lời ngắn gọn, không dùng tool nào.");
  await page2.press("#input", "Enter");
  // Wait for busy to actually flip on, then off -- checking only "disabled ===
  // true" races the button's own default-disabled markup when the predicate
  // happens to run before turn_start has fired.
  /* eslint-disable no-undef -- browser globals, evaluated inside the page by Playwright, not by this Node process */
  await page2.waitForFunction(() => document.getElementById("stop").disabled === false, { timeout: 15000 });
  await page2.waitForFunction(() => document.getElementById("stop").disabled === true, { timeout: 60000 });
  /* eslint-enable no-undef */
  const resumedAssistant = await page2.$$eval(".msg.assistant", (els) => els.map((e) => e.textContent));
  const resumedErrors = await page2.$$eval(".msg.error", (els) => els.map((e) => e.textContent));
  console.log("resumed transcript:", JSON.stringify(resumedAssistant));
  console.log("resumed errors:", JSON.stringify(resumedErrors));
  check("reopened panel resumes (no error, gets a reply)", resumedErrors.length === 0 && resumedAssistant.length > 0);

  // --- 6: "Phiên mới" clears and forgets ---------------------------------------
  await page2.click("#newSession");
  await sleep(300);
  const logEmpty = await page2.textContent("#log");
  check("Phiên mới clears the log", logEmpty.trim() === "", JSON.stringify(logEmpty));
  await page2.fill("#input", "Câu đầu tiên tôi vừa nhờ bạn nói là câu gì?");
  await page2.press("#input", "Enter");
  /* eslint-disable no-undef -- browser globals, evaluated inside the page by Playwright, not by this Node process */
  await page2.waitForFunction(() => document.getElementById("stop").disabled === false, { timeout: 15000 });
  await page2.waitForFunction(() => document.getElementById("stop").disabled === true, { timeout: 60000 });
  /* eslint-enable no-undef */
  const newAssistant = await page2.$$eval(".msg.assistant", (els) => els.map((e) => e.textContent));
  const newErrors = await page2.$$eval(".msg.error", (els) => els.map((e) => e.textContent));
  console.log("post-'Phiên mới' transcript:", JSON.stringify(newAssistant));
  console.log("post-'Phiên mới' errors:", JSON.stringify(newErrors));
  check("post-'Phiên mới' turn gets a reply with no memory of the old session", newErrors.length === 0 && newAssistant.length > 0, JSON.stringify({ newAssistant, newErrors }));

  // --- F1: "ready" mid-turn must clear busy, or the panel locks up forever ----
  // Both "Phiên mới" and a model change send `start` even while a turn is
  // running; the server disposes that AgentSession, and a disposed session
  // never emits its own turn_end. Reproduced directly via handle(). This
  // section deliberately points wsUrl at an unreachable address before
  // opening the page (restored right after), instead of the real bridge: an
  // earlier version of this test kept the real connection, and pressing
  // Enter with real text on an actually-OPEN socket sent a real `prompt` to
  // the real bridge -- an unawaited, unbudgeted live claude turn on every run
  // of an opt-in script whose whole point is to avoid exactly that. The
  // fix/lockup being tested here is pure DOM/JS state (`busy`, the Enter
  // handler's guard, the stop button), so a live connection was never
  // actually needed -- `send()` silently no-ops with no `ws` open, which is
  // precisely what lets the Enter-key path still be exercised for free.
  await sw.evaluate(async (wsUrl) => {
    await chrome.storage.local.set({ wsUrl });
  }, "ws://127.0.0.1:1/panel?token=f1-unreachable-dead-endpoint");
  const f1Page = await context.newPage();
  await f1Page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await f1Page.waitForSelector("#input", { timeout: 15000 }); // page loaded; no live connection needed or wanted here
  /* eslint-disable no-undef -- window.handle is a page global, evaluated by Playwright inside the page, not by this Node process */
  await f1Page.evaluate(() => { handle({ type: "turn_start" }); });
  /* eslint-enable no-undef */
  const stopEnabledMidTurn = await f1Page.getAttribute("#stop", "disabled");
  check("F1 setup: turn_start makes Dừng active (busy=true)", stopEnabledMidTurn === null, String(stopEnabledMidTurn));

  /* eslint-disable no-undef */
  await f1Page.evaluate(() => { handle({ type: "ready", sessionId: "f1-test-session", groupTitle: "Claude · f1te" }); });
  /* eslint-enable no-undef */
  const stopDisabledAfterReady = await f1Page.getAttribute("#stop", "disabled");
  check("F1: a mid-turn ready clears busy (Dừng goes back to disabled) even with no turn_end", stopDisabledAfterReady !== null, String(stopDisabledAfterReady));

  // The real proof, not just the button's own visual state: pre-fix, `busy`
  // stayed true forever and the Enter handler's `if (!text || busy) return`
  // silently swallowed every subsequent prompt. Confirm one actually gets
  // through after the reset -- safely, since `ws` above is never OPEN (dead
  // endpoint), so `send()` is a guaranteed no-op and nothing is dispatched to
  // any real server no matter what happens here.
  await f1Page.fill("#input", "F1 kiểm tra: gõ được sau khi ready đến giữa lượt");
  await f1Page.press("#input", "Enter");
  const userMsgCountAfterReady = await f1Page.$$eval(".msg.user", (els) => els.length);
  check("F1: a prompt typed after that reset is not silently swallowed by a stuck busy flag (no live turn spent)", userMsgCountAfterReady === 1, `count=${userMsgCountAfterReady}`);

  // --- late-delta-after-"Phiên mới" small fix ----------------------------------
  // "Phiên mới" clears the log synchronously, before the server has disposed
  // the old turn -- a `delta` already in flight for it can still arrive after
  // the click. Without resetting `streaming` too, that late delta appends
  // into an element no longer attached to #log: no error, no visible effect,
  // text silently gone. Also still on the dead endpoint, so the real "start"
  // this click sends is likewise a no-op.
  /* eslint-disable no-undef */
  await f1Page.evaluate(() => {
    handle({ type: "turn_start" });
    handle({ type: "delta", text: "instream" });
  });
  /* eslint-enable no-undef */
  await f1Page.click("#newSession");
  /* eslint-disable no-undef */
  await f1Page.evaluate(() => { handle({ type: "delta", text: " late-fragment" }); });
  /* eslint-enable no-undef */
  const logAfterLateDelta = await f1Page.textContent("#log");
  check("small fix: a late delta after 'Phiên mới' does not silently vanish into a detached node", logAfterLateDelta.includes("late-fragment"), logAfterLateDelta);

  // Restore the real bridge URL for every page opened below, and clear the
  // bogus `panelSessionId: "f1-test-session"` the synthetic "ready" above
  // wrote to the real chrome.storage.local -- a later page's real `start`
  // would otherwise replay that nonexistent conversation id as
  // `resuming: true`. Harmless only as long as no later page actually sends
  // a real prompt; clearing it here removes that landmine outright rather
  // than relying on that staying true.
  await sw.evaluate(async (wsUrl) => {
    await chrome.storage.local.set({ wsUrl });
  }, `ws://127.0.0.1:${MCP_PORT}/ws?token=${TOKEN}`);
  await sw.evaluate(async () => {
    await chrome.storage.local.remove(["panelSessionId"]);
  });

  // --- F6: [tool_use, text] block ordering must not duplicate the bubble ------
  // The live turn above happened not to hit this, because Claude ordered its
  // blocks [text, tool_use] that time (already handled correctly, since
  // "message" itself always nulls `streaming` once it finalizes a text
  // block). Reproduced directly, independent of what any live model call
  // happens to order its blocks as.
  const f6Page = await context.newPage();
  const f6PageErrors = [];
  f6Page.on("pageerror", (err) => f6PageErrors.push(String(err)));
  await f6Page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await f6Page.waitForSelector("#dot.connected", { timeout: 15000 });
  /* eslint-disable no-undef */
  await f6Page.evaluate(() => {
    handle({ type: "turn_start" });
    handle({ type: "delta", text: "Đang kiểm tra trang..." });
    handle({ type: "tool", name: "mcp__chrome__get_page_text" });
    handle({ type: "message", text: "Đang kiểm tra trang..." });
    handle({ type: "turn_end", ok: true });
  });
  /* eslint-enable no-undef */
  const f6Bubbles = await f6Page.$$eval(".msg.assistant", (els) => els.map((e) => e.textContent));
  check("F6: [tool_use, text] block ordering does not duplicate the assistant bubble", f6Bubbles.length === 1 && f6Bubbles[0] === "Đang kiểm tra trang...", JSON.stringify(f6Bubbles));

  // --- small fixes: never render the literal string "undefined" ---------------
  /* eslint-disable no-undef */
  await f6Page.evaluate(() => { handle({ type: "error" }); }); // no `message` field
  await f6Page.evaluate(() => { handle({ type: "attach_tab_result", ok: false }); }); // no `error` field
  /* eslint-enable no-undef */
  const f6ErrorLines = await f6Page.$$eval(".msg.error", (els) => els.map((e) => e.textContent));
  check(
    "small fix: a bare error/attach_tab_result with a missing field never renders the literal string 'undefined'",
    f6ErrorLines.every((t) => !t.includes("undefined")) && f6ErrorLines.length >= 2,
    JSON.stringify(f6ErrorLines)
  );

  // --- small fix: a tool event with no name must not throw and drop the frame -
  let threwOnMissingToolName = false;
  try {
    /* eslint-disable no-undef */
    await f6Page.evaluate(() => { handle({ type: "tool" }); });
    /* eslint-enable no-undef */
  } catch {
    threwOnMissingToolName = true;
  }
  check("small fix: a tool event with no name does not throw inside handle()", threwOnMissingToolName === false);
  check("no uncaught page errors across the F6/small-fix synthetic events", f6PageErrors.length === 0, JSON.stringify(f6PageErrors));
}

try {
  await run();
} catch (err) {
  failures++;
  console.log(`CRASH  ${err && err.stack ? err.stack : String(err)}`);
} finally {
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (context) await context.close().catch(() => {});
  serverProc.kill();
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
}
process.exit(failures === 0 ? 0 : 1);
