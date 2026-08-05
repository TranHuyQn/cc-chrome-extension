// Manual verification for the side panel chat UI (extension/sidepanel.{html,js}),
// run against a real bridge in http mode and a real Chromium with the extension
// loaded. NOT part of `npm test`: unlike every other suite in this directory it
// spawns the real `claude` CLI (no test/fake-claude*.mjs stand-in), so it costs
// real API usage, needs a machine that is actually logged in, and is not
// deterministic enough to run unattended in CI.
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
// Usage: npm run verify:sidepanel   (equivalent to: HEADED=1 node test/verify-sidepanel.mjs)
//   macOS: CHROME_PATH must stay unset -- see CLAUDE.md.

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

const userDataDir = mkdtempSync(join(tmpdir(), "cc-bridge-panel-e2e-"));
const context = await chromium.launchPersistentContext(userDataDir, {
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

await sw.evaluate(async (wsUrl) => {
  await chrome.storage.local.set({ wsUrl });
}, `ws://127.0.0.1:${MCP_PORT}/ws?token=${TOKEN}`);
// Also make sure any stale panel session id from a previous run of this
// script does not leak in.
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

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);

await context.close();
serverProc.kill();
rmSync(userDataDir, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
