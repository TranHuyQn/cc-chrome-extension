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

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
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

const env = {
  ...process.env,
  USERPROFILE: fakeHome,
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
// Run(..., 0, True): 0 hides the console window, True makes wscript wait. With
// False the task reads as finished while node still runs, which breaks both
// the already-running check and restart-on-failure.
const vbsBody = existsSync(join(installDir, "bridge-launcher.vbs"))
  ? readFileSync(join(installDir, "bridge-launcher.vbs"), "utf8")
  : "";
check("the shim runs hidden and waits", /,\s*0,\s*True/.test(vbsBody), vbsBody);

check("prints the ws URL for the popup", /ws:\/\/127\.0\.0\.1:8787\/ws\?token=/.test(out.stdout), out.stdout.slice(-400));
check("tells the user to Load unpacked", /Load unpacked/i.test(out.stdout), out.stdout.slice(-400));

// The upgrade path keeps the token, so the user does not have to re-paste the
// ws URL into the popup on every update.
const second = ps(join(root, "scripts", "install.ps1"));
check("re-running install.ps1 exits 0", second.status === 0, `${second.stdout}\n${second.stderr}`);
check("it takes the upgrade path", /nâng cấp/.test(second.stdout), second.stdout.slice(0, 200));
const state2 = JSON.parse(readFileSync(join(fakeHome, ".ccchrome.json"), "utf8"));
check("the upgrade keeps the same token", state2.token === state.token, `${state.token} -> ${state2.token}`);

const un = ps(join(installDir, "uninstall.ps1"));
check("uninstall.ps1 exits 0", un.status === 0, `${un.stdout}\n${un.stderr}`);
check("uninstall removes the token file", !existsSync(join(fakeHome, ".ccchrome.json")));
check("uninstall removes the installed tree", !existsSync(join(installDir, "server")));
check("uninstall removes the slash command", !existsSync(join(fakeHome, ".claude", "commands", "ccchrome.md")));

// Idempotent: uninstalling twice must not error on things that are already
// gone, or a half-finished first run leaves the user stuck.
const un2 = ps(join(root, "scripts", "uninstall.ps1"));
check("uninstall.ps1 is idempotent", un2.status === 0, `${un2.stdout}\n${un2.stderr}`);

rmSync(fakeHome, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
