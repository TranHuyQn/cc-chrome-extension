// Verifies the packaged extension artifacts: runs the build, checks the zip
// contents and CRX3 signature envelope, then actually installs the built zip
// into real Chromium and confirms the service worker boots from it.
//
// Usage: npm install && npm install in test/, then: node test/build.test.mjs

import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Walks raw tar headers instead of shelling out to `tar -tzf`. Needed
// specifically because macOS's own `tar -tzf` hides/merges AppleDouble
// (`._<name>`) resource-fork entries on read — the exact same tool used to
// build the archive on this platform, so a listing built from it can never
// see the defect it's meant to catch. Each header is a 512-byte block; a PAX
// extended header (typeflag 'x') precedes most real entries here (bsdtar
// emits one per entry for high-res timestamps, not just for long names) and
// carries the real path as a "<len> path=<value>\n" record when the name
// doesn't fit in the 100-byte name field. For names that fit in ustar's
// fixed fields but still exceed the 100-byte `name` field alone (roughly
// 101-255 bytes), bsdtar splits across `prefix` (offset 345, 155 bytes) +
// "/" + `name` instead of emitting a PAX override — read and join both.
//
// Two things this deliberately does not handle, safe in this archive today:
// it stops at the first all-zero block rather than requiring the two
// consecutive ones the tar spec uses to mark end-of-archive (this build
// never produces a real all-zero header body mid-archive, so one is enough
// here), and it does not special-case GNU long-name entries (typeflag 'L')
// — one would be pushed as a spurious literal "././@LongLink" member,
// inflating the count rather than hiding entries, so it fails safe. Neither
// occurs: this archive's typeflag census is 0 (file) / 2 (symlink) / 5
// (dir) / x (PAX) only.
function listTarMembers(tarPath) {
  const buf = gunzipSync(readFileSync(tarPath));
  const names = [];
  // Any PAX record key containing ".xattr." (`LIBARCHIVE.xattr.*`,
  // `SCHILY.xattr.*`) is bsdtar embedding a captured extended attribute —
  // GNU tar on Linux doesn't understand these and logs "Ignoring unknown
  // extended header keyword" once per entry that carries one, even though
  // the entry itself still extracts fine.
  const xattrKeywords = [];
  let offset = 0;
  let pendingName = null;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive marker
    const typeflag = String.fromCharCode(header[156]);
    const sizeOctal = header.subarray(124, 136).toString("ascii").replace(/\0/g, "").trim();
    const size = sizeOctal ? parseInt(sizeOctal, 8) : 0;
    const dataBlocks = Math.ceil(size / 512);
    if (typeflag === "x" || typeflag === "g") {
      // PAX extended (per-entry) or global header: metadata, not a member itself.
      const data = buf.subarray(offset + 512, offset + 512 + size).toString("utf8");
      const match = data.match(/(?:^|\n)\d+ path=([^\n]*)\n/);
      if (typeflag === "x" && match) pendingName = match[1];
      for (const kv of data.matchAll(/(?:^|\n)\d+ ([A-Za-z0-9_.]+)=/g)) {
        if (kv[1].includes(".xattr.")) xattrKeywords.push(kv[1]);
      }
    } else {
      const rawName = header.subarray(0, 100).toString("utf8").split("\0")[0];
      const prefix = header.subarray(345, 500).toString("utf8").split("\0")[0];
      names.push(pendingName || (prefix ? `${prefix}/${rawName}` : rawName));
      pendingName = null;
    }
    offset += 512 + dataBlocks * 512;
  }
  return { names, xattrKeywords };
}

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
for (const required of ["manifest.json", "background.js", "popup.html", "popup.js", "sidepanel.html", "sidepanel.js", "panel-labels.js", "panel-journal.js", "icons/icon128.png"]) {
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

// --- release tarball --------------------------------------------------------

execFileSync("node", [join(root, "scripts", "build-release.mjs")], { stdio: "inherit" });
const tarPath = join(root, "dist", "cc-chrome-bridge.tar.gz");
check("release tarball exists", existsSync(tarPath));

// install.sh must also exist as its OWN release asset, not just inside the
// tarball above: the one-line install everyone is told to run
// (`curl .../releases/latest/download/install.sh | bash`) needs install.sh
// to be fetchable before the tarball it then downloads is ever requested.
const distInstallPath = join(root, "dist", "install.sh");
check("install.sh is produced as a standalone release asset (dist/install.sh)", existsSync(distInstallPath));
check(
  "dist/install.sh is byte-identical to scripts/install.sh",
  existsSync(distInstallPath) && readFileSync(distInstallPath, "utf8") === readFileSync(join(root, "scripts", "install.sh"), "utf8")
);

// Same argument, Windows half: the documented Windows install is
// `irm .../releases/latest/download/install.ps1 | iex`, which fetches that one
// file before any tarball exists locally. Forgetting to publish it makes the
// command 404 with nothing to read.
const distInstallPs1Path = join(root, "dist", "install.ps1");
check("install.ps1 is produced as a standalone release asset (dist/install.ps1)", existsSync(distInstallPs1Path));
check(
  "dist/install.ps1 is byte-identical to scripts/install.ps1",
  existsSync(distInstallPs1Path) && readFileSync(distInstallPs1Path, "utf8") === readFileSync(join(root, "scripts", "install.ps1"), "utf8")
);

const listing = execFileSync("tar", ["-tzf", tarPath], { encoding: "utf8" });
// Exact entry names, not substring matching against the raw listing — a
// substring check would also pass on e.g. "server/index.js.bak".
const entries = new Set(
  listing
    .split("\n")
    .filter(Boolean)
    .map((line) => line.replace(/^\.\//, "").replace(/\/$/, "")),
);
for (const required of [
  "server/index.js",
  "server/agent.js",
  "server/node_modules/ws/package.json",
  "extension/manifest.json",
  "extension/sidepanel.html",
  "install.sh",
  "uninstall.sh",
  "service-unit.sh",
  "install.ps1",
  "uninstall.ps1",
  "service-task.ps1",
  "ccchrome.md",
]) {
  check(`tarball contains ${required}`, entries.has(required), listing.slice(0, 500));
}

// macOS's own `tar -czf` silently adds one `._<name>` AppleDouble
// resource-fork entry per real entry unless COPYFILE_DISABLE=1 is set.
// macOS's own `tar -tzf` hides and merges those on read, so a listing built
// from it (the `entries` set above) can never see this defect — a Linux
// install (`cp -R` in install.sh) extracts them for real, permanently, as
// junk twins of every shipped file. listTarMembers() walks the raw headers
// instead, so it sees exactly what a non-macOS extractor sees.
const { names: rawMembers, xattrKeywords } = listTarMembers(tarPath);

// Anchor listTarMembers() against the `entries` set built from `tar -tzf`
// above, so a walker that silently stops early (a logic bug, not a thrown
// exception — nothing else would report an empty/short result as an error)
// fails loudly instead of reporting a suspiciously clean archive. `tar -tzf`
// hides AppleDouble members but agrees with the walker on everything else,
// so their non-AppleDouble counts must match exactly.
const normalizedRaw = rawMembers.map((n) => n.replace(/^\.\//, "").replace(/\/$/, ""));
const nonAppleDoubleRawCount = normalizedRaw.filter((n) => !/(^|\/)\._/.test(n)).length;
check(
  "listTarMembers() sees as many non-AppleDouble entries as tar -tzf",
  nonAppleDoubleRawCount === entries.size,
  `listTarMembers=${nonAppleDoubleRawCount} tar-tzf=${entries.size}`,
);

const appleDoubleEntries = rawMembers.filter((e) => /(^|\/)\._/.test(e));
check("no AppleDouble (._*) junk entries", appleDoubleEntries.length === 0, appleDoubleEntries.slice(0, 10).join(", "));

// --no-xattrs in build-release.mjs's tar invocation should keep bsdtar from
// embedding captured xattrs (e.g. macOS's own `com.apple.provenance`) as PAX
// headers. GNU tar on Linux extracts the archive fine either way, but logs
// "Ignoring unknown extended header keyword" once per affected entry — this
// catches a regression before every `install.sh` run prints that warning again.
check("no macOS xattr PAX headers in the tarball", xattrKeywords.length === 0, xattrKeywords.slice(0, 10).join(", "));

// No symlinks AT ALL, which is stricter than the rule this replaces ("no
// symlink with an absolute target") and for a harder reason. Windows' bundled
// tar.exe cannot create a symlink without Developer Mode or elevation: it
// fails the entry, then aborts the whole extraction with "Error exit delayed
// from previous errors", and install.ps1 reports a broken release. One shim
// (server/node_modules/.bin/node-which) was enough to make every Windows
// install fail at the download step. build-release.mjs drops node_modules/.bin
// for that reason; nothing in server/ ever executes those shims.
const verboseListing = execFileSync("tar", ["-tvzf", tarPath], { encoding: "utf8" });
const symlinkLines = verboseListing
  .split("\n")
  .filter((line) => line.includes(" -> "));
check(
  "the tarball contains no symlinks (Windows tar.exe cannot create them)",
  symlinkLines.length === 0,
  symlinkLines.slice(0, 5).join(" | "),
);
check(
  "node_modules/.bin is not shipped",
  ![...entries].some((e) => e.includes("node_modules/.bin")),
  [...entries].filter((e) => e.includes("node_modules/.bin")).slice(0, 3).join(", "),
);

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
