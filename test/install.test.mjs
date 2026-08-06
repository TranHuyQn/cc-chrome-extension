// Runs install.sh and uninstall.sh against a throwaway HOME. Nothing here
// touches the real machine: HOME is a temp dir, and CC_CHROME_SKIP_SERVICE
// keeps launchctl/systemctl out of the user's real login session — except
// for the one uninstall call below that specifically needs the real
// cc_service_stop to run, which instead gets FAKE launchctl/systemctl
// binaries shadowed onto PATH so it still never reaches the real thing.
//
// Usage: node test/install.test.mjs

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
const realOut = run("uninstall.sh", [], { CC_CHROME_SKIP_SERVICE: "" });
check("removes the token file", !existsSync(join(fakeHome, ".ccchrome.json")));
check("removes the slash command", !existsSync(join(fakeHome, ".claude", "commands", "ccchrome.md")));
check("removes the service unit", !existsSync(unit));
check("removes the server directory", !existsSync(join(installDir, "server")));
check("removes the orphaned .new staging directory", !existsSync(join(installDir, ".new")));
check("KEEPS the panel conversation data", existsSync(join(installDir, "panel", "session.jsonl")));

const stopLogContent = existsSync(stopLog) ? readFileSync(stopLog, "utf8") : "";
check("actually invokes cc_service_stop (not just prints about it)", stopLogContent.trim().length > 0, stopLogContent);
check(
  "the service is stopped while the source tree still exists — the real ordering, not a text proxy",
  /server_exists=yes/.test(stopLogContent),
  stopLogContent || realOut.slice(0, 400),
);

const un = runRaw("uninstall.sh");
check("a second uninstall reports nothing to do", /0 mục|không còn gì/i.test(un.stdout), un.stdout.slice(0, 300));
check("and still exits 0", un.status === 0, `status=${un.status}`);

rmSync(fakeHome, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
