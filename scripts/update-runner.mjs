// The one process that outlives the bridge.
//
// The bridge cannot install its own replacement: the installer stops the service
// as its first step, which kills the bridge mid-command and leaves the install
// half done. So the bridge spawns this, detached, and lets go.
//
// What brings the bridge back on the SUCCESS path is the installer's own final
// step (`cc_service_start` / `Register-CcTask` + `Start-CcTask`), not a
// supervisor. launchd KeepAlive, systemd Restart=always and the repeating Task
// Scheduler trigger only cover a crash of a service that is still loaded, and
// the installer's stop step is exactly what unloads it: `launchctl bootout`
// unloads the job, `systemctl --user disable --now` removes the wants link, and
// `Stop-CcTask` calls `Disable-ScheduledTask` before killing. So on the ROLLBACK
// path — where no installer step will ever run again — this process re-arms and
// starts the service itself; see rollback().
//
// It runs with a cwd outside the install directory. On Windows, running from
// inside the directory being replaced is the surest way to lock it.

import { spawn, spawnSync } from "node:child_process";
import { cpSync, rmSync, existsSync, writeFileSync, renameSync, openSync, closeSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

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
const taskName = arg("task-name");
// The absolute path to `claude` the RUNNING bridge was configured with, handed
// over on argv rather than left to inheritance — see childEnv() for why.
const claudeBin = arg("claude-bin");
const backupDir = `${installDir}.bak`;
// Beside the status record, not inside the install directory being replaced.
// A dotfile, like every other artifact this project creates, and truncated per
// run: the log only ever needs to explain the most recent attempt, which is
// exactly what the status record points at.
const logPath = statusFile ? join(dirname(statusFile), ".ccchrome-update.log") : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// How long to wait for /health after re-arming the service on the rollback
// path. Generous on purpose: the alternative to waiting is reporting "the
// bridge did not come back" about a bridge that was two seconds from being up.
const SERVICE_START_TIMEOUT_MS = 20000;

// The environment every child of this runner gets.
//
// PATH is the whole reason this exists. The bridge runs under launchd/systemd
// with the OS default PATH — measured on the owner's macOS machine, on the real
// service process: PATH=/usr/bin:/bin:/usr/sbin:/sbin, while the node running
// it is ~/.nvm/versions/node/v22.23.1/bin/node. Under that PATH both
// `command -v node` and `command -v claude` come back NOT FOUND. Two things
// break without the prepend, and both were reachable on a normal machine:
//   - scripts/install.sh's first preflight is
//     `command -v node >/dev/null 2>&1 || die`, so on every macOS machine whose
//     node came from nvm/fnm/volta/homebrew the update died there. Harmless to
//     the machine (the die is before the service stop) and fatal to the feature.
//   - where node IS on that PATH (distro Linux), cc_write_unit's
//     `command -v claude` resolved empty and the regenerated unit silently
//     dropped CC_CHROME_CLAUDE_BIN, so every later panel turn failed with
//     `spawn claude ENOENT` — with the update already declared a success and the
//     backup already deleted. cc_write_unit now prefers an inherited
//     CC_CHROME_CLAUDE_BIN over that lookup, and this is what puts it there.
// process.execPath is the node actually running this runner, so it is by
// construction a node that exists and can run the bridge. Do not "simplify"
// this away.
//
// CC_CHROME_CLAUDE_BIN arrives on ARGV (--claude-bin) rather than by
// inheritance, for the same reason --port does: only the darwin branch spawns
// this process as a child of the bridge. On linux it is forked by the systemd
// --user manager and on win32 by Task Scheduler, and neither is known to hand
// over the bridge's own environment — measured on macOS that the bridge HAS
// the variable, never measured that those two supervisors pass it along, so
// this does not depend on their doing it. An already-inherited value is
// identical when it exists, so overwriting it costs nothing.
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  if (claudeBin) env.CC_CHROME_CLAUDE_BIN = claudeBin;
  // Windows environment keys are case-insensitive and usually spelled "Path";
  // adding a second "PATH" key would hand the child two of them.
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const nodeDir = dirname(process.execPath);
  env[pathKey] = env[pathKey] ? `${nodeDir}${delimiter}${env[pathKey]}` : nodeDir;
  return env;
}

// Windows only: the one-shot task that gave this process a parent other than
// the bridge. Left behind it would sit in Task Scheduler forever with a start
// time in the past. Best effort — a leftover task is harmless, and failing to
// remove it must never change the outcome that was already recorded.
function removeOwnTask() {
  if (process.platform !== "win32" || !taskName) return;
  try {
    spawnSync("schtasks", ["/delete", "/tn", taskName, "/f"], { stdio: "ignore", windowsHide: true });
  } catch { /* best effort */ }
}

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
      if (logPath) logFd = openSync(logPath, "w");
    } catch { /* logging is best-effort; it must never block the update itself */ }
    // CC_CHROME_PORT: a systemd-run --user transient unit runs with the USER
    // MANAGER's environment, not the bridge's, so on a non-default port an
    // installer that fell back to CC_CHROME_PORT's default (8787) would
    // silently move the service to the wrong port and the extension would
    // lose the bridge. Reasoned, not measured — no Linux machine available to
    // confirm systemd-run drops the caller's environment.
    //
    // Only forwarded when it parses to a finite number: a malformed --port
    // used to be absorbed by the installer's own `${CC_CHROME_PORT:-8787}`
    // fallback, and forwarding "NaN" verbatim would instead propagate into
    // the reinstalled service's configuration.
    //
    // childEnv() is what puts node's own directory on the child's PATH; read
    // its comment before touching this line.
    const env = childEnv({ CC_CHROME_SOURCE: source });
    if (Number.isFinite(port)) env.CC_CHROME_PORT = String(port);
    const child = spawn(command, args, {
      env,
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

// Runs the RESTORED copy of the service library and asks it to start the
// service. The restored copy came out of the backup, so it matches the files it
// is about to launch — a newer copy could describe a unit the restored tree
// cannot serve.
//
// On win32 the task must be re-REGISTERED, not merely started: Stop-CcTask
// calls Disable-ScheduledTask before killing, and Register-CcTask (-Force) is
// what clears that. Register-CcTask reads bridge-launcher.vbs out of the
// install directory, which the restore just put back.
function startRestoredService() {
  const script = process.platform === "win32"
    ? join(installDir, "service-task.ps1")
    : join(installDir, "service-unit.sh");
  if (!existsSync(script)) return { ok: false, detail: `không tìm thấy ${script}` };

  const opts = { stdio: "ignore", windowsHide: true, timeout: 60000, env: childEnv() };
  let result;
  if (process.platform === "win32") {
    const q = (v) => String(v).replace(/'/g, "''");
    const body = `. '${q(script)}'; Register-CcTask -InstallDir '${q(installDir)}'; Start-CcTask`;
    result = spawnSync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `$ErrorActionPreference='Stop'; try { ${body} } catch { exit 1 }`],
      opts,
    );
  } else {
    // The script path travels as $1, never interpolated into the -c string: an
    // install directory with a quote or a space in it must not become code.
    result = spawnSync("bash", ["-c", '. "$1" && cc_service_start', "bash", script], opts);
  }
  if (result.error) return { ok: false, detail: result.error.message };
  if (result.status !== 0) return { ok: false, detail: `mã thoát ${result.status}` };
  return { ok: true, detail: "" };
}

// Makes sure something is serving /health again after a restore, and reports
// honestly what it did. Best effort by construction: whatever happens here, the
// rollback outcome the caller already determined does not change.
//
// The health probe comes FIRST, and that ordering is the safety property: when
// the installer refused before its own stop step (the F1 preflight case, and
// the most common failure there is), the service was never stopped and the
// bridge is still up. Bouncing it there would take a healthy bridge down for no
// reason, and `launchctl bootout` + a failing `bootstrap` would leave the user
// with none at all.
async function ensureServiceUp() {
  if ((await healthVersion()) !== null) {
    return { restarted: false, ok: true, detail: "dịch vụ vẫn đang chạy, không cần khởi động lại" };
  }
  const started = startRestoredService();
  if (!started.ok) return { restarted: true, ok: false, detail: started.detail };

  const deadline = Date.now() + SERVICE_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await healthVersion()) !== null) return { restarted: true, ok: true, detail: "" };
    await sleep(1000);
  }
  return { restarted: true, ok: false, detail: "đã gọi lệnh khởi động nhưng /health vẫn không phản hồi" };
}

// Restores the backup wholesale rather than trying to undo what the installer
// did. The installer may have deleted files as well as replaced them, so a
// file-by-file repair would silently miss the deletions.
//
// Never delete the install directory before the replacement is in place. Moving
// the failed install aside means a failing restore still leaves the machine
// with SOMETHING, and the displaced copy is only removed once the good one is
// home.
//
// Restoring the FILES is not restoring the BRIDGE. If the installer aborted
// between its stop step and its start step, nothing else on the machine will
// ever start the service again (see this file's header on why the supervisors
// do not cover that), and the only record of what happened lives in a status
// file the panel needs a live bridge to read. So the restore is followed by
// ensureServiceUp().
async function rollback() {
  if (!existsSync(backupDir)) return { restored: false, service: null };
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

  let service;
  try {
    service = await ensureServiceUp();
  } catch (err) {
    // A restart attempt that throws must not turn a SUCCESSFUL file restore
    // into a "crashed" record naming paths that no longer hold anything.
    service = { restarted: true, ok: false, detail: err && err.message ? err.message : String(err) };
  }
  return { restored: true, service };
}

async function main() {
  if (!source || !work || !installDir || !installer || !expectVersion || !statusFile) {
    writeStatus({ ok: false, step: "bad-args", reason: "Thiếu tham số cho trình cập nhật." });
    removeOwnTask();
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
    // A leftover temp dir must never change the reported outcome — this whole
    // branch exists to explain the refusal clearly, and an EPERM/EBUSY here
    // must not escape to main().catch() and get mislabelled "crashed".
    try { rmSync(work, { recursive: true, force: true }); } catch { /* best-effort cleanup only */ }
    writeStatus({
      ok: false,
      step: "already-running",
      version: expectVersion,
      reason: `Có vẻ một bản cập nhật trước đã dừng giữa chừng. Bản cài cũ đang nằm ở ${backupDir}. ` +
        `Nếu bridge hiện tại chạy bình thường, đổi tên ${backupDir} thành một tên khác rồi thử lại. ` +
        `Nếu bridge không chạy: đổi tên ${installDir} thành ${installDir}.failed (nếu nó còn tồn tại), ` +
        `rồi đổi tên ${backupDir} thành ${installDir} để khôi phục bản cũ. ` +
        `Nhật ký lần trước: ${logPath}`,
    });
    removeOwnTask();
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
    removeOwnTask();
    process.exit(0);
  }

  const { restored, service } = await rollback();

  // Two different failures, and the old message described only one of them.
  // `code !== 0` means the installer REFUSED — most often at a preflight, with
  // nothing on the machine touched (that is what the F1 PATH bug looked like
  // from here) — so telling the user "cài xong nhưng bridge không lên" both
  // contradicts the log the same sentence points at and invents an install that
  // never started.
  let reason;
  if (!restored) {
    reason = `Bản ${expectVersion} cài thất bại và không có bản sao lưu để khôi phục. ` +
      `Xem log tại ${logPath}. Chạy lại lệnh cài trong README.`;
  } else if (code !== 0) {
    reason = `Trình cài đặt bản ${expectVersion} đã dừng lại và không cài gì (mã ${code}). ` +
      `Bản đang dùng được giữ nguyên. Xem log tại ${logPath}.`;
  } else {
    reason = `Bản ${expectVersion} cài xong nhưng bridge không lên ` +
      `(/health báo ${seen ?? "không phản hồi"}). Đã khôi phục bản cũ. Xem log tại ${logPath}.`;
  }
  // Recorded, never swallowed: after a rollback the bridge may be the only way
  // the user ever sees this record, so "we could not start it again" has to be
  // in the sentence they read, not only in a field beside it.
  if (service && !service.ok) {
    reason += ` Chưa khởi động lại được dịch vụ nền (${service.detail}) — ` +
      `chạy lại lệnh cài trong README để dựng lại dịch vụ.`;
  }
  writeStatus({
    ok: false,
    step: restored ? "rolled-back" : "failed-no-backup",
    version: expectVersion,
    service,
    reason,
  });
  removeOwnTask();
  process.exit(1);
}

main().catch((err) => {
  // A crash that leaves no record is the worst outcome here: the panel would
  // show the PREVIOUS update's result, which may well say everything is fine.
  // A crash inside rollback() is the highest-stakes one there is, so the
  // record must name every path that might hold a copy of something —
  // not just the error message.
  // A leftover temp dir must never cost us the crash record itself — this is
  // the one status write that matters most, and an EPERM/EBUSY here must not
  // stop it from being written.
  if (work) { try { rmSync(work, { recursive: true, force: true }); } catch { /* best-effort cleanup only */ } }
  writeStatus({
    ok: false,
    step: "crashed",
    version: expectVersion,
    reason: `Trình cập nhật gặp lỗi: ${err && err.message ? err.message : String(err)}. ` +
      `Bản cài cũ (nếu còn) ở ${backupDir}; bản cài lỗi (nếu có) ở ${installDir}.failed; nhật ký ở ${logPath}.`,
  });
  removeOwnTask();
  process.exit(3);
});
