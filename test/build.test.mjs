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
for (const required of ["manifest.json", "background.js", "popup.html", "popup.js", "sidepanel.html", "sidepanel.js", "icons/icon128.png"]) {
  check(`zip contains ${required}`, names.includes(required), names.join(", "));
}
const zippedManifest = JSON.parse(zip.readAsText("manifest.json"));
check("zip manifest version matches source", zippedManifest.version === manifest.version, zippedManifest.version);

// --- version consistency ----------------------------------------------------

// Three files carried three different versions before 2.0.0 and nothing caught
// it. chrome_status reports the server number while the build names artifacts
// after the manifest, so a mismatch is invisible until someone debugs remotely.
const serverPkg = JSON.parse(readFileSync(join(root, "server", "package.json"), "utf8"));
const serverSource = readFileSync(join(root, "server", "index.js"), "utf8");
const serverVersion = (serverSource.match(/^const VERSION = "([^"]+)";$/m) || [])[1];
check("server/index.js declares a VERSION", !!serverVersion, 'no `const VERSION = "..."` line found');
check(
  "manifest, server VERSION and server package.json agree",
  manifest.version === serverVersion && manifest.version === serverPkg.version,
  `manifest=${manifest.version} index.js=${serverVersion} package.json=${serverPkg.version}`
);

// A zip missing the side_panel declaration is still a formally valid zip, but
// the chat panel silently refuses to open and nothing catches that.
check("manifest declares the side panel", zippedManifest.side_panel?.default_path === "sidepanel.html",
  JSON.stringify(zippedManifest.side_panel));
check("manifest requests the sidePanel permission", (zippedManifest.permissions || []).includes("sidePanel"),
  JSON.stringify(zippedManifest.permissions));

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
  headless: process.env.HEADED !== "1",
  // CI points CHROME_PATH at its own Chromium; without it Playwright uses the
  // browser it manages itself.
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
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
