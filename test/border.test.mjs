// Usage: HEADED=1 node test/border.test.mjs
//
// The driving-tab frame must never appear in a screenshot Claude took. It
// already came off before the capture (background.js calls clearBorder), and it
// still reached the image two ways:
//
//   (i)  paintBorder() is fire-and-forget, so a paint issued a moment earlier
//        could land AFTER the clear and put the frame back.
//   (ii) Claude Code runs tool calls in parallel, so a read_page against the
//        same tab repaints the frame mid-capture. Serialising does not help
//        there: that repaint is legitimately after the clear.
//
// Both are races, so both are made deterministic here by slowing one side of
// each inside the service worker — and the two need OPPOSITE slowdowns, which
// is not obvious and was got wrong once:
//
//   for (i)  the PAINT is slowed, so a clear issued after it would finish first
//   for (ii) the CAPTURE is slowed and the paint left fast, so the concurrent
//            repaint lands inside the capture window
//
// Slowing the paint for (ii) as well makes (ii) pass against the broken code —
// the repaint simply arrives after the capture is already done. Measured: with
// one 300ms paint delay for both cases, (i) went red and (ii) went green on
// code that had neither fix. An assertion that cannot fail is worse than no
// assertion, so the two cases are instrumented separately below.

import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = join(root, "extension");
const HTTP_PORT = 8794;

let failures = 0;
function check(name, cond, detail = "") {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pure white with zero margin. The frame is an inset glow strongest at the very
// edge, so a white page makes "is there orange at (2,2)" a clean question.
const TEST_PAGE = `<!DOCTYPE html>
<html><head><title>Border test page</title><style>html,body{margin:0;background:#fff;height:100%}</style></head>
<body><h1 style="margin:0;padding:200px 0 0 200px;color:#000">Border test page</h1></body></html>`;

const httpServer = createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(TEST_PAGE);
});
await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));
const TEST_URL = `http://127.0.0.1:${HTTP_PORT}/`;

const userDataDir = mkdtempSync(join(tmpdir(), "cc-border-"));
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: process.env.HEADED !== "1",
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ],
});

async function run() {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 });

  /* eslint-disable no-undef -- service-worker globals, evaluated there by Playwright */
  const callHandler = async (name, params) =>
    await sw.evaluate(async ([n, p]) => {
      try {
        return { __ok: true, result: await handlers[n](p) };
      } catch (e) {
        return { __ok: false, error: e.message };
      }
    }, [name, params]);

  // Instrument both seams once; the delays themselves are globals each case
  // sets to whatever it needs, since the two cases need opposite slowdowns.
  await sw.evaluate(async () => {
    globalThis.__scriptLog = [];
    globalThis.__paintDelayMs = 0;
    globalThis.__captureDelayMs = 0;

    const origScript = chrome.scripting.executeScript.bind(chrome.scripting);
    chrome.scripting.executeScript = async (opts) => {
      const name = opts && opts.func ? opts.func.name : "(anonymous)";
      if (name === "pageShowBorder" && globalThis.__paintDelayMs) {
        await new Promise((r) => setTimeout(r, globalThis.__paintDelayMs));
      }
      globalThis.__scriptLog.push({ name, tabId: opts?.target?.tabId, at: Date.now() });
      return await origScript(opts);
    };

    // cdp() in background.js is a thin promise wrapper around this callback
    // API, so delaying the dispatch here delays the capture itself.
    const origSend = chrome.debugger.sendCommand.bind(chrome.debugger);
    chrome.debugger.sendCommand = (target, method, params, callback) => {
      if (method !== "Page.captureScreenshot") return origSend(target, method, params, callback);
      // The moment the pixels are actually read. Logged so the assertion can
      // bound its window at the capture rather than at "any time after the
      // clear" -- take_screenshot's own repaint in its finally is required, and
      // an unbounded assertion flags it as the defect.
      const wrapped = (result) => {
        globalThis.__scriptLog.push({ name: "capture", tabId: target.tabId, at: Date.now() });
        callback(result);
      };
      if (globalThis.__captureDelayMs) {
        setTimeout(() => origSend(target, method, params, wrapped), globalThis.__captureDelayMs);
        return;
      }
      return origSend(target, method, params, wrapped);
    };
  });

  const hasFrame = async (tabId) =>
    await sw.evaluate(async (id) => {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: id },
        func: () => !!document.getElementById("__cc_border"),
      });
      return res.result;
    }, tabId);
  /* eslint-enable no-undef */

  const SESSION = "bbbb-border-session";
  const created = await callHandler("new_tab", { url: TEST_URL, __session: SESSION });
  check("test tab created and grouped", created.__ok === true, JSON.stringify(created));
  const tabId = created.result.tabId;
  await sleep(500);

  // -------------------------------------------------------------------------
  // (i) clearBorder must not be able to overtake a paint that is still in flight
  // -------------------------------------------------------------------------
  await sw.evaluate(() => { globalThis.__paintDelayMs = 300; globalThis.__captureDelayMs = 0; });
  await sw.evaluate(async (id) => {
    /* eslint-disable no-undef */
    paintBorder(id);        // fire-and-forget, artificially slowed to 300ms
    await clearBorder(id);  // must not return until that paint has landed and been undone
    /* eslint-enable no-undef */
  }, tabId);
  await sleep(500); // any late paint would have landed by now
  check(
    "clearBorder() waits out an in-flight paint instead of racing it",
    (await hasFrame(tabId)) === false,
    "the frame was still on the page after an awaited clearBorder"
  );

  // -------------------------------------------------------------------------
  // (ii) a concurrent tool call must not repaint the frame during a capture
  // -------------------------------------------------------------------------
  // Paint fast, capture slow — the inversion of case (i). The concurrent
  // read_page's repaint has to land INSIDE the capture window, and a slowed
  // paint would simply arrive after the picture was already taken.
  await sw.evaluate(() => {
    globalThis.__scriptLog = [];
    globalThis.__paintDelayMs = 0;
    globalThis.__captureDelayMs = 700;
  });
  // The frame is on the tab right now (case (i) ended with clearBorder, so put
  // it back explicitly) — a capture that starts with no frame would pass the
  // pixel assertion for the wrong reason.
  await sw.evaluate((id) => paintBorder(id), tabId); // eslint-disable-line no-undef
  await sleep(400);
  check("the frame is on the tab before the capture starts", (await hasFrame(tabId)) === true);

  const shotPromise = callHandler("take_screenshot", { tabId, __session: SESSION });

  // Fired the moment the pre-capture clear has actually run, not in the same
  // tick. Measured: issuing both together put read_page's paint 4ms BEFORE
  // pageHideBorder, so the clear swept it and the capture was clean for a
  // reason that has nothing to do with the fix under test. Waiting for the
  // clear is what puts the repaint in the window that matters.
  for (let i = 0; i < 100; i++) {
    const seen = await sw.evaluate(() => globalThis.__scriptLog.some((e) => e.name === "pageHideBorder"));
    if (seen) break;
    await sleep(20);
  }
  const readPromise = callHandler("read_page", { tabId, __session: SESSION });
  const [shot, read] = await Promise.all([shotPromise, readPromise]);

  check("take_screenshot succeeded", shot.__ok === true, JSON.stringify(shot).slice(0, 300));
  check("the concurrent read_page also succeeded", read.__ok === true, JSON.stringify(read).slice(0, 200));

  // Mechanism half -- deterministic on every machine, the way focus.test.mjs
  // asserts on the arguments actually passed rather than on what was observed.
  const log = await sw.evaluate(() => globalThis.__scriptLog);
  const forTab = log.filter((e) => e.tabId === tabId);
  const hideAt = forTab.findIndex((e) => e.name === "pageHideBorder");
  const captureAt = forTab.findIndex((e) => e.name === "capture");
  // Bounded at both ends on purpose. The repaint AFTER the capture is required
  // (the last assertion in this file checks for it), so the window under test
  // is exactly clear -> capture.
  const paintedInWindow =
    hideAt >= 0 && captureAt > hideAt &&
    forTab.slice(hideAt + 1, captureAt).some((e) => e.name === "pageShowBorder");
  check(
    "no paint is injected between the pre-capture clear and the capture",
    hideAt >= 0 && captureAt > hideAt && !paintedInWindow,
    JSON.stringify(forTab)
  );

  // Observable half -- the pixels, which is the property the user actually cares
  // about. base64 length would not do: a blank 1280x720 PNG measures ~27,000
  // characters, so length proves nothing about content.
  const base64 = shot.__ok ? shot.result.base64 : "";
  const page = context.pages()[0];
  /* eslint-disable no-undef -- browser globals, evaluated inside the page */
  const corner = base64
    ? await page.evaluate(async (b64) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        // Four samples hugging the edges, where the inset glow is strongest.
        const pts = [
          [2, 2],
          [img.naturalWidth - 3, 2],
          [2, img.naturalHeight - 3],
          [img.naturalWidth - 3, img.naturalHeight - 3],
        ];
        return pts.map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3));
      }, base64)
    : null;
  /* eslint-enable no-undef */

  // The frame is rgb(232,113,10) at up to 50% alpha over white. Any orange wash
  // drops the blue channel well below 240 while red stays high; untouched white
  // is (255,255,255).
  const tinted = (corner || []).filter(([r, g, b]) => r - b > 12 || g < 235 || b < 235);
  check(
    "the captured PNG has no orange wash at any edge",
    !!corner && tinted.length === 0,
    JSON.stringify(corner)
  );

  // The frame must come BACK afterwards -- suppressing it permanently would be
  // a different bug with the same green test.
  await sleep(800);
  check("the frame is repainted after the capture", (await hasFrame(tabId)) === true);
}

try {
  await run();
} catch (err) {
  console.log(`FAIL  suite threw -- ${err.stack || err.message}`);
  failures++;
} finally {
  await context.close();
  httpServer.close();
  rmSync(userDataDir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
