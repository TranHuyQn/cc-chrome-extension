// The one process that outlives the bridge.
//
// The bridge cannot install its own replacement: the installer stops the service
// as its first step, which kills the bridge mid-command and leaves the install
// half done. So the bridge spawns this, detached, and lets go. All three
// platforms resurrect the bridge on their own — launchd KeepAlive, systemd
// Restart=always, a repeating Task Scheduler trigger — so this never starts the
// service itself.
//
// It runs with a cwd outside the install directory. On Windows, running from
// inside the directory being replaced is the surest way to lock it.

import { spawn } from "node:child_process";
import { cpSync, rmSync, existsSync, writeFileSync, renameSync, openSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  // A trailing flag with nothing after it (or absent entirely) must fall back,
  // not read past the end of argv into undefined — Number(undefined) is NaN,
  // and a NaN deadline runs the health-check loop zero times.
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1];
}

const source = arg("source");
const work = arg("work");
const installDir = arg("install-dir");
const installer = arg("installer");
const port = Number(arg("port", "8787"));
const expectVersion = arg("expect-version");
const statusFile = arg("status-file");
const healthTimeoutMs = Number(arg("health-timeout-ms", "30000"));
const backupDir = `${installDir}.bak`;
// Beside the status record, not inside the install directory being replaced.
const logPath = statusFile ? join(dirname(statusFile), "ccchrome-update.log") : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeStatus(record) {
  try {
    writeFileSync(statusFile, JSON.stringify({ ...record, at: new Date().toISOString() }, null, 2));
  } catch { /* a status we cannot write must not mask the outcome it describes */ }
}

async function healthVersion() {
  try {
    // A port that accepts TCP and never answers must not hang this loop
    // forever — bound every probe on its own.
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body?.version === "string" ? body.version : null;
  } catch {
    return null;
  }
}

function runInstaller() {
  return new Promise((resolve) => {
    const isPs1 = installer.toLowerCase().endsWith(".ps1");
    const command = isPs1 ? "powershell" : (installer.endsWith(".sh") ? "bash" : installer);
    const args = isPs1 ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installer] : [installer];
    // The one process that can leave a machine unbootable must not throw its
    // own output away: a failure otherwise has an exit code and nothing else.
    let logFd = null;
    try {
      if (logPath) logFd = openSync(logPath, "a");
    } catch { /* logging is best-effort; it must never block the update itself */ }
    const child = spawn(command, args, {
      env: { ...process.env, CC_CHROME_SOURCE: source },
      cwd: process.env.TMPDIR || process.env.TEMP || "/tmp",
      stdio: ["ignore", logFd ?? "ignore", logFd ?? "ignore"],
      windowsHide: true,
    });
    const finish = (code) => {
      // A failed spawn emits BOTH 'error' and 'close', so this runs twice. Null
      // the fd out after the first close — otherwise the second closeSync could
      // land on an unrelated descriptor that has since reclaimed the same
      // integer (a health-probe socket, another openSync).
      if (logFd !== null) {
        try { closeSync(logFd); } catch { /* already closed */ }
        logFd = null;
      }
      resolve(code);
    };
    child.on("error", () => finish(1));
    child.on("close", (code) => finish(code ?? 1));
  });
}

// Restores the backup wholesale rather than trying to undo what the installer
// did. The installer may have deleted files as well as replaced them, so a
// file-by-file repair would silently miss the deletions.
//
// Never delete the install directory before the replacement is in place. Moving
// the failed install aside means a failing restore still leaves the machine
// with SOMETHING, and the displaced copy is only removed once the good one is
// home.
function rollback() {
  if (!existsSync(backupDir)) return false;
  const failedDir = `${installDir}.failed`;
  rmSync(failedDir, { recursive: true, force: true });
  if (existsSync(installDir)) renameSync(installDir, failedDir);
  try {
    renameSync(backupDir, installDir);
  } catch (err) {
    // The restore failed. Put the failed install back rather than leaving the
    // machine with no install directory at all.
    if (!existsSync(installDir) && existsSync(failedDir)) renameSync(failedDir, installDir);
    throw err;
  }
  rmSync(failedDir, { recursive: true, force: true });
  return true;
}

async function main() {
  if (!source || !work || !installDir || !installer || !expectVersion || !statusFile) {
    writeStatus({ ok: false, step: "bad-args", reason: "Thiếu tham số cho trình cập nhật." });
    process.exit(2);
  }

  // A second runner (the restarted bridge, after the first one's installer
  // killed it) must not stomp the first one's only copy of a working install.
  // Its own first act used to be an unconditional rmSync of this directory.
  //
  // backupDir most often survives because a PREVIOUS runner crashed — and a
  // runner crashes most often during or after the installer ran, which is
  // exactly when installDir is wrecked and backupDir is the only intact copy
  // on the machine. So the advice here must never be "delete it".
  if (existsSync(backupDir)) {
    rmSync(work, { recursive: true, force: true });
    writeStatus({
      ok: false,
      step: "already-running",
      version: expectVersion,
      reason: `Có vẻ một bản cập nhật trước đã dừng giữa chừng. Bản cài cũ đang nằm ở ${backupDir}. ` +
        `Nếu bridge hiện tại chạy bình thường, đổi tên ${backupDir} thành một tên khác rồi thử lại. ` +
        `Nếu bridge không chạy, đổi tên ${backupDir} thành ${installDir} để khôi phục bản cũ. ` +
        `Nhật ký lần trước: ${logPath}`,
    });
    process.exit(4);
  }

  cpSync(installDir, backupDir, { recursive: true });

  const code = await runInstaller();

  // The reshaped source is only needed until the installer has read it. Every
  // successful update used to leak a node_modules-bearing copy into the temp
  // directory forever; clean it up on every path from here on.
  rmSync(work, { recursive: true, force: true });

  const deadline = Date.now() + healthTimeoutMs;
  let seen = null;
  while (Date.now() < deadline) {
    seen = await healthVersion();
    if (seen === expectVersion) break;
    await sleep(1000);
  }

  if (seen === expectVersion) {
    rmSync(backupDir, { recursive: true, force: true });
    writeStatus({ ok: true, step: "installed", version: expectVersion });
    process.exit(0);
  }

  const restored = rollback();
  writeStatus({
    ok: false,
    step: restored ? "rolled-back" : "failed-no-backup",
    version: expectVersion,
    reason: restored
      ? `Bản ${expectVersion} cài xong nhưng bridge không lên (installer trả mã ${code}, ` +
        `/health báo ${seen ?? "không phản hồi"}). Đã khôi phục bản cũ. Xem log tại ${logPath}.`
      : `Bản ${expectVersion} cài thất bại và không có bản sao lưu để khôi phục. ` +
        `Xem log tại ${logPath}. Chạy lại lệnh cài trong README.`,
  });
  process.exit(1);
}

main().catch((err) => {
  // A crash that leaves no record is the worst outcome here: the panel would
  // show the PREVIOUS update's result, which may well say everything is fine.
  // A crash inside rollback() is the highest-stakes one there is, so the
  // record must name every path that might hold a copy of something —
  // not just the error message.
  if (work) rmSync(work, { recursive: true, force: true });
  writeStatus({
    ok: false,
    step: "crashed",
    version: expectVersion,
    reason: `Trình cập nhật gặp lỗi: ${err && err.message ? err.message : String(err)}. ` +
      `Bản cài cũ (nếu còn) ở ${backupDir}; bản cài lỗi (nếu có) ở ${installDir}.failed; nhật ký ở ${logPath}.`,
  });
  process.exit(3);
});
