// Runs install.sh and uninstall.sh against a throwaway HOME. Nothing here
// touches the real machine: HOME is a temp dir, and CC_CHROME_SKIP_SERVICE
// keeps launchctl/systemctl out of the user's real login session — except
// for the one uninstall call below that specifically needs the real
// cc_service_stop to run, which instead gets FAKE launchctl/systemctl
// binaries shadowed onto PATH so it still never reaches the real thing.
//
// Usage: node test/install.test.mjs

import { spawnSync } from "node:child_process";
import {
  mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync, statSync,
  copyFileSync, readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(name, cond, detail = "") {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}

function mode(path) {
  return statSync(path).mode & 0o777;
}

const fakeHome = mkdtempSync(join(tmpdir(), "cc-install-home-"));
const installDir = join(fakeHome, ".cc-chrome-bridge");

// A stub `claude` on PATH: the installer registers the MCP server through it,
// and the test asserts on what it was asked to do rather than needing the real
// CLI (which would mutate the tester's own MCP config).
//
// It also has to track registration state, not just log calls: uninstall.sh's
// idempotency depends on `claude mcp remove --scope user chrome` actually
// reflecting whether an earlier `mcp add` ran, the way the real CLI does. A
// stub that always exits 0 would make every uninstall run believe there was
// still something to remove, re-"removing" it and reporting 1 item forever.
const binDir = join(fakeHome, "bin");
mkdirSync(binDir, { recursive: true });
const claudeLog = join(fakeHome, "claude-calls.log");
const mcpMarker = join(fakeHome, "claude-mcp-chrome-registered");
writeFileSync(
  join(binDir, "claude"),
  `#!/usr/bin/env bash
echo "$@" >> "${claudeLog}"
if [ "$1" = "mcp" ] && [ "$2" = "add" ]; then
  : > "${mcpMarker}"
elif [ "$1" = "mcp" ] && [ "$2" = "remove" ]; then
  had="${mcpMarker}"
  [ -f "$had" ] || exit 1
  rm -f "$had"
elif [ "$1" = "mcp" ] && [ "$2" = "get" ]; then
  [ -f "${mcpMarker}" ] && exit 0 || exit 1
fi
exit 0
`,
  { mode: 0o755 },
);

// Fake launchctl/systemctl: shadow the real ones on PATH so that one specific
// test call below can run the REAL cc_service_stop (not CC_CHROME_SKIP_SERVICE
// short-circuited) without ever touching a real service. `bootout`/`disable`
// append a marker recording whether installDir/server still existed at that
// exact moment — proof the service was actually stopped (not just that some
// unrelated status line was printed) AND proof of the real ordering (not a
// stdout-text proxy for it). `print`/`is-active` report "not loaded", the
// healthy post-stop state, so the normal-path assertions aren't disturbed.
const stopLog = join(fakeHome, "service-stop.log");
writeFileSync(
  join(binDir, "launchctl"),
  `#!/usr/bin/env bash
if [ "$1" = "bootout" ]; then
  exists=no; [ -e "${installDir}/server" ] && exists=yes
  echo "bootout server_exists=$exists" >> "${stopLog}"
  exit 0
elif [ "$1" = "print" ]; then
  exit 1
fi
exit 0
`,
  { mode: 0o755 },
);
writeFileSync(
  join(binDir, "systemctl"),
  `#!/usr/bin/env bash
if [ "$1" = "--user" ] && [ "$2" = "disable" ]; then
  exists=no; [ -e "${installDir}/server" ] && exists=yes
  echo "disable server_exists=$exists" >> "${stopLog}"
  exit 0
elif [ "$1" = "--user" ] && [ "$2" = "is-active" ]; then
  exit 3
fi
exit 0
`,
  { mode: 0o755 },
);

// Whitelisted, not spread from process.env: a tester with e.g. CC_CHROME_PORT
// or CC_CHROME_RELEASE_URL exported in their own shell would otherwise leak
// into the child and produce confusing, environment-dependent failures.
const passthroughKeys = ["PATH", "TMPDIR", "LANG", "LC_ALL", "SHELL"];
const baseEnv = {};
for (const key of passthroughKeys) {
  if (process.env[key] !== undefined) baseEnv[key] = process.env[key];
}
baseEnv.HOME = fakeHome;
baseEnv.PATH = `${binDir}:${process.env.PATH ?? ""}`;
baseEnv.CC_CHROME_SKIP_SERVICE = "1";
baseEnv.CC_CHROME_SOURCE = root; // install from this checkout instead of downloading

// runRaw never throws and never assumes success — it hands back the real
// exit status so a test can assert on it directly, instead of `true` always
// passing because a thrown exception was never caught.
function runRaw(script, args = [], envOverrides = {}) {
  const env = { ...baseEnv, ...envOverrides };
  return spawnSync("bash", [join(root, "scripts", script), ...args], { env, encoding: "utf8" });
}

function run(script, args = [], envOverrides = {}) {
  const r = runRaw(script, args, envOverrides);
  if (r.status !== 0) {
    throw new Error(`${script} ${args.join(" ")} exited ${r.status}\n${r.stdout}\n${r.stderr}`);
  }
  return r.stdout;
}

// --- every .ps1 must start with a UTF-8 BOM ---------------------------------
//
// Windows PowerShell 5.1 — the interpreter every Windows 10/11 has, and the one
// the documented install command lands on — reads a BOM-less file as the
// machine's ANSI code page, not UTF-8. These scripts print Vietnamese, so
// without the BOM every accented string turns to mojibake AND the mangled bytes
// break the quoting: CI caught install.ps1 and uninstall.ps1 failing to PARSE at
// all ("Unexpected token 'â†’ Dá»«ng dá»‹ch vá»¥'", "The string is missing the
// terminator"). The installer did not run one line on Windows.
//
// Checked here rather than in the Windows-only suite on purpose: this is a
// property of bytes in the repo, so it should fail on any machine, including the
// Mac where these files get edited.
{
  const BOM = "﻿";
  for (const f of readdirSync(join(root, "scripts")).filter((n) => n.endsWith(".ps1"))) {
    const body = readFileSync(join(root, "scripts", f), "utf8");
    check(`${f} starts with a UTF-8 BOM (PowerShell 5.1 needs it to read UTF-8)`, body.startsWith(BOM));
  }
}

// --- install ---------------------------------------------------------------

const out = run("install.sh");

check("creates the install directory", existsSync(join(installDir, "server", "index.js")));
check("ships the extension folder", existsSync(join(installDir, "extension", "manifest.json")));
check("ships node_modules", existsSync(join(installDir, "server", "node_modules", "ws")));
check("writes a token file", existsSync(join(fakeHome, ".ccchrome.json")));
check("the token file is owner-only (0600)", mode(join(fakeHome, ".ccchrome.json")) === 0o600);
check("the install dir is owner-only (0700)", mode(installDir) === 0o700);

const state = JSON.parse(readFileSync(join(fakeHome, ".ccchrome.json"), "utf8"));
check("the token is at least 16 hex chars", /^[0-9a-f]{16,}$/.test(state.token || ""), state.token);

const tokensFile = join(installDir, "tokens.json");
check("writes tokens.json", existsSync(tokensFile));
check("tokens.json is owner-only (0600)", existsSync(tokensFile) && mode(tokensFile) === 0o600);
const tokensState = existsSync(tokensFile) ? JSON.parse(readFileSync(tokensFile, "utf8")) : {};
const tokensKeys = Object.keys(tokensState);
check(
  "tokens.json's key matches the state token",
  tokensKeys.length === 1 && tokensKeys[0] === state.token,
  JSON.stringify(tokensState),
);

check("installs the slash command", existsSync(join(fakeHome, ".claude", "commands", "ccchrome.md")));

const unit = process.platform === "darwin"
  ? join(fakeHome, "Library", "LaunchAgents", "com.ccchrome.bridge.plist")
  : join(fakeHome, ".config", "systemd", "user", "ccchrome-bridge.service");
check("writes the service unit", existsSync(unit));
check("the unit points at the installed server", readFileSync(unit, "utf8").includes(join(installDir, "server", "index.js")));
// The side panel spawns `claude` once per chat turn, and a service's PATH is
// the OS default — measured under launchd: /usr/bin:/bin:/usr/sbin:/sbin, with
// no package manager's bin directory in it. Without the absolute path baked in
// here, every panel turn fails with "spawn claude ENOENT". The stub `claude` on
// this test's PATH is what the installer resolves.
check(
  "the unit bakes in the absolute path to claude, not a bare command name",
  existsSync(unit) && readFileSync(unit, "utf8").includes(join(binDir, "claude")),
  existsSync(unit) ? readFileSync(unit, "utf8") : "(no unit)",
);

const calls = existsSync(claudeLog) ? readFileSync(claudeLog, "utf8") : "";
check("registers the MCP server with Claude Code", /mcp add .*chrome/.test(calls), calls);
check("registers it over http on loopback", /127\.0\.0\.1:8787\/mcp/.test(calls), calls);
check("prints the ws URL for the popup", /ws:\/\/127\.0\.0\.1:8787\/ws\?token=/.test(out), out.slice(-400));
check("tells the user to Load unpacked", /Load unpacked/i.test(out), out.slice(-400));

// --- rerun is an upgrade, not a second install -----------------------------

const before = state.token;
// Proves the rerun actually replaced server/ rather than being a no-op that
// happens to leave the token file untouched.
const marker = join(installDir, "server", ".rerun-marker");
writeFileSync(marker, "should not survive an upgrade\n");

const rerunOut = run("install.sh");
check("a rerun prints upgrade wording", /nâng cấp/.test(rerunOut), rerunOut.slice(0, 200));

const after = JSON.parse(readFileSync(join(fakeHome, ".ccchrome.json"), "utf8")).token;
check("a rerun keeps the existing token", after === before, `${before} -> ${after}`);
check("a rerun actually replaces the source tree", !existsSync(marker));
// A regression that deletes server/ and fails to restore it would still
// pass both checks above (marker gone, token unchanged) — this is the one
// that actually proves the bridge is still installable after the rerun.
check("a rerun leaves a working server/ in place", existsSync(join(installDir, "server", "index.js")));

// --- uninstall: argument validation (F1) ------------------------------------

// A mistyped flag must never fall through to a real deletion. Reproduced
// against the pre-fix script: `--dryrun` matched neither branch of
// `[ "${1:-}" = "--dry-run" ]` and ran the full uninstall for real, silently.
{
  const before1 = existsSync(join(fakeHome, ".ccchrome.json"));
  const r = runRaw("uninstall.sh", ["--dryrun"]);
  check("an unrecognized flag exits non-zero", r.status !== 0, `status=${r.status}`);
  check("an unrecognized flag prints usage", /Dùng:.*uninstall\.sh/.test(r.stderr + r.stdout), r.stderr);
  check(
    "an unrecognized flag deletes nothing",
    existsSync(join(fakeHome, ".ccchrome.json")) === before1,
    "the token file's presence changed after a rejected flag",
  );
}

// --- uninstall: dry-run and .new cleanup (F3) -------------------------------

// Runtime data the server (not the installer) creates. Must survive.
mkdirSync(join(installDir, "panel"), { recursive: true });
writeFileSync(join(installDir, "panel", "session.jsonl"), "conversation\n");

// A stray .new/ — what install.sh's staging directory looks like after a
// SIGKILL or power loss mid-install, never cleaned by its own EXIT trap.
// Reproduced against the pre-fix script: it wasn't in the deletion loop, so
// it silently blocked the trailing `rmdir` and the whole install dir stayed
// forever while the script still reported "gỡ xong".
mkdirSync(join(installDir, ".new", "server"), { recursive: true });
writeFileSync(join(installDir, ".new", "server", "leftover.txt"), "orphaned staging\n");

const dry = run("uninstall.sh", ["--dry-run"]);
check("dry-run removes nothing", existsSync(join(fakeHome, ".ccchrome.json")));
check("dry-run says what it would remove", /\.ccchrome\.json/.test(dry), dry.slice(0, 400));
check("dry-run mentions the leftover .new staging dir", /\.new/.test(dry), dry);
// Quoted, not a bare interpolation — a HOME with a space must not turn this
// into "rm -rf /Users/john" plus a stray second argument when copy-pasted (F2).
check(
  "the printed panel-removal command is quoted",
  new RegExp(`rm -rf "${installDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/panel"`).test(dry),
  dry,
);
// The MCP advisory line is one of the "  - " bullets the dry-run prints, so
// it has to be counted in the summary too — a preview whose own bullet list
// and its own total disagree isn't trustworthy as a preview.
{
  const dryBullets = dry.split("\n").filter((l) => l.startsWith("  - ")).length;
  const dryTotalMatch = dry.match(/Sẽ gỡ (\d+) mục/);
  check(
    "dry-run's bullet count matches its own total",
    dryTotalMatch !== null && Number(dryTotalMatch[1]) === dryBullets,
    `bullets=${dryBullets} total=${dryTotalMatch?.[1]}\n${dry}`,
  );
}

// --- uninstall: the real, order-verified run (F7) ---------------------------

// The service must be stopped before the source tree is deleted — deleting
// the directory out from under a live process leaves an orphan holding the
// port, and the next install dies on EADDRINUSE. Checking the *order two
// stdout lines print in* only proves two `echo`s ran in some order; it
// proves nothing about whether cc_service_stop itself ever actually ran, and
// nothing stops a refactor from preserving line order while breaking the
// real one. So this run drops CC_CHROME_SKIP_SERVICE — the real cc_service_stop
// executes — but PATH is shadowed with the fake launchctl/systemctl above,
// so it can never reach a real service. The fake records, at the exact
// moment the real stop call happens, whether installDir/server still exists.
//
// This safety rests entirely on binDir staying first on PATH for this one
// call, and on the fakes exiting 0 for any verb they don't specifically
// recognize (cc_platform/cc_unit_label etc. may probe launchctl/systemctl in
// ways not enumerated above). Nothing here asserts the shadowing actually
// took effect — if a future edit reorders PATH construction or this call
// stops passing an env override that survives the spread in runRaw(), this
// would silently start invoking the *real* launchctl/systemctl on the
// tester's machine instead of failing loudly. Whoever touches PATH handling
// in this file should keep that invariant in mind.
//
// The log is truncated immediately before this specific call: it's an
// append-only file with no run boundary of its own, so a stale line from an
// earlier run (or, worse, from a mutation that deletes the cc_service_stop
// call so nothing new is ever appended) could otherwise be mistaken for
// this run's evidence. Asserting "exactly one line, and it says yes" is
// what actually ties the evidence to *this* invocation.
writeFileSync(stopLog, "");
const realOut = run("uninstall.sh", [], { CC_CHROME_SKIP_SERVICE: "" });
check("removes the token file", !existsSync(join(fakeHome, ".ccchrome.json")));
check("removes the slash command", !existsSync(join(fakeHome, ".claude", "commands", "ccchrome.md")));
check("removes the service unit", !existsSync(unit));
check("removes the server directory", !existsSync(join(installDir, "server")));
check("removes the orphaned .new staging directory", !existsSync(join(installDir, ".new")));
check("KEEPS the panel conversation data", existsSync(join(installDir, "panel", "session.jsonl")));

const stopLogLines = existsSync(stopLog) ? readFileSync(stopLog, "utf8").split("\n").filter(Boolean) : [];
check(
  "actually invokes cc_service_stop exactly once this run (not zero, not a stale line)",
  stopLogLines.length === 1,
  JSON.stringify(stopLogLines),
);
check(
  "the service is stopped while the source tree still exists — the real ordering, not a text proxy",
  stopLogLines.length === 1 && stopLogLines[0].includes("server_exists=yes"),
  stopLogLines.join("\n") || realOut.slice(0, 400),
);

const un = runRaw("uninstall.sh");
check("a second uninstall reports nothing to do", /0 mục|không còn gì/i.test(un.stdout), un.stdout.slice(0, 300));
check("and still exits 0", un.status === 0, `status=${un.status}`);

rmSync(fakeHome, { recursive: true, force: true });

// --- the real release flow: one downloaded file, no siblings (C1/I1) --------
//
// Everything above installs with CC_CHROME_SOURCE pointed at this checkout,
// so install.sh always had scripts/service-unit.sh sitting right next to it.
// Neither documented flow looks like that: the user fetches exactly ONE file
// and the tarball carrying service-unit.sh is downloaded ~40 lines into the
// run. Reproduced against the pre-fix script, both of these exited 1 having
// created nothing — `. "$script_dir/service-unit.sh"` ran before anything was
// downloaded ("No such file or directory"), and the piped flow additionally
// died on `BASH_SOURCE[0]: unbound variable` under `set -u`, because a script
// arriving on stdin has no BASH_SOURCE at all.
//
// It is dist/install.sh that is copied, not scripts/install.sh: that is the
// byte-for-byte artifact a user actually downloads, and build.test.mjs's F8
// guard only ever checked that the file exists and matches — never that it
// runs. The tarball is (re)built here rather than reused so this suite is
// correct when run standalone (`npm run test:install`) as well as after
// test/build.test.mjs in the full run.
{
  const relBuild = spawnSync("node", [join(root, "scripts", "build-release.mjs")], { encoding: "utf8" });
  check("release artifacts build", relBuild.status === 0, relBuild.stderr);
  const tarball = join(root, "dist", "cc-chrome-bridge.tar.gz");
  const distInstall = join(root, "dist", "install.sh");
  check("dist/install.sh and the tarball both exist", existsSync(tarball) && existsSync(distInstall));

  // `bash install.sh` and `cat install.sh | bash` fail differently (only the
  // second one has an unbound BASH_SOURCE), so both are run.
  for (const [label, argv] of [
    ["bash install.sh", ["install.sh"]],
    ["cat install.sh | bash", ["-c", "cat install.sh | bash"]],
  ]) {
    const base = mkdtempSync(join(tmpdir(), "cc-install-release-"));
    const home = join(base, "home");
    const only = join(base, "only");
    const bin = join(base, "bin");
    for (const d of [home, only, bin]) mkdirSync(d, { recursive: true });
    copyFileSync(distInstall, join(only, "install.sh"));
    // A stub `claude`, first on PATH, so a tester with the real CLI installed
    // never has it spawned by this suite.
    writeFileSync(join(bin, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

    check(
      `${label}: the download directory holds install.sh and nothing else`,
      readdirSync(only).join(",") === "install.sh",
      readdirSync(only).join(","),
    );

    const env = {};
    for (const key of passthroughKeys) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    env.HOME = home;
    env.PATH = `${bin}:${process.env.PATH ?? ""}`;
    env.CC_CHROME_SKIP_SERVICE = "1";
    // pathToFileURL, not `file://${tarball}`: a repo path containing a space
    // or a '#' would otherwise produce a URL curl cannot fetch.
    env.CC_CHROME_RELEASE_URL = pathToFileURL(tarball).href;

    const r = spawnSync("bash", argv, { cwd: only, env, encoding: "utf8" });
    check(`${label}: exits 0`, r.status === 0, `status=${r.status}\n${r.stdout}\n${r.stderr}`);

    const relInstallDir = join(home, ".cc-chrome-bridge");
    check(`${label}: installs the server`, existsSync(join(relInstallDir, "server", "index.js")));
    check(`${label}: installs the extension`, existsSync(join(relInstallDir, "extension", "manifest.json")));
    check(`${label}: installs node_modules from the tarball`, existsSync(join(relInstallDir, "server", "node_modules", "ws")));
    // service-unit.sh is the file whose absence broke both flows — it has to
    // end up installed, not merely sourced from somewhere.
    check(`${label}: installs service-unit.sh`, existsSync(join(relInstallDir, "service-unit.sh")));
    check(`${label}: installs uninstall.sh`, existsSync(join(relInstallDir, "uninstall.sh")));
    check(`${label}: writes the service unit`, existsSync(
      process.platform === "darwin"
        ? join(home, "Library", "LaunchAgents", "com.ccchrome.bridge.plist")
        : join(home, ".config", "systemd", "user", "ccchrome-bridge.service"),
    ));
    check(`${label}: writes a token file`, existsSync(join(home, ".ccchrome.json")));
    check(`${label}: prints the ws URL for the popup`, /ws:\/\/127\.0\.0\.1:8787\/ws\?token=/.test(r.stdout), r.stdout.slice(-400));

    rmSync(base, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The Linux branch of service-unit.sh, exercised from whatever machine runs
// this suite
// ---------------------------------------------------------------------------
//
// The unit-writing code is three `if [ "$(cc_platform)" = macos ]` branches,
// so on a Mac the Linux half of it had zero coverage and shipped unverified —
// which is how a hardcoded ~/.config and a systemd-240-only directive both got
// in. cc_platform() and cc_systemd_version() reach the outside world through
// exactly two commands, `uname` and `systemctl`, so shadowing those two on
// PATH runs the real script down its real Linux path. Nothing here needs an
// actual Linux box; what it cannot check is whether systemd then ACCEPTS the
// unit, which is what Huy's run on real hardware is for.
{
  const linuxBin = mkdtempSync(join(tmpdir(), "cc-linux-stub-"));
  writeFileSync(join(linuxBin, "uname"), "#!/usr/bin/env bash\necho Linux\n", { mode: 0o755 });
  // Its own `claude` stub, not the one in binDir: that lives under fakeHome,
  // which is deleted well before this block runs. On a machine with the real
  // CLI installed the assertion below still passed — resolving /opt/homebrew/
  // bin/claude instead — so it was green for the wrong reason, and only CI, on
  // a runner with no claude at all, showed the unit coming out with an empty
  // CC_CHROME_CLAUDE_BIN line. Owning the stub makes the check mean the same
  // thing on every machine.
  const linuxClaude = join(linuxBin, "claude");
  writeFileSync(linuxClaude, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

  // Writes the unit with a stubbed systemd version and returns its contents.
  const writeUnitAs = (systemdVersion, envOverrides = {}) => {
    const home = mkdtempSync(join(tmpdir(), "cc-linux-home-"));
    const dir = join(home, ".cc-chrome-bridge");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(linuxBin, "systemctl"),
      `#!/usr/bin/env bash\n[ "$1" = "--version" ] && echo "systemd ${systemdVersion} (${systemdVersion}.4-4ubuntu3)"\nexit 0\n`,
      { mode: 0o755 },
    );
    const env = {
      ...baseEnv,
      HOME: home,
      PATH: `${linuxBin}:${baseEnv.PATH}`,
      ...envOverrides,
    };
    const r = spawnSync(
      "bash",
      ["-c", `. "${join(root, "scripts", "service-unit.sh")}"; cc_write_unit "$1" 8787; echo "UNIT_PATH=$(cc_unit_path)"; echo "LOG_HINT=$(cc_log_hint "$1")"`, "bash", dir],
      { env, encoding: "utf8" },
    );
    const unitPath = (r.stdout.match(/UNIT_PATH=(.*)/) || [])[1];
    const logHint = (r.stdout.match(/LOG_HINT=(.*)/) || [])[1];
    return {
      status: r.status,
      stderr: r.stderr,
      home,
      dir,
      unitPath,
      logHint,
      body: unitPath && existsSync(unitPath) ? readFileSync(unitPath, "utf8") : "",
    };
  };

  const modern = writeUnitAs(245);
  check("linux: cc_write_unit exits 0", modern.status === 0, modern.stderr);
  check(
    "linux: the unit lands under ~/.config/systemd/user when XDG_CONFIG_HOME is unset",
    modern.unitPath === join(modern.home, ".config", "systemd", "user", "ccchrome-bridge.service"),
    modern.unitPath,
  );
  check("linux: the unit points at the installed server", modern.body.includes(join(modern.dir, "server", "index.js")), modern.body);
  check("linux: the unit binds the bridge to loopback", modern.body.includes('Environment="CC_CHROME_HOST=127.0.0.1"'), modern.body);
  check("linux: systemd 245 gets file logging", modern.body.includes("StandardOutput=append:"), modern.body);
  check(
    "linux: the unit bakes in the absolute path to claude",
    modern.body.includes(`Environment="CC_CHROME_CLAUDE_BIN=${linuxClaude}"`),
    modern.body,
  );
  check("linux: systemd 245's log hint is the log file", (modern.logHint || "").endsWith("logs/bridge.err.log"), modern.logHint);

  // The regression this pair exists for: `append:` is 240+, and an older
  // systemd rejects the WHOLE unit rather than ignoring the directive, so the
  // bridge would never start and the log file the installer points at would
  // never be created either.
  const old = writeUnitAs(237);
  check("linux: cc_write_unit exits 0 on old systemd", old.status === 0, old.stderr);
  check("linux: systemd 237 gets no append: directive", !old.body.includes("append:"), old.body);
  check("linux: systemd 237 still gets ExecStart and Restart", old.body.includes("ExecStart=") && old.body.includes("Restart=always"), old.body);
  check(
    "linux: systemd 237's log hint points at the journal, not a file that will never exist",
    (old.logHint || "").startsWith("journalctl --user"),
    old.logHint,
  );

  // XDG_CONFIG_HOME: systemd --user reads $XDG_CONFIG_HOME/systemd/user, so a
  // unit written to ~/.config regardless is invisible to it.
  const xdgRoot = mkdtempSync(join(tmpdir(), "cc-xdg-"));
  const xdg = writeUnitAs(245, { XDG_CONFIG_HOME: xdgRoot });
  check(
    "linux: XDG_CONFIG_HOME decides where the unit goes",
    xdg.unitPath === join(xdgRoot, "systemd", "user", "ccchrome-bridge.service"),
    xdg.unitPath,
  );
  check("linux: the unit really exists at that path", xdg.body.includes("ExecStart="), xdg.unitPath);

  rmSync(linuxBin, { recursive: true, force: true });
  rmSync(xdgRoot, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
