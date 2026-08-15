// Usage: node test/updater.test.mjs
//
// Pure functions only — no network, no spawning, no real release. Everything
// that talks to GitHub or the filesystem at scale is exercised in Task 4 and 5;
// this file covers the logic that decides WHAT gets downloaded and whether it is
// trusted, which is the part where a mistake is silent and dangerous.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareVersions, isValidTag, releaseUrls, parseChecksumFile, sha256File, reshapeToCheckout, REPO,
} from "../server/updater.js";

let failures = 0;
function check(name, cond, detail = "") {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}

// --- version comparison ------------------------------------------------------

check("a newer patch is newer", compareVersions("1.1.1", "1.1.0") === 1);
check("equal versions compare equal", compareVersions("1.1.0", "1.1.0") === 0);
check("an older minor is older", compareVersions("1.1.0", "1.2.0") === -1);
check("10 is newer than 9, not older (numeric, not lexical)", compareVersions("1.10.0", "1.9.0") === 1,
  String(compareVersions("1.10.0", "1.9.0")));
check("a leading v is tolerated", compareVersions("v1.2.0", "1.2.0") === 0);
check("missing segments count as zero", compareVersions("1.2", "1.2.0") === 0);

// --- tag validation ----------------------------------------------------------
//
// The tag arrives from the network and is pasted into a download URL. Anything
// that is not a plain version must be refused before it can shape a request.

check("a plain tag is valid", isValidTag("v1.2.0") === true);
check("a tag without v is valid", isValidTag("1.2.0") === true);
check("a path traversal attempt is refused", isValidTag("../../evil") === false);
check("a tag with a slash is refused", isValidTag("v1.2.0/../x") === false);
check("a tag with a space is refused", isValidTag("v1.2.0 rc") === false);
check("an empty tag is refused", isValidTag("") === false);
check("a non-string is refused", isValidTag(null) === false);

// --- url construction --------------------------------------------------------

const urls = releaseUrls("v1.2.0");
check("the tarball url points at this repo's release", urls.tarball === `https://github.com/${REPO}/releases/download/v1.2.0/cc-chrome-bridge.tar.gz`, urls.tarball);
check("the checksum url sits beside it", urls.checksum === `${urls.tarball}.sha256`, urls.checksum);

// --- checksum file parsing ---------------------------------------------------

check("shasum format yields the hex",
  parseChecksumFile("a".repeat(64) + "  cc-chrome-bridge.tar.gz\n") === "a".repeat(64));
check("a bare hex line works too", parseChecksumFile("b".repeat(64) + "\n") === "b".repeat(64));
check("a short hex is refused", parseChecksumFile("abc123  file") === null);
check("junk is refused", parseChecksumFile("not a checksum at all") === null);
check("empty is refused", parseChecksumFile("") === null);

// --- hashing a real file -----------------------------------------------------

const work = mkdtempSync(join(tmpdir(), "cc-updater-test-"));
const sample = join(work, "sample.bin");
writeFileSync(sample, "hello");
// sha256("hello") is a published constant; hard-coding it means this test fails
// if the implementation ever hashes something other than the file's bytes.
check("sha256File hashes the file's bytes",
  (await sha256File(sample)) === "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  await sha256File(sample));

// --- reshaping the extracted tarball into a checkout layout ------------------
//
// This is the whole reason the design works identically on three platforms:
// both installers accept CC_CHROME_SOURCE, but they expect a checkout layout,
// not the flat layout the tarball ships.

const extracted = join(work, "extracted");
mkdirSync(join(extracted, "server"), { recursive: true });
mkdirSync(join(extracted, "extension"), { recursive: true });
writeFileSync(join(extracted, "server", "index.js"), "// server");
writeFileSync(join(extracted, "extension", "manifest.json"), "{}");
for (const f of ["ccchrome.md", "uninstall.sh", "service-unit.sh", "uninstall.ps1", "service-task.ps1"]) {
  writeFileSync(join(extracted, f), f);
}

const target = join(work, "checkout");
reshapeToCheckout(extracted, target);

check("server/ is carried over", existsSync(join(target, "server", "index.js")));
check("extension/ is carried over", existsSync(join(target, "extension", "manifest.json")));
check("ccchrome.md lands where install.sh looks for it",
  readFileSync(join(target, ".claude", "commands", "ccchrome.md"), "utf8") === "ccchrome.md");
for (const f of ["uninstall.sh", "service-unit.sh", "uninstall.ps1", "service-task.ps1"]) {
  check(`${f} lands in scripts/`, readFileSync(join(target, "scripts", f), "utf8") === f);
}

// A tarball missing a file the installer needs must fail loudly here, not
// halfway through an install that has already stopped the service.
const broken = join(work, "broken");
mkdirSync(join(broken, "server"), { recursive: true });
mkdirSync(join(broken, "extension"), { recursive: true });
let threw = null;
try {
  reshapeToCheckout(broken, join(work, "checkout2"));
} catch (err) {
  threw = err.message;
}
check("a tarball missing ccchrome.md is refused, by name", threw && threw.includes("ccchrome.md"), String(threw));
check("a refused tarball leaves NO half-built source directory behind",
  !existsSync(join(work, "checkout2")), join(work, "checkout2"));

rmSync(work, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
