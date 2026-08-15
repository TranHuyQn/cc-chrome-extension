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
import { cpSync, rmSync, existsSync, writeFileSync, renameSync } from "node:fs";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const source = arg("source");
const installDir = arg("install-dir");
const installer = arg("installer");
const port = Number(arg("port", "8787"));
const expectVersion = arg("expect-version");
const statusFile = arg("status-file");
const healthTimeoutMs = Number(arg("health-timeout-ms", "30000"));
const backupDir = `${installDir}.bak`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeStatus(record) {
  try {
    writeFileSync(statusFile, JSON.stringify({ ...record, at: new Date().toISOString() }, null, 2));
  } catch { /* a status we cannot write must not mask the outcome it describes */ }
}

async function healthVersion() {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
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
    const child = spawn(command, args, {
      env: { ...process.env, CC_CHROME_SOURCE: source },
      cwd: process.env.TMPDIR || process.env.TEMP || "/tmp",
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

// Restores the backup wholesale rather than trying to undo what the installer
// did. The installer may have deleted files as well as replaced them, so a
// file-by-file repair would silently miss the deletions.
function rollback() {
  if (!existsSync(backupDir)) return false;
  rmSync(installDir, { recursive: true, force: true });
  renameSync(backupDir, installDir);
  return true;
}

async function main() {
  if (!source || !installDir || !installer || !expectVersion || !statusFile) {
    writeStatus({ ok: false, step: "bad-args", reason: "Thiếu tham số cho trình cập nhật." });
    process.exit(2);
  }

  rmSync(backupDir, { recursive: true, force: true });
  cpSync(installDir, backupDir, { recursive: true });

  const code = await runInstaller();

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
      ? `Bản ${expectVersion} cài xong nhưng bridge không lên (installer trả mã ${code}, /health báo ${seen ?? "không phản hồi"}). Đã khôi phục bản cũ.`
      : `Bản ${expectVersion} cài thất bại và không có bản sao lưu để khôi phục. Chạy lại lệnh cài trong README.`,
  });
  process.exit(1);
}

main();
