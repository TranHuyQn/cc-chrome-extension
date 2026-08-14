// Runs install.ps1 / uninstall.ps1 against a throwaway USERPROFILE. Nothing
// here touches the real machine: USERPROFILE is a temp dir and
// CC_CHROME_SKIP_SERVICE keeps Task Scheduler out of the real logon session.
//
// Skips with exit 0 off Windows rather than failing. The whole point of this
// file is the platform test/install.test.mjs cannot reach — it drives bash and
// the unix service layer — and a hard failure on macOS would only teach
// everyone to stop reading the output. The consequence is worth stating
// plainly: a green run on a Mac says nothing about Windows. CI
// (windows-latest) is what actually executes these.
//
// Usage: node test/install-windows.test.mjs

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.log(`SKIP  install-windows: only runs on Windows (this machine is ${process.platform})`);
  console.log("\nALL TESTS PASSED");
  process.exit(0);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(name, cond, detail = "") {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}

const fakeHome = mkdtempSync(join(tmpdir(), "cc-win-home-"));
const installDir = join(fakeHome, ".cc-chrome-bridge");

// A stand-in `claude` on PATH. Without one, Get-Command claude fails inside
// install.ps1 and the whole MCP registration block is skipped — which is how a
// crash in that block reached a user through a green CI run. The stub matters
// most for what it does WRONG on purpose: `mcp remove` with nothing registered
// writes to stderr and exits 1, exactly like the real CLI ("No MCP server named
// 'chrome' in user scope"), and that is the case a first install always hits.
const stubBin = join(fakeHome, "bin");
mkdirSync(stubBin, { recursive: true });
const mcpMarker = join(fakeHome, "mcp-chrome-registered");
writeFileSync(
  join(stubBin, "claude-stub.mjs"),
  `import { existsSync, writeFileSync, rmSync } from "node:fs";
const marker = ${JSON.stringify(mcpMarker)};
const a = process.argv.slice(2);
if (a[0] === "mcp" && a[1] === "remove") {
  if (existsSync(marker)) { rmSync(marker); process.exit(0); }
  process.stderr.write('No MCP server named "chrome" in user scope\\n');
  process.exit(1);
}
if (a[0] === "mcp" && a[1] === "add") { writeFileSync(marker, a.join(" ")); process.exit(0); }
process.exit(0);
`,
);
// Node, not batch branching: this has to be right on the first try, and it is
// the same interpreter the suite already depends on.
writeFileSync(
  join(stubBin, "claude.cmd"),
  `@echo off\r\nnode "%~dp0claude-stub.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n`,
);

const env = {
  ...process.env,
  USERPROFILE: fakeHome,
  PATH: `${stubBin};${process.env.PATH}`,
  CC_CHROME_SKIP_SERVICE: "1",
  CC_CHROME_SOURCE: root,
};

// powershell.exe (5.1) rather than pwsh: it is the one guaranteed to exist on
// every Windows 10/11, which is exactly the interpreter the documented install
// command lands on, so it is the one that has to work.
const ps = (file) =>
  spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file], {
    env,
    encoding: "utf8",
  });

const out = ps(join(root, "scripts", "install.ps1"));
check("install.ps1 exits 0", out.status === 0, `${out.stdout}\n${out.stderr}`);
check("installs the server", existsSync(join(installDir, "server", "index.js")));
check("installs the extension", existsSync(join(installDir, "extension", "manifest.json")));
check("ships node_modules", existsSync(join(installDir, "server", "node_modules", "ws")));
check("writes the launcher cmd", existsSync(join(installDir, "bridge.cmd")));
check("writes the vbs shim", existsSync(join(installDir, "bridge-launcher.vbs")));
// service-task.ps1 and uninstall.ps1 have to end up INSTALLED, not merely
// sourced from a checkout: the release-download path is the one most users
// take, and uninstall has to keep working after the checkout is gone.
check("installs service-task.ps1 next to the tree", existsSync(join(installDir, "service-task.ps1")));
check("installs uninstall.ps1 next to the tree", existsSync(join(installDir, "uninstall.ps1")));
check("installs the slash command", existsSync(join(fakeHome, ".claude", "commands", "ccchrome.md")));
check("writes a token file", existsSync(join(fakeHome, ".ccchrome.json")));

const state = existsSync(join(fakeHome, ".ccchrome.json"))
  ? JSON.parse(readFileSync(join(fakeHome, ".ccchrome.json"), "utf8"))
  : {};
check("the token is at least 16 hex chars", /^[0-9a-f]{16,}$/.test(state.token || ""), String(state.token));
check("the state file records the port", state.port === 8787, String(state.port));

const tokensPath = join(installDir, "tokens.json");
// Asserted separately, and before parsing: the ACL the installer applies has
// locked the owner out of this file before (inheritance flags on a file make
// the ACE inherit-only), and the symptom was existsSync reading false — which
// the ternary below would have quietly turned into an empty-object comparison
// rather than a pointed failure.
check("tokens.json is readable by the user who installed it", existsSync(tokensPath), tokensPath);
const tokens = existsSync(tokensPath) ? JSON.parse(readFileSync(tokensPath, "utf8")) : {};
check(
  "tokens.json holds exactly the state token and nothing else",
  Object.keys(tokens).length === 1 && tokens[state.token] === "local",
  JSON.stringify(tokens),
);

const cmdBody = existsSync(join(installDir, "bridge.cmd"))
  ? readFileSync(join(installDir, "bridge.cmd"), "utf8")
  : "";
check("the launcher binds the bridge to loopback", cmdBody.includes("CC_CHROME_HOST=127.0.0.1"), cmdBody);
check("the launcher points at the installed server", cmdBody.includes(join(installDir, "server", "index.js")), cmdBody);
check(
  "the launcher redirects both streams to the log files the installer names",
  cmdBody.includes("bridge.log") && cmdBody.includes("bridge.err.log"),
  cmdBody,
);
// Only asserted when a claude CLI is actually on the runner's PATH: the
// installer bakes in what it can resolve, and a machine without the CLI is a
// legitimate state (server/agent.js falls back and says what to do). The
// property that matters is that a bare name is never what gets baked in.
if (spawnSync("where.exe", ["claude"], { encoding: "utf8" }).status === 0) {
  check(
    "the launcher bakes in the absolute path to claude",
    /set CC_CHROME_CLAUDE_BIN=.+claude/i.test(cmdBody),
    cmdBody,
  );
} else {
  console.log("SKIP  claude CLI is not installed on this machine, so there is no path to bake in");
}
// Run(..., 0, True): 0 hides the console window, True makes wscript wait. With
// False the task reads as finished while node still runs, which breaks both
// the already-running check and restart-on-failure.
const vbsBody = existsSync(join(installDir, "bridge-launcher.vbs"))
  ? readFileSync(join(installDir, "bridge-launcher.vbs"), "utf8")
  : "";
check("the shim runs hidden and waits", /,\s*0,\s*True/.test(vbsBody), vbsBody);

// The regression this exists for: on a FIRST install `claude mcp remove` has
// nothing to remove, writes to stderr and exits 1. Redirecting a native
// command's stderr under $ErrorActionPreference='Stop' turns that into a
// terminating error, so install.ps1 died one line before registering the
// server — after the bridge was already installed and running, and before it
// printed the ws URL the user needs. Reported from a real Windows machine;
// CI could not see it because there was no `claude` on PATH at all.
check(
  "a first install survives `claude mcp remove` having nothing to remove",
  /Đã đăng ký MCP server/.test(out.stdout),
  out.stdout.slice(-600),
);
check("the MCP server really got registered", existsSync(mcpMarker), mcpMarker);
check(
  "the registration points at the loopback bridge with the generated token",
  existsSync(mcpMarker) && readFileSync(mcpMarker, "utf8").includes("http://127.0.0.1:8787/mcp"),
  existsSync(mcpMarker) ? readFileSync(mcpMarker, "utf8") : "(missing)",
);

check("prints the ws URL for the popup", /ws:\/\/127\.0\.0\.1:8787\/ws\?token=/.test(out.stdout), out.stdout.slice(-400));
check("tells the user to Load unpacked", /Load unpacked/i.test(out.stdout), out.stdout.slice(-400));

// The upgrade path keeps the token, so the user does not have to re-paste the
// ws URL into the popup on every update.
const second = ps(join(root, "scripts", "install.ps1"));
check("re-running install.ps1 exits 0", second.status === 0, `${second.stdout}\n${second.stderr}`);
check("it takes the upgrade path", /nâng cấp/.test(second.stdout), second.stdout.slice(0, 200));
const state2 = JSON.parse(readFileSync(join(fakeHome, ".ccchrome.json"), "utf8"));
check("the upgrade keeps the same token", state2.token === state.token, `${state.token} -> ${state2.token}`);

// Start the bridge the way the scheduled task does — through bridge.cmd, so
// node inherits the same stdout/stderr redirection into logs\. That handle is
// the whole point: stopping the TASK does not stop node (the task runs
// wscript, node is its grandchild), and the uninstall then failed deleting
// logs\bridge.err.log with "The process cannot access the file because it is
// being used by another process" — halfway through, with a live server still
// holding port 8787. Reported from a real Windows machine.
const bridge = spawn("cmd.exe", ["/c", join(installDir, "bridge.cmd")], {
  env,
  detached: true,
  stdio: "ignore",
});
bridge.unref();
const errLog = join(installDir, "logs", "bridge.err.log");
// Waited on /health, not on the log file existing: the log gets its startup
// banner even when the server then dies (bad token file, port in use), and a
// dead bridge would make every assertion below pass for the wrong reason.
const bridgeUp = () => {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-Command",
    "try { (Invoke-WebRequest -Uri http://127.0.0.1:8787/health -UseBasicParsing -TimeoutSec 2).StatusCode } catch { 0 }"],
    { encoding: "utf8" });
  return (r.stdout || "").trim() === "200";
};
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  up = bridgeUp();
  if (!up) spawnSync("powershell.exe", ["-NoProfile", "-Command", "Start-Sleep -Milliseconds 500"]);
}
check(
  "the bridge really started and is serving before the uninstall runs",
  up,
  existsSync(errLog) ? readFileSync(errLog, "utf8").slice(-400) : "(no log at all)",
);

// Matched on the directory NAME, not the full path: %USERPROFILE% on a CI
// runner resolves to an 8.3 short form (C:\Users\RUNNER~1\...) in the
// process's command line while Node reports the long one here, so a full-path
// pattern silently matched nothing — and made the assertion below pass on an
// empty set, which is the failure mode this whole case exists to prevent.
const countBridgeProcs = () => {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-Command",
    "@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
    "Where-Object { $_.CommandLine -like '*cc-chrome-bridge*server*index.js*' }).Count"],
    { encoding: "utf8" });
  return Number((r.stdout || "").trim());
};
check("that bridge is visible as a running node process", countBridgeProcs() > 0, String(countBridgeProcs()));

const un = ps(join(installDir, "uninstall.ps1"));
check("uninstall.ps1 exits 0", un.status === 0, `${un.stdout}\n${un.stderr}`);
check("uninstall removes the token file", !existsSync(join(fakeHome, ".ccchrome.json")));
check("uninstall unregisters the MCP server", !existsSync(mcpMarker), mcpMarker);
check("uninstall removes the installed tree", !existsSync(join(installDir, "server")));
// The assertion the reported bug would have failed: the task is not the
// process, and deleting the tree while node still holds the log file is what
// broke the uninstall in the middle.
check("uninstall stops the running bridge, not just its scheduled task", countBridgeProcs() === 0, String(countBridgeProcs()));
check("uninstall removes the slash command", !existsSync(join(fakeHome, ".claude", "commands", "ccchrome.md")));

// Idempotent: uninstalling twice must not error on things that are already
// gone, or a half-finished first run leaves the user stuck.
const un2 = ps(join(root, "scripts", "uninstall.ps1"));
check("uninstall.ps1 is idempotent", un2.status === 0, `${un2.stdout}\n${un2.stderr}`);

// ---------------------------------------------------------------------------
// Phase 2: the real service. Everything above runs with CC_CHROME_SKIP_SERVICE,
// so Register/Start/Stop/Unregister had never once executed here — and that is
// exactly where the next defect was: the task carries a five-minute repetition
// trigger, so killing the bridge while the task still exists lets Task
// Scheduler start a fresh one, and the uninstall then finds a live server and
// refuses to delete anything. Reported from a real machine; no amount of
// SKIP_SERVICE testing could have reached it.
// ---------------------------------------------------------------------------
{
  const envReal = { ...env };
  delete envReal.CC_CHROME_SKIP_SERVICE;
  const psReal = (file) =>
    spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file], {
      env: envReal,
      encoding: "utf8",
    });

  const install2 = psReal(join(root, "scripts", "install.ps1"));
  check("real-service install exits 0", install2.status === 0, `${install2.stdout}\n${install2.stderr}`);

  const taskState = () => {
    const r = spawnSync("powershell.exe", ["-NoProfile", "-Command",
      "(Get-ScheduledTask ccchrome-bridge -ErrorAction SilentlyContinue).State"], { encoding: "utf8" });
    return (r.stdout || "").trim();
  };
  check("the scheduled task exists after a real install", taskState().length > 0, taskState());
  // Running, not Ready: Ready means the launcher returned immediately and the
  // task is not tracking the bridge at all, which breaks both the
  // already-running check and restart-on-failure.
  check("the task is Running, not Ready", taskState() === "Running", taskState());

  let served = false;
  for (let i = 0; i < 40 && !served; i++) {
    served = bridgeUp();
    if (!served) spawnSync("powershell.exe", ["-NoProfile", "-Command", "Start-Sleep -Milliseconds 500"]);
  }
  check("the real service actually serves /health", served, "no 200 from /health within 20s");

  const un3 = psReal(join(installDir, "uninstall.ps1"));
  check("uninstall of a real service exits 0", un3.status === 0, `${un3.stdout}\n${un3.stderr}`);
  check("the scheduled task is gone", taskState().length === 0, taskState());
  check("no bridge process survives the uninstall", countBridgeProcs() === 0, String(countBridgeProcs()));
  check("the install dir is gone", !existsSync(join(installDir, "server")));
}

// Never leave a bridge behind on the runner if an assertion above failed.
spawnSync("powershell.exe", ["-NoProfile", "-Command",
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
  "Where-Object { $_.CommandLine -like '*cc-chrome-bridge*' } | " +
  "ForEach-Object { taskkill /pid $_.ProcessId /T /F }"]);
spawnSync("powershell.exe", ["-NoProfile", "-Command",
  "Unregister-ScheduledTask -TaskName ccchrome-bridge -Confirm:$false -ErrorAction SilentlyContinue"]);
rmSync(fakeHome, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
