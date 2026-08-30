// Usage: HEADED=1 node test/panel-image-encode.test.mjs
//
// The panel's image encoder, run in a real Chrome against real images.
//
// test/panel-stream.test.mjs deliberately does NOT cover this: its browser is a
// fake, and createImageBitmap / OffscreenCanvas / FileReader would have to be
// stubbed — at which point the assertion is about the stub, not about the
// encoder. So this file opens the actual sidepanel.html in the actual browser
// and calls encodeImage() with actual Blobs.
//
// What it holds:
//   * a source larger than 1568px is downscaled to exactly 1568 on its long
//     edge, and the OTHER edge keeps the aspect ratio
//   * a source smaller than that is left alone, not upscaled
//   * re-encoding follows the source: JPEG in, JPEG out; PNG in, PNG out
//   * the payload is bare base64 with no "data:...;base64," prefix, because
//     that prefix is exactly what the CLI's image block must not contain

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

const userDataDir = mkdtempSync(join(tmpdir(), "cc-imgenc-"));
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
  // chrome-extension://<id>/background.js -> the id this run assigned.
  const extensionId = new URL(sw.url()).host;

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  // sidepanel.js is a classic script, so its top-level declarations land on the
  // page's global object and can be called straight from here.
  /* eslint-disable no-undef -- browser globals, evaluated inside the page */
  await page.waitForFunction(() => typeof window.encodeImage === "function", null, { timeout: 10000 });
  /* eslint-enable no-undef */

  /* eslint-disable no-undef -- browser globals, evaluated inside the page */
  const encodeSized = async (w, h, type) =>
    await page.evaluate(async ([width, height, mime]) => {
      // A real raster with real content, not a 1x1: the whole point is the
      // downscale, and a degenerate source would make the maths trivial.
      const source = new OffscreenCanvas(width, height);
      const ctx = source.getContext("2d");
      const gradient = ctx.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, "#e8710a");
      gradient.addColorStop(1, "#1a1a1a");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
      const blob = await source.convertToBlob({ type: mime });
      const file = new File([blob], `probe.${mime === "image/jpeg" ? "jpg" : "png"}`, { type: mime });

      const encoded = await window.encodeImage(file);

      // Decode what came back, so the dimensions asserted are the ones actually
      // in the bytes rather than the ones the encoder believed it wrote.
      const img = new Image();
      img.src = `data:${encoded.mediaType};base64,${encoded.data}`;
      await img.decode();
      return {
        mediaType: encoded.mediaType,
        data: encoded.data,
        width: img.naturalWidth,
        height: img.naturalHeight,
      };
    }, [w, h, type]);
  /* eslint-enable no-undef */

  // 3000x1000 PNG -> long edge clamped to 1568, aspect ratio kept.
  const wide = await encodeSized(3000, 1000, "image/png");
  check("a PNG wider than 1568 is downscaled to exactly 1568 on its long edge",
    wide.width === 1568, JSON.stringify({ width: wide.width, height: wide.height }));
  check("and the short edge keeps the aspect ratio",
    wide.height === Math.round(1000 * (1568 / 3000)), JSON.stringify({ height: wide.height, expected: Math.round(1000 * (1568 / 3000)) }));
  check("a PNG source stays a PNG", wide.mediaType === "image/png", wide.mediaType);

  // Tall, to prove the clamp is on the LONG edge and not on width.
  const tall = await encodeSized(800, 2400, "image/png");
  check("a tall image is clamped on its height, not its width",
    tall.height === 1568 && tall.width === Math.round(800 * (1568 / 2400)),
    JSON.stringify({ width: tall.width, height: tall.height }));

  // Already small: leave it alone. Upscaling would invent detail and cost
  // tokens for pixels that carry nothing.
  const small = await encodeSized(320, 240, "image/png");
  check("an image smaller than the limit is not upscaled",
    small.width === 320 && small.height === 240, JSON.stringify({ width: small.width, height: small.height }));

  // A photo-shaped source must not come back as PNG: a phone photo re-encoded
  // as PNG inflates several times over.
  const photo = await encodeSized(2000, 1500, "image/jpeg");
  check("a JPEG source stays a JPEG", photo.mediaType === "image/jpeg", photo.mediaType);
  check("and is downscaled the same way", photo.width === 1568, String(photo.width));

  // The server refuses anything that is not standard base64, and the CLI's
  // image block takes the payload alone -- a data: prefix would fail both.
  const looksBare = /^[A-Za-z0-9+/]+={0,2}$/.test(wide.data);
  check("the payload is bare standard base64, with no data: prefix",
    looksBare && !wide.data.startsWith("data:"), wide.data.slice(0, 40));
}

try {
  await run();
} catch (err) {
  console.log(`FAIL  suite threw -- ${err.stack || err.message}`);
  failures++;
} finally {
  await context.close();
  rmSync(userDataDir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
