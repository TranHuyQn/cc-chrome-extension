// Verifies the packaged extension artifacts: runs the build, checks the zip
// contents and CRX3 signature envelope, then actually installs the built zip
// into real Chromium and confirms the service worker boots from it.
//
// Usage: npm install && npm install in test/, then: node test/build.test.mjs

import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(name, cond, detail = "") {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}

execFileSync("node", [join(root, "scripts", "build-extension.mjs")], { stdio: "inherit" });

const manifest = JSON.parse(readFileSync(join(root, "extension", "manifest.json"), "utf8"));
const zipPath = join(root, "dist", "extension.zip");
const crxPath = join(root, "dist", "extension.crx");

// --- zip contents -----------------------------------------------------------

const zip = new AdmZip(zipPath);
const names = zip.getEntries().map((e) => e.entryName);
for (const required of ["manifest.json", "background.js", "popup.html", "popup.js", "icons/icon128.png"]) {
  check(`zip contains ${required}`, names.includes(required), names.join(", "));
}
const zippedManifest = JSON.parse(zip.readAsText("manifest.json"));
check("zip manifest version matches source", zippedManifest.version === manifest.version, zippedManifest.version);

// --- crx envelope -----------------------------------------------------------

const crx = readFileSync(crxPath);
check("crx magic 'Cr24'", crx.subarray(0, 4).toString() === "Cr24");
check("crx format version 3", crx.readUInt32LE(4) === 3);
const headerLen = crx.readUInt32LE(8);
check("crx header present", headerLen > 100 && headerLen < crx.length, `headerLen=${headerLen}`);
// The zip payload follows the header; it must start with the zip magic PK.
const payload = crx.subarray(12 + headerLen);
check("crx payload is a zip", payload.subarray(0, 2).toString() === "PK");

// --- the built zip actually loads in Chromium -------------------------------

const unpackDir = mkdtempSync(join(tmpdir(), "cc-bridge-dist-"));
zip.extractAllTo(unpackDir, true);
const userDataDir = mkdtempSync(join(tmpdir(), "cc-bridge-dist-profile-"));
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: true,
  executablePath: "/opt/pw-browsers/chromium",
  args: [
    `--disable-extensions-except=${unpackDir}`,
    `--load-extension=${unpackDir}`,
  ],
});
let sw = context.serviceWorkers()[0];
if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 });
check("built extension boots in Chromium", sw.url().endsWith("/background.js"), sw.url());
const version = await sw.evaluate(() => chrome.runtime.getManifest().version);
check("running version matches build", version === manifest.version, version);
await context.close();
rmSync(unpackDir, { recursive: true, force: true });
rmSync(userDataDir, { recursive: true, force: true });

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
