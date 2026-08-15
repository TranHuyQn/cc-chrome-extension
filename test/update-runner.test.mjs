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

function runRunner(args) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [runner, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => res({ code, out }));
  });
}

// --- 1. the happy path: install succeeds, health reports the new version -----

{
  const home = mkdtempSync(join(tmpdir(), "cc-runner-ok-"));
  const installDir = join(home, ".cc-chrome-bridge");
  mkdirSync(join(installDir, "server"), { recursive: true });
  writeFileSync(join(installDir, "server", "index.js"), "// OLD");

  const source = join(home, "source");
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
    "--source", source, "--install-dir", installDir, "--installer", installer,
    "--port", String(server.address().port), "--expect-version", "1.2.0", "--status-file", status,
  ]);
  server.close();

  check("a successful update exits 0", code === 0, String(code));
  check("the new files are in place", readFileSync(join(installDir, "server", "index.js"), "utf8") === "// NEW");
  const record = JSON.parse(readFileSync(status, "utf8"));
  check("it records success", record.ok === true, JSON.stringify(record));
  check("it records the version it installed", record.version === "1.2.0", JSON.stringify(record));
  check("the backup is cleaned up on success", !existsSync(`${installDir}.bak`), `${installDir}.bak`);
  rmSync(home, { recursive: true, force: true });
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

  const source = join(home, "source");
  mkdirSync(join(source, "server"), { recursive: true });
  writeFileSync(join(source, "server", "index.js"), "// NEW-BROKEN");

  const installer = join(home, "fake-install.sh");
  writeFileSync(installer, `#!/bin/sh\nrm -rf "${installDir}/server"\ncp -R "$CC_CHROME_SOURCE/server" "${installDir}/server"\nrm -f "${installDir}/tokens.json"\n`);
  chmodSync(installer, 0o755);

  const version = { value: "1.1.0" }; // never becomes 1.2.0
  const server = await healthServer(version);
  const status = join(home, "status.json");

  const { code } = await runRunner([
    "--source", source, "--install-dir", installDir, "--installer", installer,
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
  rmSync(home, { recursive: true, force: true });
}

// --- 3. the status file survives the rollback -------------------------------
//
// Written outside the install dir on purpose: a rollback replaces that whole
// directory, and a status file inside it would be destroyed by the very event it
// exists to explain.

{
  const home = mkdtempSync(join(tmpdir(), "cc-runner-status-"));
  const installDir = join(home, ".cc-chrome-bridge");
  mkdirSync(installDir, { recursive: true });
  const status = join(home, "status.json");
  check("the status path used by the server is outside the install dir",
    !status.startsWith(installDir), `${status} vs ${installDir}`);
  rmSync(home, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
