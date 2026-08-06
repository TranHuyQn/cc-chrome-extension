// Runs install.sh and uninstall.sh against a throwaway HOME. Nothing here
// touches the real machine: HOME is a temp dir, and CC_CHROME_SKIP_SERVICE
// keeps launchctl/systemctl out of the user's real login session.
//
// Usage: node test/install.test.mjs

import { execFileSync } from "node:child_process";
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
// A stub `claude` on PATH: the installer registers the MCP server through it,
// and the test asserts on what it was asked to do rather than needing the real
// CLI (which would mutate the tester's own MCP config).
const binDir = join(fakeHome, "bin");
mkdirSync(binDir, { recursive: true });
const claudeLog = join(fakeHome, "claude-calls.log");
writeFileSync(join(binDir, "claude"), `#!/usr/bin/env bash\necho "$@" >> "${claudeLog}"\nexit 0\n`, { mode: 0o755 });

// Whitelisted, not spread from process.env: a tester with e.g. CC_CHROME_PORT
// or CC_CHROME_RELEASE_URL exported in their own shell would otherwise leak
// into the child and produce confusing, environment-dependent failures.
const passthroughKeys = ["PATH", "TMPDIR", "LANG", "LC_ALL", "SHELL"];
const env = {};
for (const key of passthroughKeys) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}
env.HOME = fakeHome;
env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
env.CC_CHROME_SKIP_SERVICE = "1";
env.CC_CHROME_SOURCE = root;     // install from this checkout instead of downloading

function run(script, args = []) {
  return execFileSync("bash", [join(root, "scripts", script), ...args], { env, encoding: "utf8" });
}

// --- install ---------------------------------------------------------------

const out = run("install.sh");
const installDir = join(fakeHome, ".cc-chrome-bridge");

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

// --- uninstall -------------------------------------------------------------

// Runtime data the server (not the installer) creates. Must survive.
mkdirSync(join(installDir, "panel"), { recursive: true });
writeFileSync(join(installDir, "panel", "session.jsonl"), "conversation\n");

const dry = run("uninstall.sh", ["--dry-run"]);
check("dry-run removes nothing", existsSync(join(fakeHome, ".ccchrome.json")));
check("dry-run says what it would remove", /\.ccchrome\.json/.test(dry), dry.slice(0, 400));

run("uninstall.sh");
check("removes the token file", !existsSync(join(fakeHome, ".ccchrome.json")));
check("removes the slash command", !existsSync(join(fakeHome, ".claude", "commands", "ccchrome.md")));
check("removes the service unit", !existsSync(unit));
check("removes the server directory", !existsSync(join(installDir, "server")));
check("KEEPS the panel conversation data", existsSync(join(installDir, "panel", "session.jsonl")));

const un = run("uninstall.sh");
check("a second uninstall reports nothing to do", /0 mục|không còn gì/i.test(un), un.slice(0, 300));
check("and still exits 0", true);

rmSync(fakeHome, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
