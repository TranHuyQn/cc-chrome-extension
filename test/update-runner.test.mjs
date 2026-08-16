// Usage: node test/update-runner.test.mjs
//
// The runner is the one process that outlives the bridge, and the one that can
// leave a machine without a working install. It is driven here against a FAKE
// installer and a FAKE health endpoint, in a temp HOME — the same shape
// test/install.test.mjs uses — so both the success path and the rollback path
// run for real without touching anything installed.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runner = join(root, "scripts", "update-runner.mjs");

let failures = 0;
function check(name, cond, detail = "") {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}

// A stand-in /health that reports whatever version the test tells it to.
function healthServer(versionRef) {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, version: versionRef.value }));
  });
  return new Promise((res) => server.listen(0, "127.0.0.1", () => res(server)));
}

function runRunner(args, envOverlay = {}) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [runner, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...envOverlay },
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => res({ code, out }));
  });
}

async function waitUntil(cond, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  return cond();
}

// --- 1. the happy path: install succeeds, health reports the new version -----

{
  const home = mkdtempSync(join(tmpdir(), "cc-runner-ok-"));
  const installDir = join(home, ".cc-chrome-bridge");
  mkdirSync(join(installDir, "server"), { recursive: true });
  writeFileSync(join(installDir, "server", "index.js"), "// OLD");

  // The payload lives in its own work dir, separate from `home` — the runner
  // deletes --work once the installer returns, and it must not take the
  // install dir or the status file down with it.
  const work = mkdtempSync(join(tmpdir(), "cc-runner-work-ok-"));
  const source = join(work, "source");
  mkdirSync(join(source, "server"), { recursive: true });
  writeFileSync(join(source, "server", "index.js"), "// NEW");

  // A fake installer that does what a real one does to the bits we care about:
  // copy the source over the install dir.
  const installer = join(home, "fake-install.sh");
  writeFileSync(installer, `#!/bin/sh\nrm -rf "${installDir}/server"\ncp -R "$CC_CHROME_SOURCE/server" "${installDir}/server"\n`);
  chmodSync(installer, 0o755);

  const version = { value: "1.2.0" };
  const server = await healthServer(version);
  const status = join(home, "status.json");

  const { code } = await runRunner([
    "--source", source, "--work", work, "--install-dir", installDir, "--installer", installer,
    "--port", String(server.address().port), "--expect-version", "1.2.0", "--status-file", status,
  ]);
  server.close();

  check("a successful update exits 0", code === 0, String(code));
  check("the new files are in place", readFileSync(join(installDir, "server", "index.js"), "utf8") === "// NEW");
  const record = JSON.parse(readFileSync(status, "utf8"));
  check("it records success", record.ok === true, JSON.stringify(record));
  check("it records the version it installed", record.version === "1.2.0", JSON.stringify(record));
  check("the backup is cleaned up on success", !existsSync(`${installDir}.bak`), `${installDir}.bak`);
  check("the payload work dir is cleaned up after use", !existsSync(work), work);
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}

// --- 2. rollback: health never reports the new version -----------------------
//
// This is the case the whole backup exists for. The installer "succeeds" but the
// bridge that comes back is still the old version — a crash-looping new build
// looks exactly like this from outside.

{
  const home = mkdtempSync(join(tmpdir(), "cc-runner-rollback-"));
  const installDir = join(home, ".cc-chrome-bridge");
  mkdirSync(join(installDir, "server"), { recursive: true });
  writeFileSync(join(installDir, "server", "index.js"), "// OLD");
  writeFileSync(join(installDir, "tokens.json"), '{"keep":"me"}');

  const work = mkdtempSync(join(tmpdir(), "cc-runner-work-rb-"));
  const source = join(work, "source");
  mkdirSync(join(source, "server"), { recursive: true });
  writeFileSync(join(source, "server", "index.js"), "// NEW-BROKEN");

  const installer = join(home, "fake-install.sh");
  writeFileSync(installer, `#!/bin/sh\nrm -rf "${installDir}/server"\ncp -R "$CC_CHROME_SOURCE/server" "${installDir}/server"\nrm -f "${installDir}/tokens.json"\n`);
  chmodSync(installer, 0o755);

  const version = { value: "1.1.0" }; // never becomes 1.2.0
  const server = await healthServer(version);
  const status = join(home, "status.json");

  const { code } = await runRunner([
    "--source", source, "--work", work, "--install-dir", installDir, "--installer", installer,
    "--port", String(server.address().port), "--expect-version", "1.2.0",
    "--status-file", status, "--health-timeout-ms", "3000",
  ]);
  server.close();

  check("a failed update exits non-zero", code !== 0, String(code));
  check("the OLD files are back", readFileSync(join(installDir, "server", "index.js"), "utf8") === "// OLD");
  check("files the installer deleted are restored too",
    existsSync(join(installDir, "tokens.json")), "tokens.json");
  const record = JSON.parse(readFileSync(status, "utf8"));
  check("it records the rollback", record.ok === false && record.step === "rolled-back", JSON.stringify(record));
  check("and says why, in words a user can act on", typeof record.reason === "string" && record.reason.length > 10,
    JSON.stringify(record));
  check("the payload work dir is cleaned up even on rollback", !existsSync(work), work);
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}

// --- 3. the status file is written outside the install directory -----------
//
// Written outside the install dir on purpose: a rollback replaces that whole
// directory, and a status file inside it would be destroyed by the very event it
// exists to explain. The invariant lives in server/index.js, so that is what has
// to be read — a test that compares two paths it made up itself proves nothing
// about the product.

{
  const source = readFileSync(join(root, "server", "index.js"), "utf8");
  const installLine = source.split("\n").find((l) => l.includes("const INSTALL_DIR"));
  const statusLine = source.split("\n").find((l) => l.includes("const UPDATE_STATUS_FILE"));
  check("the status file is not written inside the install directory",
    !!statusLine && !statusLine.includes("INSTALL_DIR"),
    `${installLine} | ${statusLine}`);
}

// --- 4. a second runner must not stomp the first one's backup ---------------
//
// The bridge process that started runner A is the one the installer kills; the
// restarted bridge can turn straight around and accept another update_start,
// spawning runner B while A is still mid-flight. B's first act used to be an
// unconditional rmSync of A's only backup.

{
  const home = mkdtempSync(join(tmpdir(), "cc-runner-twice-"));
  const installDir = join(home, ".cc-chrome-bridge");
  mkdirSync(join(installDir, "server"), { recursive: true });
  writeFileSync(join(installDir, "server", "index.js"), "// OLD");
  const backupDir = `${installDir}.bak`;

  const workA = mkdtempSync(join(tmpdir(), "cc-runner-work-a-"));
  const sourceA = join(workA, "source");
  mkdirSync(join(sourceA, "server"), { recursive: true });
  writeFileSync(join(sourceA, "server", "index.js"), "// NEW-A");

  // A slow installer so runner A is still holding the backup when B starts.
  const installerA = join(home, "slow-install.sh");
  writeFileSync(installerA, `#!/bin/sh\nsleep 2\nrm -rf "${installDir}/server"\ncp -R "$CC_CHROME_SOURCE/server" "${installDir}/server"\n`);
  chmodSync(installerA, 0o755);

  const version = { value: "1.2.0" };
  const server = await healthServer(version);
  const statusA = join(home, "status-a.json");
  const statusB = join(home, "status-b.json");

  const runA = runRunner([
    "--source", sourceA, "--work", workA, "--install-dir", installDir, "--installer", installerA,
    "--port", String(server.address().port), "--expect-version", "1.2.0", "--status-file", statusA,
  ]);

  const gotBackup = await waitUntil(() => existsSync(backupDir));
  check("runner A took the backup before B starts", gotBackup);

  const workB = mkdtempSync(join(tmpdir(), "cc-runner-work-b-"));
  const sourceB = join(workB, "source");
  mkdirSync(join(sourceB, "server"), { recursive: true });
  writeFileSync(join(sourceB, "server", "index.js"), "// NEW-B");
  const installerB = join(home, "fake-install-b.sh");
  writeFileSync(installerB, `#!/bin/sh\nrm -rf "${installDir}/server"\ncp -R "$CC_CHROME_SOURCE/server" "${installDir}/server"\n`);
  chmodSync(installerB, 0o755);

  const { code: codeB } = await runRunner([
    "--source", sourceB, "--work", workB, "--install-dir", installDir, "--installer", installerB,
    "--port", String(server.address().port), "--expect-version", "1.2.0", "--status-file", statusB,
  ]);

  check("runner B refuses while A's backup still exists", codeB === 4, String(codeB));
  const recordB = JSON.parse(readFileSync(statusB, "utf8"));
  check("B records why it refused", recordB.ok === false && recordB.step === "already-running", JSON.stringify(recordB));
  // backupDir usually survives because a PREVIOUS runner crashed, at which
  // point it is the only intact install on the machine — the refusal message
  // must tell the user to rename/restore it, never to delete it.
  check("the refusal never tells the user to delete the only good backup",
    !/xoá\s+\S*\.bak/i.test(recordB.reason || ""), recordB.reason);
  check("the refusal tells the user how to restore from the backup instead",
    /đổi tên/i.test(recordB.reason || "") && recordB.reason.includes(backupDir), recordB.reason);
  check("B's own payload work dir is cleaned up even on refusal", !existsSync(workB), workB);

  const { code: codeA } = await runA;
  check("runner A still completes normally, undisturbed by B", codeA === 0, String(codeA));
  const recordA = JSON.parse(readFileSync(statusA, "utf8"));
  check("A's own record shows success", recordA.ok === true, JSON.stringify(recordA));

  server.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(workA, { recursive: true, force: true });
  rmSync(workB, { recursive: true, force: true });
}

// --- 5. the installer binary itself is missing: spawn fails, not hangs ------
//
// child_process.spawn's ENOENT surfaces asynchronously via 'error', not as a
// throw at the call site. This proves the runner still reaches a status file
// (via the normal rollback path) instead of hanging forever on a promise that
// never resolves.

{
  const home = mkdtempSync(join(tmpdir(), "cc-runner-noinstaller-"));
  const installDir = join(home, ".cc-chrome-bridge");
  mkdirSync(join(installDir, "server"), { recursive: true });
  writeFileSync(join(installDir, "server", "index.js"), "// OLD");

  const work = mkdtempSync(join(tmpdir(), "cc-runner-work-ni-"));
  const source = join(work, "source");
  mkdirSync(join(source, "server"), { recursive: true });
  writeFileSync(join(source, "server", "index.js"), "// NEW");

  // No extension recognised as .sh/.ps1, so runInstaller tries to exec this
  // path directly — and it does not exist.
  const installer = join(home, "does-not-exist");

  const version = { value: "1.1.0" };
  const server = await healthServer(version);
  const status = join(home, "status.json");

  const { code } = await runRunner([
    "--source", source, "--work", work, "--install-dir", installDir, "--installer", installer,
    "--port", String(server.address().port), "--expect-version", "1.2.0",
    "--status-file", status, "--health-timeout-ms", "1500",
  ]);
  server.close();

  check("a missing installer still exits non-zero, not a hang", code !== 0 && code !== null, String(code));
  const record = JSON.parse(readFileSync(status, "utf8"));
  check("it rolls back (installer never ran, health never matched)",
    record.ok === false && record.step === "rolled-back", JSON.stringify(record));
  // The old-content check alone is vacuous here — the installer never touched
  // installDir, so it would pass even with rollback() deleted outright. Proving
  // rollback actually ran means proving the backup was CONSUMED by it: a
  // successful rollback renames backupDir into installDir, so backupDir no
  // longer exists afterward.
  check("the backup was consumed by the rollback, not left untouched",
    !existsSync(`${installDir}.bak`), `${installDir}.bak`);
  check("the install directory still holds the old contents after rollback",
    readFileSync(join(installDir, "server", "index.js"), "utf8") === "// OLD");

  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}

// --- 6. a genuine crash still leaves a record, not the previous run's -------
//
// Before this fix, an uncaught throw (e.g. cpSync failing because the install
// dir doesn't exist) exited with no status write at all, so the panel kept
// showing whatever the LAST update said — possibly ok:true — while this one had
// actually died.

{
  const home = mkdtempSync(join(tmpdir(), "cc-runner-crash-"));
  const installDir = join(home, ".cc-chrome-bridge"); // deliberately never created

  const work = mkdtempSync(join(tmpdir(), "cc-runner-work-crash-"));
  const source = join(work, "source");
  mkdirSync(join(source, "server"), { recursive: true });
  writeFileSync(join(source, "server", "index.js"), "// NEW");

  const installer = join(home, "fake-install.sh");
  writeFileSync(installer, "#!/bin/sh\ntrue\n");
  chmodSync(installer, 0o755);

  const status = join(home, "status.json");
  // Seed a PREVIOUS successful record, to prove the crash overwrites it rather
  // than leaving it in place for the panel to keep reading.
  writeFileSync(status, JSON.stringify({ ok: true, step: "installed", version: "1.1.0" }));

  const { code } = await runRunner([
    "--source", source, "--work", work, "--install-dir", installDir, "--installer", installer,
    "--port", "1", "--expect-version", "1.2.0", "--status-file", status,
  ]);

  check("a crash exits non-zero with its own code", code === 3, String(code));
  const record = JSON.parse(readFileSync(status, "utf8"));
  check("the crash record replaces the previous run's record", record.step === "crashed", JSON.stringify(record));
  check("it does not still say ok:true from the previous run", record.ok === false, JSON.stringify(record));
  check("the crash record names where the pieces might be, not just the error",
    typeof record.reason === "string" && record.reason.includes(".bak") && record.reason.includes(".failed"),
    record.reason);
  check("the payload work dir is cleaned up even when the runner crashes", !existsSync(work), work);

  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}

// --- 7. the installer is invoked through the right interpreter --------------
//
// A .ps1 handed to bash, or a .sh handed to powershell, fails in a way that
// looks exactly like "the installer errored" — and it would only ever show up
// on the platform nobody develops on.

{
  const home = mkdtempSync(join(tmpdir(), "cc-runner-interp-"));
  const installDir = join(home, ".cc-chrome-bridge");
  mkdirSync(installDir, { recursive: true });
  const source = join(home, "source");
  mkdirSync(source, { recursive: true });
  const argvLog = join(home, "argv.txt");
  const work = mkdtempSync(join(tmpdir(), "cc-runner-work-interp-"));

  // A .sh installer that records how it was invoked, then does nothing.
  const shInstaller = join(home, "fake.sh");
  writeFileSync(shInstaller, `#!/bin/sh\necho "$0" > "${argvLog}"\n`);
  chmodSync(shInstaller, 0o755);

  const version = { value: "9.9.9" };
  const server = await healthServer(version);
  await runRunner([
    "--source", source, "--work", work, "--install-dir", installDir, "--installer", shInstaller,
    "--port", String(server.address().port), "--expect-version", "9.9.9",
    "--status-file", join(home, "status.json"),
  ]);
  server.close();
  check("a .sh installer is run through bash and actually executes",
    existsSync(argvLog) && readFileSync(argvLog, "utf8").includes("fake.sh"),
    existsSync(argvLog) ? readFileSync(argvLog, "utf8") : "(not run)");
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}

// --- 8. a .ps1 installer is handed to powershell, not to bash ---------------
//
// The mirror image of test 7, and the direction nothing else can catch: a .ps1
// routed to bash fails in a way that reads as "the installer errored", and only
// on the platform this repo cannot run. A fake executable named `powershell` on
// PATH closes that, because Node's spawn resolves a bare command name through
// PATH on every platform — no Windows required.
{
  const home = mkdtempSync(join(tmpdir(), "cc-runner-ps1-"));
  const installDir = join(home, ".cc-chrome-bridge");
  mkdirSync(installDir, { recursive: true });
  const source = join(home, "source");
  mkdirSync(source, { recursive: true });
  const work = join(home, "work");
  mkdirSync(work, { recursive: true });

  const binDir = join(home, "bin");
  mkdirSync(binDir, { recursive: true });
  const argvLog = join(home, "ps-argv.txt");
  const fakePowershell = join(binDir, "powershell");
  writeFileSync(fakePowershell, `#!/bin/sh\necho "$@" > "${argvLog}"\n`);
  chmodSync(fakePowershell, 0o755);

  const installer = join(home, "fake-install.ps1");
  writeFileSync(installer, "# a PowerShell installer that never needs to run\n");

  const version = { value: "7.7.7" };
  const server = await healthServer(version);
  await runRunner([
    "--source", source, "--install-dir", installDir, "--installer", installer,
    "--work", work, "--port", String(server.address().port),
    "--expect-version", "7.7.7", "--status-file", join(home, "status.json"),
  ], { PATH: `${binDir}:${process.env.PATH}` });
  server.close();

  const recorded = existsSync(argvLog) ? readFileSync(argvLog, "utf8") : "";
  check("a .ps1 installer is invoked through powershell, not bash",
    recorded.includes("fake-install.ps1"), recorded || "(powershell never ran)");
  check("and it is passed -File, so the script is executed rather than read as an argument",
    recorded.includes("-File"), recorded);
  check("and -ExecutionPolicy Bypass, without which a Restricted machine refuses the file",
    recorded.includes("Bypass"), recorded);
  rmSync(home, { recursive: true, force: true });
}

// --- 9. the installer learns the port through CC_CHROME_PORT too ------------
//
// A `systemd-run --user` transient unit runs with the USER MANAGER's own
// environment, not the bridge's, so on a non-default port an installer that
// fell back to its own default (8787) would silently move the running service
// to the wrong port and the extension would lose the bridge. Reasoned, not
// measured — no Linux machine available to confirm systemd-run drops the
// caller's environment; what IS measured here is that the runner passes
// CC_CHROME_PORT to the installer's child process regardless of platform.

{
  const home = mkdtempSync(join(tmpdir(), "cc-runner-port-env-"));
  const installDir = join(home, ".cc-chrome-bridge");
  mkdirSync(installDir, { recursive: true });
  const source = join(home, "source");
  mkdirSync(source, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "cc-runner-work-port-"));
  const portLog = join(home, "port.txt");

  // A fake installer that records the env var it was actually given, not the
  // --port argv the runner itself was invoked with.
  const installer = join(home, "fake-install.sh");
  writeFileSync(installer, `#!/bin/sh\necho "$CC_CHROME_PORT" > "${portLog}"\n`);
  chmodSync(installer, 0o755);

  const version = { value: "5.5.5" };
  const server = await healthServer(version);
  const port = server.address().port;
  await runRunner([
    "--source", source, "--work", work, "--install-dir", installDir, "--installer", installer,
    "--port", String(port), "--expect-version", "5.5.5",
    "--status-file", join(home, "status.json"),
  ]);
  server.close();

  const recordedPort = existsSync(portLog) ? readFileSync(portLog, "utf8").trim() : "";
  check("the installer is invoked with CC_CHROME_PORT matching the --port it was given",
    recordedPort === String(port), `expected "${port}", got "${recordedPort}"`);
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}

// --- 10. a malformed --port is never forwarded as CC_CHROME_PORT="NaN" ------
//
// A malformed --port used to be absorbed by the installer's own
// ${CC_CHROME_PORT:-8787} fallback (never reaching the installer's env at
// all); forwarding "NaN" verbatim would instead propagate a bad port straight
// into the reinstalled service's own configuration.

{
  const home = mkdtempSync(join(tmpdir(), "cc-runner-badport-"));
  const installDir = join(home, ".cc-chrome-bridge");
  mkdirSync(installDir, { recursive: true });
  const source = join(home, "source");
  mkdirSync(source, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "cc-runner-work-badport-"));
  const portLog = join(home, "port.txt");

  // Brackets make an unset var distinguishable from a set-but-empty one.
  const installer = join(home, "fake-install.sh");
  writeFileSync(installer, `#!/bin/sh\necho "[$CC_CHROME_PORT]" > "${portLog}"\n`);
  chmodSync(installer, 0o755);

  await runRunner([
    "--source", source, "--work", work, "--install-dir", installDir, "--installer", installer,
    "--port", "not-a-number", "--expect-version", "5.5.6",
    "--status-file", join(home, "status.json"), "--health-timeout-ms", "300",
  ]);

  const recorded = existsSync(portLog) ? readFileSync(portLog, "utf8").trim() : "";
  check("a malformed --port is never forwarded to the installer as CC_CHROME_PORT",
    recorded === "[]", `expected "[]" (unset), got "${recorded}"`);
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}

// --- 11. the log is a dotfile beside the status record, truncated per run ---
//
// dirname(statusFile) is $HOME, so a non-dotfile log would be the only thing
// this project ever leaves visible in a directory listing there. It is also
// opened "w", not "a": the log only ever needs to explain the most recent
// attempt, so a run must not carry forward what an earlier run wrote.

{
  const home = mkdtempSync(join(tmpdir(), "cc-runner-log-"));
  const installDir = join(home, ".cc-chrome-bridge");
  mkdirSync(join(installDir, "server"), { recursive: true });
  writeFileSync(join(installDir, "server", "index.js"), "// OLD");

  const installer = join(home, "fake-install.sh");
  writeFileSync(
    installer,
    `#!/bin/sh\necho "installer ran"\nrm -rf "${installDir}/server"\ncp -R "$CC_CHROME_SOURCE/server" "${installDir}/server"\n`,
  );
  chmodSync(installer, 0o755);

  const status = join(home, "status.json");
  const dotLogPath = join(home, ".ccchrome-update.log");
  const oldNonDotLogPath = join(home, "ccchrome-update.log");
  const version = { value: "1.2.0" };

  async function runOnce() {
    const work = mkdtempSync(join(tmpdir(), "cc-runner-work-log-"));
    const source = join(work, "source");
    mkdirSync(join(source, "server"), { recursive: true });
    writeFileSync(join(source, "server", "index.js"), "// NEW");
    const server = await healthServer(version);
    const { code } = await runRunner([
      "--source", source, "--work", work, "--install-dir", installDir, "--installer", installer,
      "--port", String(server.address().port), "--expect-version", "1.2.0", "--status-file", status,
    ]);
    server.close();
    rmSync(work, { recursive: true, force: true });
    return code;
  }

  const code1 = await runOnce();
  check("first run succeeds", code1 === 0, String(code1));
  check("the log is written as a dotfile", existsSync(dotLogPath), dotLogPath);
  check("the pre-fix non-dotfile name is never created", !existsSync(oldNonDotLogPath), oldNonDotLogPath);
  const firstLog = existsSync(dotLogPath) ? readFileSync(dotLogPath, "utf8") : "";
  check("the first run's log records the installer output",
    (firstLog.match(/installer ran/g) || []).length === 1, JSON.stringify(firstLog));

  const code2 = await runOnce();
  check("second run succeeds", code2 === 0, String(code2));
  const secondLog = existsSync(dotLogPath) ? readFileSync(dotLogPath, "utf8") : "";
  check("a second run truncates the log rather than appending to it",
    (secondLog.match(/installer ran/g) || []).length === 1, JSON.stringify(secondLog));

  rmSync(home, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
