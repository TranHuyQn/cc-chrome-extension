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
  compareVersions, isValidTag, releaseUrls, parseChecksumFile, sha256File, reshapeToCheckout, isCacheFresh, REPO,
  buildRunnerSpawn, updateTaskName,
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
for (const f of ["ccchrome.md", "uninstall.sh", "service-unit.sh", "uninstall.ps1", "service-task.ps1",
                 "update-runner.mjs", "install.sh", "install.ps1"]) {
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

// The three files spawnUpdateRunner reads out of the install directory. A
// release tarball missing any of them must fail HERE, while nothing has been
// touched — not at the moment the user presses the button, which is where the
// first version of this feature failed on every machine.
for (const f of ["update-runner.mjs", "install.sh", "install.ps1"]) {
  check(`${f} lands in scripts/ — spawnUpdateRunner reads it from the install dir`,
    readFileSync(join(target, "scripts", f), "utf8") === f);
}

const missingRunner = join(work, "no-runner");
mkdirSync(join(missingRunner, "server"), { recursive: true });
mkdirSync(join(missingRunner, "extension"), { recursive: true });
for (const f of ["ccchrome.md", "uninstall.sh", "service-unit.sh", "uninstall.ps1", "service-task.ps1",
                 "install.sh", "install.ps1"]) {
  writeFileSync(join(missingRunner, f), f);
}
let runnerErr = null;
try {
  reshapeToCheckout(missingRunner, join(work, "no-runner-out"));
} catch (err) {
  runnerErr = err.message;
}
check("a tarball missing update-runner.mjs is refused, by name",
  runnerErr && runnerErr.includes("update-runner.mjs"), String(runnerErr));
check("and leaves no half-built directory behind",
  !existsSync(join(work, "no-runner-out")), join(work, "no-runner-out"));

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

// --- release cache freshness --------------------------------------------------
//
// This covers only the pure decision (server/index.js's buildUpdateStatus
// pulls the check out to here for exactly this reason). Whether a cache hit
// actually skips the fetch, and whether a network failure actually leaves a
// good cache entry untouched, are NOT exercised here or anywhere else in this
// suite -- they were verified by reading buildUpdateStatus, not by running it
// under a mocked clock or a mocked fetch.

check("no entry is never fresh", isCacheFresh(null, 1_000_000, 1000) === false);
check("undefined is never fresh", isCacheFresh(undefined, 1_000_000, 1000) === false);
check("a malformed entry with no `at` is never fresh",
  isCacheFresh({ latest: "1.2.0" }, 1_000_000, 1000) === false);
check("one millisecond inside the TTL is fresh",
  isCacheFresh({ at: 1_000_000 - 999 }, 1_000_000, 1000) === true);
check("exactly at the TTL boundary is NOT fresh (< , not <=)",
  isCacheFresh({ at: 1_000_000 - 1000 }, 1_000_000, 1000) === false);
check("well past the TTL is not fresh",
  isCacheFresh({ at: 1_000_000 - 5000 }, 1_000_000, 1000) === false);

// --- the task-name sanitiser --------------------------------------------------
//
// A dotted systemd unit name parses its trailing segment as the unit TYPE, so
// "cc-chrome-update-1.2.1-99.service" would not be the unit anyone thinks it
// is. This used to be inline in server/index.js, on the branch nobody could
// run, and dropping the .replace() there turned no test red.

check("updateTaskName replaces every dot so the systemd unit type can't be confused",
  !updateTaskName("1.2.1", 99).includes("."), updateTaskName("1.2.1", 99));
check("updateTaskName still carries the version and pid, dash-joined",
  updateTaskName("1.2.1", 99).includes("1-2-1"), updateTaskName("1.2.1", 99));

// --- how the runner is handed over, per platform ----------------------------
//
// The runner must not be a descendant of the service, because stopping the
// service is the installer's first act and every platform's stop kills
// differently. Measured 2026-08-16: macOS's `launchctl bootout` leaves a
// detached child running (heartbeat 18 -> 26), so darwin keeps spawning
// directly. Windows' Stop-CcTask ends in `taskkill /T /F`, which kills
// descendants by parent PID, and Linux's `systemctl --user disable --now` takes
// the whole cgroup — detached:true is setsid(), which does not leave a cgroup.
//
// Windows does NOT go through `schtasks /create ... /tr ...`: that /tr command
// line hit schtasks' documented 262-character maximum with a realistic
// node.exe + install-dir + work-dir path (measured 459-501 chars on the
// controller's machine, 2026-08-16), so /create silently failed and pressing
// the update button did nothing at all. It goes through one PowerShell
// invocation (Register-ScheduledTask + Start-ScheduledTask) instead.
{
  const base = {
    node: "/usr/bin/node", runner: "/inst/update-runner.mjs", args: ["--port", "8787"],
    taskName: "cc-update-1", workingDir: "/tmp/cc-update-work",
  };

  const mac = buildRunnerSpawn("darwin", base);
  check("darwin spawns node directly — measured safe under launchctl bootout",
    mac.command === "/usr/bin/node" && mac.args[0] === "/inst/update-runner.mjs", JSON.stringify(mac));
  check("darwin passes the runner's own arguments through",
    mac.args.includes("--port") && mac.args.includes("8787"), JSON.stringify(mac.args));
  check("darwin is asynchronous — the spawned process IS the runner and must outlive us",
    mac.sync === false, String(mac.sync));

  const linux = buildRunnerSpawn("linux", base);
  check("linux hands the runner to systemd so it gets its own cgroup",
    linux.command === "systemd-run", linux.command);
  check("linux runs it as a user unit, not a scope — a scope stays a child of the caller",
    linux.args.includes("--user") && linux.args.some((a) => a.startsWith("--unit=")) && !linux.args.includes("--scope"),
    JSON.stringify(linux.args));
  check("linux lets systemd clean the unit up afterwards",
    linux.args.includes("--collect"), JSON.stringify(linux.args));
  check("linux still ends with node, the runner and its arguments",
    linux.args.includes("/usr/bin/node") && linux.args.includes("/inst/update-runner.mjs") && linux.args.includes("8787"),
    JSON.stringify(linux.args));
  check("linux is synchronous — systemd-run is a launcher we must wait on and check",
    linux.sync === true, String(linux.sync));

  const win = buildRunnerSpawn("win32", base);
  check("win32 goes through powershell, not schtasks /create directly",
    win.command === "powershell", win.command);
  check("win32 passes -NoProfile -ExecutionPolicy Bypass -Command",
    win.args[0] === "-NoProfile" && win.args[1] === "-ExecutionPolicy" && win.args[2] === "Bypass" && win.args[3] === "-Command",
    JSON.stringify(win.args.slice(0, 4)));
  const winScript = win.args[4];
  check("win32's script registers a scheduled task",
    winScript.includes("Register-ScheduledTask"), winScript);
  check("win32's script starts it in the same invocation, not a separate schtasks /run",
    winScript.includes("Start-ScheduledTask"), winScript);
  check("win32's script allows running on battery power",
    winScript.includes("-AllowStartIfOnBatteries") && winScript.includes("-DontStopIfGoingOnBatteries"), winScript);
  check("win32's script names the task it was given",
    winScript.includes("cc-update-1"), winScript);
  check("win32's script carries the runner path and its own arguments",
    winScript.includes("/inst/update-runner.mjs") && winScript.includes("--port") && winScript.includes("8787"), winScript);
  check("win32 is synchronous — powershell is a launcher we must wait on and check",
    win.sync === true, String(win.sync));

  const winQuoted = buildRunnerSpawn("win32", { ...base, taskName: "cc-up'date" });
  const quotedScript = winQuoted.args[4];
  check("win32 doubles a single quote in an interpolated value instead of ending the string early",
    quotedScript.includes("cc-up''date") && !quotedScript.includes("cc-up'date"), quotedScript);

  let badPlatform = null;
  try {
    buildRunnerSpawn("sunos", base);
  } catch (err) {
    badPlatform = err.message;
  }
  check("an unsupported platform is refused by name rather than silently spawning something",
    badPlatform && badPlatform.includes("sunos"), String(badPlatform));
}

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
