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
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = join(REPO, "extension");

// An ephemeral port, NOT the hardcoded 8787. This script is the acceptance
// run for a *local install*, so on exactly the machine it matters most the
// installed service already owns 8787: the spawned child would die instantly
// with "FATAL: port 8787 already in use", the health poll below would then
// succeed against the INSTALLED bridge, and every later section would run
// against a bridge whose token set has no TOKEN — a cascade of confusing
// failures reported as a passing health check.
function freePort() {
  return new Promise((res, rej) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", rej);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => res(port));
    });
  });
}
const MCP_PORT = await freePort();
const TOKEN = "paneltoken12345";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The startup IIFE's journal replay (restore()) is async -- loadState() and
// ccJournal.load() both go through chrome.storage.local, so it does not
// finish in the same tick #log's static markup exists in. On a page that
// reaches a real bridge, waitForSelector("#dot.connected") is a sufficient
// proxy (connect() only runs after restore() resolves), but a deliberately
// offline page never reaches that state. Polling until #log's own child
// count stops moving between two reads is the general signal: it is true
// regardless of whether the page ever connects, and replay is the only thing
// that can still be appending to #log at page-load time.
async function waitForLogSettled(page) {
  let prev = -1;
  for (let i = 0; i < 40; i++) {
    const count = await page.$$eval("#log > *", (els) => els.length);
    if (count === prev) return count;
    prev = count;
    await sleep(100);
  }
  return prev;
}

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
    CC_CHROME_PORT: String(MCP_PORT),
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
// A 200 on that port proves *something* answers there, not that the thing
// this script started is what answered. The ephemeral port above makes a
// collision unlikely rather than impossible (another process can still grab
// it between the probe closing and the bridge binding), so assert the child
// is genuinely alive: a bridge that exited on EADDRINUSE has a non-null
// exitCode while some other listener happily serves /health.
check("the spawned bridge is still running (not a stranger answering /health)", serverProc.exitCode === null, `exitCode=${serverProc.exitCode}`);
if (!healthy || serverProc.exitCode !== null) { serverProc.kill(); process.exit(1); }

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
  // The session id lives under a per-window key (panelSession.<windowId>),
  // not an extension-global "panelSessionId" -- that global key stopped being
  // written when the panel moved to per-window keys (commit 1a60f52), on
  // purpose: one extension-global key made two Chrome windows resume the same
  // conversation. Resolve the real key the same way the panel does.
  const storedSessionId = await sw.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const key = Object.keys(all).find((k) => k.startsWith("panelSession."));
    return key ? all[key].sessionId : null;
  });
  check("panelSessionId persisted to storage", !!storedSessionId, storedSessionId);

  await page.close();
  const page2 = await context.newPage();
  await page2.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page2.waitForSelector("#dot.connected", { timeout: 15000 });
  // Snapshot AFTER connect (so the journal replay from earlier sections on
  // this same window has already finished, not raced) and BEFORE the prompt:
  // reopening now legitimately replays every earlier error-line this run
  // produced (e.g. the stop-mid-turn section above), so an absolute
  // `resumedErrors.length === 0` can never hold again. What actually proves
  // resume worked is that NOTHING NEW went wrong.
  const errorsBeforePrompt = await page2.$$eval(".msg.error", (els) => els.length);
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
  check("reopened panel resumes (no NEW error, gets a reply)",
    resumedErrors.length === errorsBeforePrompt && resumedAssistant.length > 0,
    JSON.stringify({ before: errorsBeforePrompt, after: resumedErrors }));

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
  // This page is deliberately offline, so it never reaches #dot.connected --
  // the signal the sibling live-bridge sections use to know restore()'s
  // journal replay has finished. Wait for #log to stop growing instead,
  // before the delta baseline below is read: a still-in-flight replay could
  // otherwise land its own .msg.user entries between that baseline and the
  // post-Enter read, misreporting a correct panel as swallowing the prompt.
  await waitForLogSettled(f1Page);
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
  // any real server no matter what happens here. f1Page replayed this
  // window's journal on open, which by now legitimately carries every user
  // message earlier sections typed -- so the assertion has to be about the
  // DELTA this Enter press adds, not an absolute count that can never be 1
  // again.
  const userMsgCountBeforePrompt = await f1Page.$$eval(".msg.user", (els) => els.length);
  await f1Page.fill("#input", "F1 kiểm tra: gõ được sau khi ready đến giữa lượt");
  await f1Page.press("#input", "Enter");
  const userMsgCountAfterReady = await f1Page.$$eval(".msg.user", (els) => els.length);
  check("F1: a prompt typed after that reset is not silently swallowed by a stuck busy flag (no live turn spent)",
    userMsgCountAfterReady === userMsgCountBeforePrompt + 1,
    `before=${userMsgCountBeforePrompt} after=${userMsgCountAfterReady}`);

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

  // --- T1: một bước chạy rồi xong ------------------------------------------
  // Đây là toàn bộ lý do tính năng tồn tại: một dòng phải chuyển từ "đang chạy"
  // sang "xong", nhìn thấy được, không cần đọc log server.
  /* eslint-disable no-undef */
  await f6Page.evaluate(() => {
    handle({ type: "turn_start" });
    handle({ type: "phase", phase: "requesting" });
    handle({ type: "step_start", id: "t1", name: "mcp__chrome__read_page" });
    handle({ type: "step_args", id: "t1", input: { url: "https://example.com" } });
  });
  /* eslint-enable no-undef */
  const t1Running = await f6Page.$$eval(".step.running .step-label", (els) => els.map((e) => e.textContent));
  check("T1: a started step renders a running row with a Vietnamese label",
    t1Running.includes("Đọc trang"), JSON.stringify(t1Running));
  const t1Sub = await f6Page.$eval(".step .step-sub", (el) => el.textContent);
  check("T1: its arguments become the subtitle", t1Sub === "https://example.com", t1Sub);
  const t1Status = await f6Page.$eval("#statusText", (el) => el.textContent);
  check("T1: the status bar names the running tool, not the phase", t1Status === "Đọc trang", t1Status);

  /* eslint-disable no-undef */
  await f6Page.evaluate(() => {
    handle({ type: "step_end", id: "t1", ok: true, ms: 1234, summary: "URL: https://example.com", size: 12700 });
  });
  /* eslint-enable no-undef */
  const t1Done = await f6Page.$eval(".step", (el) => ({ cls: el.className, icon: el.querySelector(".step-icon").textContent, time: el.querySelector(".step-time").textContent }));
  check("T1: the step ends as ok, with a tick and its duration",
    t1Done.cls.includes("ok") && !t1Done.cls.includes("running") && t1Done.icon === "✓" && t1Done.time === "1.2s",
    JSON.stringify(t1Done));

  // --- T2: một lượt bị bỏ dở không để lại dòng quay mãi ---------------------
  /* eslint-disable no-undef */
  await f6Page.evaluate(() => {
    handle({ type: "step_start", id: "t2", name: "mcp__chrome__get_page_text" });
    handle({ type: "step_end", id: "t2", ok: false, aborted: true, ms: 800, summary: "", size: 0 });
    handle({ type: "turn_end", ok: false, error: "đã dừng theo yêu cầu" });
  });
  /* eslint-enable no-undef */
  const stillRunning = await f6Page.$$eval(".step.running", (els) => els.length);
  check("T2: no row is left spinning after the turn ends", stillRunning === 0, String(stillRunning));
  const statusHidden = await f6Page.$eval("#status", (el) => el.className);
  check("T2: the status bar switches itself off", !statusHidden.includes("on"), statusHidden);

  // --- T3: kết quả tool không bao giờ được diễn giải thành HTML -------------
  // `summary` là văn bản do trang web sinh ra. Đây là chỗ duy nhất trong panel
  // mà nội dung của một trang lạ đi thẳng vào DOM.
  /* eslint-disable no-undef */
  await f6Page.evaluate(() => {
    handle({ type: "step_start", id: "t3", name: "mcp__chrome__get_page_text" });
    handle({ type: "step_end", id: "t3", ok: true, ms: 10, summary: "<img src=x onerror=\"window.__ccXss = 1\">", size: 40 });
  });
  /* eslint-enable no-undef */
  /* eslint-disable no-undef */
  const xss = await f6Page.evaluate(() => window.__ccXss);
  /* eslint-enable no-undef */
  check("T3: a tool result containing markup is inserted as text, not parsed", xss === undefined, String(xss));

  // --- T4 + T5: ngôn ngữ bám theo prompt, và nhật ký vẽ lại được ------------
  //
  // Hai mục này chạy trên một panel CỐ Ý không kết nối được: wsUrl bị trỏ vào
  // một cổng không có ai nghe. Lý do là để Enter thật sự chạy qua handler thật
  // (nơi đặt locale và ghi nhật ký) mà `send()` không gửi được gì đi — nếu socket
  // mở, dòng đó sẽ khởi động một lượt `claude` thật, tốn usage và bắn sự kiện
  // vào giữa các khẳng định dưới đây. Nhật ký không phụ thuộc socket, nên phần
  // đang test vẫn chạy đầy đủ.
  await sw.evaluate(async () => {
    await chrome.storage.local.set({ wsUrl: "ws://127.0.0.1:1/ws?token=offline-on-purpose" });
  });

  const t4Page = await context.newPage();
  await t4Page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await t4Page.waitForSelector("#input");
  await t4Page.fill("#input", "open the console and check for errors");
  await t4Page.press("#input", "Enter");
  /* eslint-disable no-undef */
  await t4Page.evaluate(() => {
    handle({ type: "turn_start" });
    handle({ type: "step_start", id: "t4", name: "mcp__chrome__read_console_messages" });
  });
  /* eslint-enable no-undef */
  const t4En = await t4Page.$eval("#statusText", (el) => el.textContent);
  check("T4: an English prompt switches the activity wording to English", t4En === "Read console", t4En);
  const t4Buttons = await t4Page.$eval("#newSession", (el) => el.textContent);
  check("T4: but the buttons stay Vietnamese, per the repo convention", t4Buttons === "Phiên mới", t4Buttons);

  // Nhật ký ghi có debounce 500ms (SAVE_DEBOUNCE_MS trong panel-journal.js).
  // Mở trang mới trước khi nó kịp ghi thì T5 đỏ vì lý do không liên quan.
  await t4Page.waitForTimeout(900);

  // Chỉ chứng minh được bằng một trang MỚI trên CÙNG cửa sổ: cùng windowId, nên
  // cùng khoá panelLog.<windowId>.
  const t5Page = await context.newPage();
  await t5Page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await t5Page.waitForSelector("#input");
  const t5Text = await t5Page.textContent("#log");
  check("T5: reopening the panel replays what was already drawn",
    t5Text.includes("open the console and check for errors"), t5Text.slice(0, 200));
  const t5Interrupted = await t5Page.$$eval(".step", (els) => els.map((e) => e.querySelector(".step-icon").textContent));
  check("T5: a step left open when the panel closed comes back marked interrupted, not running",
    t5Interrupted.includes("⦸"), JSON.stringify(t5Interrupted));
  const t5Running = await t5Page.$$eval(".step.running", (els) => els.length);
  check("T5: and nothing is left pulsing after a replay", t5Running === 0, String(t5Running));

  // T4 above typed an English prompt, and saveState() persisted `locale: "en"`
  // into this window's panelSession.<windowId> entry -- by design (see the
  // loadState() comment in sidepanel.js: locale is sticky per window so a
  // reopened panel keeps the language the user was actually typing). Every
  // page opened on this window from here on would otherwise silently inherit
  // English tool/phase labels, which is correct product behavior but not what
  // T6/T7 below want to assert against -- reset it explicitly, preserving the
  // real sessionId/mcpSessionId already stored alongside it.
  const localeResetWinId = await t5Page.evaluate(async () => (await chrome.windows.getCurrent()).id);
  const localeResetKey = `panelSession.${localeResetWinId}`;
  await sw.evaluate(async (key) => {
    const stored = await chrome.storage.local.get({ [key]: {} });
    const saved = stored[key] || {};
    await chrome.storage.local.set({ [key]: { ...saved, locale: "vi" } });
  }, localeResetKey);

  // --- T6: a model change mid-tool must not leave a row pulsing, and must ----
  // not poison the NEXT turn's status bar. The server closes open steps only
  // through its own endTurn, and a disposed session emits nothing at all, so
  // the panel has to sweep its own rows on a model change too. Still on the
  // dead port from T4/T5 above: the #model "change" listener also calls
  // send(), and on a live socket that would start a real claude turn -- the
  // same reason T4/T5 needed an offline page in the first place.
  const t6Page = await context.newPage();
  await t6Page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await t6Page.waitForSelector("#input");
  /* eslint-disable no-undef */
  await t6Page.evaluate(() => {
    handle({ type: "turn_start" });
    handle({ type: "step_start", id: "t6", name: "mcp__chrome__read_page" });
  });
  await t6Page.evaluate(() => {
    const el = document.getElementById("model");
    el.value = "haiku";
    el.dispatchEvent(new Event("change"));
  });
  /* eslint-enable no-undef */
  const t6Running = await t6Page.$$eval(".step.running", (els) => els.length);
  check("T6: a model change sweeps any row still running", t6Running === 0, String(t6Running));
  const t6Icon = await t6Page.$eval(".step .step-icon", (el) => el.textContent);
  check("T6: the swept row shows the interrupted icon, not ok/fail", t6Icon === "⦸", t6Icon);

  // The real proof, and it has to skip turn_start to be one: turn_start's own
  // case sweeps `steps` unconditionally too (see its comment above), so
  // routing through a fresh turn_start before painting would pass even with
  // the modelEl handler's own sweep deleted -- it would only catch BOTH sweep
  // sites disappearing at once. Because turn_start sweeps, a leftover row can
  // never actually reach a user through the "next turn" path; what the
  // modelEl sweep uniquely protects is the window BETWEEN the model change
  // and the next turn_start -- the row still pulsing with no turn running,
  // and the status bar still naming it. `busy` is still true here (nothing
  // in this offline run ever sends `ready`, the only thing that clears it),
  // so paintStatus() does not take its `!busy` early return and this reads
  // the real computed text, not a hidden bar's stale leftover content.
  /* eslint-disable no-undef */
  await t6Page.evaluate(() => { handle({ type: "phase", phase: "thinking" }); });
  /* eslint-enable no-undef */
  const t6Status = await t6Page.$eval("#statusText", (el) => el.textContent);
  check("T6: the status bar between the model change and the next turn shows the phase, not a leftover dead tool name",
    t6Status === "Đang suy nghĩ", t6Status);

  // --- T7: journal replay must preserve the order of a [text, tool] turn -----
  // Live, the deltas build the bubble before the tool row lands under it.
  // Replay must reproduce that, not flip it. Pure handle() calls never call
  // send(), so this section needed no live socket to begin with -- staying on
  // the dead port just keeps it consistent with T4/T5/T6 above.
  const t7Page = await context.newPage();
  await t7Page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await t7Page.waitForSelector("#input");
  /* eslint-disable no-undef */
  await t7Page.evaluate(() => {
    handle({ type: "turn_start" });
    handle({ type: "delta", text: "t7-assistant-text-unique " });
    handle({ type: "delta", text: "phần hai" });
    handle({ type: "step_start", id: "t7", name: "mcp__chrome__find" });
    handle({ type: "step_args", id: "t7", input: { query: "t7 query" } });
    handle({ type: "step_end", id: "t7", ok: true, ms: 5, summary: "ok", size: 2 });
    handle({ type: "message", text: "t7-assistant-text-unique phần hai" });
    handle({ type: "turn_end", ok: true });
  });
  /* eslint-enable no-undef */
  await t7Page.waitForTimeout(900); // journal write debounce, same as T5 above

  // Only provable with a NEW page: same window, so the same panelLog.<windowId>
  // key the entries above were just written under.
  const t7ReplayPage = await context.newPage();
  await t7ReplayPage.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await t7ReplayPage.waitForSelector("#input");
  const t7Positions = await t7ReplayPage.$$eval("#log > *", (els) =>
    els.map((e) => ({ cls: e.className, snippet: e.textContent.slice(0, 40) }))
  );
  const t7BubbleIdx = t7Positions.findIndex((e) => e.snippet.includes("t7-assistant-text-unique"));
  const t7StepIdx = t7Positions.findIndex((e) => e.cls.includes("step") && e.snippet.includes("Tìm trên trang"));
  check("T7: replay puts the assistant bubble above the tool row, not below it",
    t7BubbleIdx !== -1 && t7StepIdx !== -1 && t7BubbleIdx < t7StepIdx, JSON.stringify(t7Positions));
  const t7BubbleCount = t7Positions.filter((e) => e.snippet.includes("t7-assistant-text-unique")).length;
  check("T7: the text appears exactly once, not duplicated by its own placeholder", t7BubbleCount === 1, String(t7BubbleCount));

  // --- T8: a corrupt journal must never cost the user their connection -------
  // The journal is a nicety; the socket is the product. Needs the REAL bridge
  // here, since the point being proven is that the connection survives.
  await sw.evaluate(async (wsUrl) => {
    await chrome.storage.local.set({ wsUrl });
  }, `ws://127.0.0.1:${MCP_PORT}/ws?token=${TOKEN}`);

  const t8JournalKey = `panelLog.${localeResetWinId}`;
  await sw.evaluate(async (key) => {
    await chrome.storage.local.set({
      [key]: [
        null,
        "a bare string, not an object",
        42,
        { text: "an object with no type field" },
        { type: "error-line", text: "t8-valid-entry-one" },
        { type: "error-line", text: "t8-valid-entry-two" },
      ],
    });
  }, t8JournalKey);

  const t8Page = await context.newPage();
  await t8Page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await t8Page.waitForSelector("#dot.connected", { timeout: 15000 }).catch(() => {});
  // These two checks guard two DIFFERENT regressions, not one -- the startup
  // IIFE calls connect() unconditionally after restore()'s try/catch, so a
  // thrown entry does not, by itself, stop connect() from running:
  //  - the connection check catches someone removing that try/catch around
  //    restore() entirely (a real defect fixed earlier in this plan), which
  //    would leave the panel with no socket at all;
  //  - the entries-rendered check catches someone removing restore()'s
  //    per-entry guard (`typeof entry.type !== "string"` etc.), which throws
  //    on the first corrupt entry and aborts the loop before it ever reaches
  //    the two valid entries placed after them.
  const t8DotClass = await t8Page.getAttribute("#dot", "class");
  check("T8: a corrupt journal never costs the user their connection", t8DotClass === "dot connected", t8DotClass);
  const t8Log = await t8Page.textContent("#log");
  check("T8: the two valid entries among the corrupt ones still rendered",
    t8Log.includes("t8-valid-entry-one") && t8Log.includes("t8-valid-entry-two"), t8Log.slice(0, 300));

  // Trả lại URL thật cho mọi trang mở sau, và dọn nhật ký test khỏi
  // chrome.storage.local của hồ sơ Chromium tạm này (kể cả nhật ký hỏng của
  // T8, dùng chung tiền tố panelLog.).
  await sw.evaluate(async (wsUrl) => {
    await chrome.storage.local.set({ wsUrl });
    const all = await chrome.storage.local.get(null);
    const logKeys = Object.keys(all).filter((k) => k.startsWith("panelLog."));
    if (logKeys.length) await chrome.storage.local.remove(logKeys);
  }, `ws://127.0.0.1:${MCP_PORT}/ws?token=${TOKEN}`);

  // --- U1: băng cập nhật hiện đúng theo trạng thái --------------------------
  /* eslint-disable no-undef */
  await f6Page.evaluate(() => {
    handle({ type: "update_status", current: "1.1.0", latest: "1.2.0", available: true, notes: "", lastResult: null });
  });
  /* eslint-enable no-undef */
  const u1 = await f6Page.$eval("#update", (el) => ({ hidden: el.hidden, text: el.querySelector("#updateText").textContent, btn: el.querySelector("#updateAction").textContent }));
  check("U1: a newer release shows the banner with a Cập nhật button",
    u1.hidden === false && u1.text.includes("1.2.0") && u1.btn === "Cập nhật", JSON.stringify(u1));

  /* eslint-disable no-undef */
  await f6Page.evaluate(() => { handle({ type: "update_status", current: "1.1.0", latest: "1.1.0", available: false, notes: "", lastResult: null }); });
  /* eslint-enable no-undef */
  check("U1: no newer release hides the banner", await f6Page.$eval("#update", (el) => el.hidden) === true);

  // A rollback must still be explained after the bridge comes back on the old
  // version — that is the only moment the user can learn why nothing changed.
  /* eslint-disable no-undef */
  await f6Page.evaluate(() => {
    handle({ type: "update_status", current: "1.1.0", latest: "1.1.0", available: false, notes: "",
      lastResult: { ok: false, step: "rolled-back", reason: "Bản 1.2.0 không lên được. Đã khôi phục bản cũ." } });
  });
  /* eslint-enable no-undef */
  const u2 = await f6Page.$eval("#update", (el) => ({ hidden: el.hidden, cls: el.className, text: el.querySelector("#updateText").textContent }));
  check("U1: a previous rollback is explained even when no update is available",
    u2.hidden === false && u2.cls.includes("failed") && u2.text.includes("khôi phục"), JSON.stringify(u2));

  /* eslint-disable no-undef */
  await f6Page.evaluate(() => { handle({ type: "update_failed", reason: "Checksum không khớp" }); });
  /* eslint-enable no-undef */
  check("U1: a failed update says why", (await f6Page.$eval("#updateText", (el) => el.textContent)).includes("Checksum"));

  // A previous run that stopped midway (backup still on disk) or that crashed
  // outright must render the FULL multi-sentence reason -- for these two the
  // reason IS the recovery instructions, so truncating it would strand the user.
  const u3Reason = "Có vẻ một bản cập nhật trước đã dừng giữa chừng. Bản cài cũ đang nằm ở " +
    "/Users/test/.cc-chrome-bridge.bak. Nếu bridge hiện tại chạy bình thường, đổi tên " +
    "/Users/test/.cc-chrome-bridge.bak thành một tên khác rồi thử lại. Nếu bridge không chạy: " +
    "đổi tên /Users/test/.cc-chrome-bridge thành /Users/test/.cc-chrome-bridge.failed (nếu nó còn " +
    "tồn tại), rồi đổi tên /Users/test/.cc-chrome-bridge.bak thành /Users/test/.cc-chrome-bridge " +
    "để khôi phục bản cũ. Nhật ký lần trước: /Users/test/.cc-chrome-bridge/update.log";
  /* eslint-disable no-undef */
  await f6Page.evaluate((reason) => {
    handle({ type: "update_status", current: "1.1.0", latest: "1.1.0", available: false, notes: "",
      lastResult: { ok: false, step: "already-running", reason } });
  }, u3Reason);
  /* eslint-enable no-undef */
  const u3 = await f6Page.$eval("#updateText", (el) => el.textContent);
  check("U1: an already-running (mid-update backup left on disk) result renders the full recovery reason",
    u3 === u3Reason, u3);

  const u4Reason = "Trình cập nhật gặp lỗi: EACCES. Bản cài cũ (nếu còn) ở /Users/test/.cc-chrome-bridge.bak; " +
    "bản cài lỗi (nếu có) ở /Users/test/.cc-chrome-bridge.failed; nhật ký ở /Users/test/.cc-chrome-bridge/update.log.";
  /* eslint-disable no-undef */
  await f6Page.evaluate((reason) => {
    handle({ type: "update_status", current: "1.1.0", latest: "1.1.0", available: false, notes: "",
      lastResult: { ok: false, step: "crashed", reason } });
  }, u4Reason);
  /* eslint-enable no-undef */
  const u4 = await f6Page.$eval("#updateText", (el) => el.textContent);
  check("U1: a crashed runner renders the full reason (error + backup/failed/log paths)",
    u4 === u4Reason, u4);

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
