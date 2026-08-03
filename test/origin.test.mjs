// Proves the invariant the entire auth model rests on: Chrome sends
// `Origin: chrome-extension://<id>` when the extension's service worker opens a
// WebSocket. If this ever stopped being true, every connection would be
// rejected once the origin check is mandatory.
//
// Usage: CHROME_PATH="..." node test/origin.test.mjs

import { WebSocketServer } from "ws";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = join(root, "extension");
const PORT = 9879;

let failures = 0;
function check(name, cond, detail = "") {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const seenOrigins = [];
const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
wss.on("connection", (socket, req) => {
  seenOrigins.push(req.headers.origin ?? null);
  socket.close();
});

const userDataDir = mkdtempSync(join(tmpdir(), "cc-origin-probe-"));
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
await sw.evaluate(async (wsUrl) => {
  await chrome.storage.local.set({ wsUrl });
}, `ws://127.0.0.1:${PORT}`);
await sw.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "reconnect" }, r)));

for (let i = 0; i < 40 && seenOrigins.length === 0; i++) await sleep(250);

check("extension opened a websocket connection", seenOrigins.length > 0);
check(
  "Chrome sends a chrome-extension:// Origin header",
  String(seenOrigins[0] || "").startsWith("chrome-extension://"),
  `origin=${JSON.stringify(seenOrigins[0])}`
);

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);

await context.close();
wss.close();
rmSync(userDataDir, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
