// The decision half of the update path: what the newest release is, whether it
// is newer than us, where its files live, and whether what arrived is what was
// published. The doing half — stopping the service, replacing files, restarting
// — belongs to install.sh / install.ps1 and to scripts/update-runner.mjs.
//
// Nothing here spawns anything or writes into the installed copy, which is why
// all of it is testable from node with no network.

import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, cpSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

export const REPO = "TranHuyQn/cc-chrome-extension";
export const TARBALL_NAME = "cc-chrome-bridge.tar.gz";
export const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;

// Numeric segment compare, not lexical: "1.10.0" is newer than "1.9.0", and a
// string compare gets that backwards at exactly the moment it starts to matter.
export function compareVersions(a, b) {
  const parse = (v) => String(v ?? "").replace(/^v/, "").split(".").map((n) => Number(n) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l > r) return 1;
    if (l < r) return -1;
  }
  return 0;
}

// The tag arrives from the network and is pasted straight into a download URL.
// Anything that is not a plain version — a slash, a space, a traversal — must be
// refused before it can shape a request.
export function isValidTag(tag) {
  return typeof tag === "string" && /^v?\d+\.\d+\.\d+$/.test(tag);
}

// Extracted so the freshness decision is testable without mocking time or the
// network: the call sites remain untestable, but the rule they apply does not
// have to be.
export function isCacheFresh(entry, now, ttlMs) {
  return !!entry && typeof entry.at === "number" && now - entry.at < ttlMs;
}

export function releaseUrls(tag) {
  if (!isValidTag(tag)) throw new Error(`Tag phát hành không hợp lệ: ${String(tag)}`);
  const tarball = `https://github.com/${REPO}/releases/download/${tag}/${TARBALL_NAME}`;
  return { tarball, checksum: `${tarball}.sha256` };
}

// Accepts both the `shasum -a 256` format ("<hex>  <name>") and a bare hex line,
// because a human writing one by hand will produce either.
export function parseChecksumFile(text) {
  const match = String(text ?? "").match(/\b[0-9a-f]{64}\b/i);
  return match ? match[0].toLowerCase() : null;
}

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

// The release tarball ships a flat layout; both installers' CC_CHROME_SOURCE
// branch expects a checkout layout. Reshaping here is what lets one code path
// drive the installer on all three platforms — the Windows installer fetches
// with Invoke-WebRequest, which does not accept file:// URIs, so pointing it at
// a local tarball was never an option.
export function reshapeToCheckout(extractedDir, targetDir) {
  const need = (relative) => {
    const from = join(extractedDir, relative);
    if (!existsSync(from)) {
      throw new Error(`Gói phát hành thiếu ${relative} — không cài được, bản đang dùng không bị đụng tới.`);
    }
    return from;
  };

  // Every required path is resolved BEFORE anything is written. The whole point
  // of this function is to fail while nothing has been touched yet; validating
  // lazily, inline with the copies, just moves the half-finished state from the
  // install directory into the staging directory the installer is handed next.
  // The last three are what spawnUpdateRunner reads out of the install
  // directory. They are listed here, not just in the tarball, so a release
  // missing them fails while nothing has been touched — the tarball carrying a
  // file is not the same as the installer putting it where the bridge looks.
  const scripts = [
    "uninstall.sh", "service-unit.sh", "uninstall.ps1", "service-task.ps1",
    "update-runner.mjs", "install.sh", "install.ps1",
  ];
  const sources = {
    server: need("server"),
    extension: need("extension"),
    command: need("ccchrome.md"),
    scripts: Object.fromEntries(scripts.map((f) => [f, need(f)])),
  };

  mkdirSync(targetDir, { recursive: true });
  cpSync(sources.server, join(targetDir, "server"), { recursive: true });
  cpSync(sources.extension, join(targetDir, "extension"), { recursive: true });

  const command = join(targetDir, ".claude", "commands", "ccchrome.md");
  mkdirSync(dirname(command), { recursive: true });
  copyFileSync(sources.command, command);

  mkdirSync(join(targetDir, "scripts"), { recursive: true });
  for (const file of scripts) {
    copyFileSync(sources.scripts[file], join(targetDir, "scripts", file));
  }
}

// Load-bearing, not cosmetic: a dotted systemd unit name parses its trailing
// segment as the unit TYPE, so "cc-chrome-update-1.2.1-99.service" is not the
// unit anyone thinks it is. Moved here (out of server/index.js) so a test can
// catch a dropped .replace() — it used to live inline, on the branch nobody
// could run, and deleting the replace turned no test red.
export function updateTaskName(version, pid) {
  return `cc-chrome-update-${version.replace(/\./g, "-")}-${pid}`;
}

// Every value interpolated into a PowerShell single-quoted string must have
// its own `'` doubled, or the string ends early and whatever follows is
// parsed as code. Used for every win32 interpolation below, including the
// task name.
function psQuote(value) {
  return String(value).replace(/'/g, "''");
}

// How the updater is launched so that stopping the service does not kill it.
//
// Takes the platform as an argument, like buildSpawn() in server/agent.js does,
// so all three branches are testable from one machine — which matters here more
// than usual, because the branch that was wrong last time was the one nobody
// could run.
//
// Measured 2026-08-16, each against the command the installer actually runs:
//   macOS   `launchctl bootout`            -> detached child SURVIVES (18 -> 26 heartbeats)
//   Windows `Stop-CcTask` (taskkill /T /F) -> kills descendants by parent PID
//   Linux   `systemctl --user disable --now` -> kills the whole cgroup; NOT measured
//            on real hardware (no Linux machine), reasoned from KillMode=control-group
//
// `sync` tells the caller whether the returned command IS the runner (must be
// launched and let go) or a short-lived LAUNCHER that hands the runner to a
// supervisor and exits (must be waited for, so a failure to hand over is never
// silent). On darwin the spawned process is the runner itself and must outlive
// us, so it can only be asynchronous. On linux and win32 the spawned process is
// `systemd-run` / `powershell` — it registers the real runner with a
// supervisor (systemd, Task Scheduler) and returns, so we can and must wait for
// its exit code.
export function buildRunnerSpawn(platform, { node, runner, args, taskName, workingDir }) {
  if (platform === "darwin") {
    return { command: node, args: [runner, ...args], sync: false };
  }
  if (platform === "linux") {
    // --unit, not --scope: a scope runs in the CALLER's cgroup and would die
    // with it. --unit asks systemd to fork the process itself, giving it its
    // own cgroup and its own lifetime. --collect removes the unit when it exits.
    // workingDir is not used here — the unit gets systemd's own default cwd,
    // which is fine since update-runner.mjs resolves all its own paths from
    // absolute --args.
    return {
      command: "systemd-run",
      args: ["--user", "--collect", `--unit=${taskName}`, node, runner, ...args],
      sync: true,
    };
  }
  if (platform === "win32") {
    // Register-ScheduledTask + Start-ScheduledTask in one PowerShell process,
    // not `schtasks /create ... /tr ...`: the /tr command-line string hits
    // schtasks' documented 262-character maximum well before a realistic
    // node.exe + install-dir + work-dir path does (measured 459-501 chars on
    // this machine), so /create silently fails, stdio is ignored and nothing
    // reads the exit code — pressing the update button did nothing at all. Settings
    // mirror scripts/service-task.ps1's Register-CcTask: AllowStartIfOnBatteries
    // / DontStopIfGoingOnBatteries (schtasks defaults block a task on battery),
    // no ExecutionTimeLimit, MultipleInstances IgnoreNew. LogonType Interactive
    // + RunLevel Limited is what lets this register without administrator
    // rights, same reasoning as service-task.ps1. Deliberately no -Trigger: a
    // trigger-less task is legal and runs on demand only, which also removes
    // the "one-shot trigger already in the past never fires" race between a
    // separate /create and /run.
    const argString = [runner, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
    const script = [
      `$a = New-ScheduledTaskAction -Execute '${psQuote(node)}' -Argument '${psQuote(argString)}' -WorkingDirectory '${psQuote(workingDir)}'`,
      "$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew",
      '$p = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\\$env:USERNAME" -LogonType Interactive -RunLevel Limited',
      `Register-ScheduledTask -TaskName '${psQuote(taskName)}' -Action $a -Settings $s -Principal $p -Force | Out-Null`,
      `Start-ScheduledTask -TaskName '${psQuote(taskName)}'`,
    ].join("; ");
    return {
      command: "powershell",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      sync: true,
    };
  }
  throw new Error(`Không hỗ trợ cập nhật tự động trên nền tảng '${platform}'.`);
}
