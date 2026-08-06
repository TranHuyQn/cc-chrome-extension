// Packages everything a machine needs to run the bridge locally into one
// tarball for GitHub Releases. node_modules ships inside it on purpose: the
// installer then needs neither npm nor network, and every machine runs the
// same three dependencies rather than whatever npm resolves that day.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const stage = join(dist, "release-stage");

if (!existsSync(join(root, "server", "node_modules"))) {
  console.error("server/node_modules is missing — run `npm install` inside server/ first.");
  process.exit(1);
}

// Deliberately not `npm ci --omit=dev` into a clean staging copy: this build
// runs as part of `test/build.test.mjs`, which is part of the ordinary
// `npm test` run and currently needs no network access at all. Making every
// local test run also install ~3900 packages fresh (and fail offline) is a
// real, recurring cost for a repo with no CI workflow to absorb it instead.
// The tradeoff this accepts: the archive ships whatever is on disk in
// server/node_modules, which could in principle drift from
// server/package-lock.json if someone hand-edits it. In practice that
// drift would already show up as failures in the e2e suites (test:e2e,
// test:http, etc.), which exercise the real server against this same
// node_modules — so a silently-wrong dependency tree does not stay silent.

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// `cp -R`, not fs.cpSync: cpSync resolves symlinks via realpath rather than
// preserving their literal target, which rewrote the relative symlinks under
// server/node_modules/.bin/ into absolute paths pointing at this checkout —
// dangling and machine-specific on every other machine. `cp -R` copies a
// symlink as a symlink, unchanged.
execFileSync("cp", ["-R", join(root, "server"), join(stage, "server")]);
execFileSync("cp", ["-R", join(root, "extension"), join(stage, "extension")]);
for (const f of ["install.sh", "uninstall.sh", "service-unit.sh"]) {
  copyFileSync(join(root, "scripts", f), join(stage, f));
}
copyFileSync(join(root, ".claude", "commands", "ccchrome.md"), join(stage, "ccchrome.md"));

// -C stage so paths inside the archive are relative to the install root.
// COPYFILE_DISABLE=1 stops macOS's bsdtar from adding a ._<name> AppleDouble
// resource-fork entry for every real entry — otherwise the archive silently
// doubles in member count with junk files, invisible from macOS's own `tar
// -tzf` (which hides and merges them on read) but extracted for real, and
// permanently installed, on Linux.
execFileSync("tar", ["-czf", join(dist, "cc-chrome-bridge.tar.gz"), "-C", stage, "."], {
  stdio: "inherit",
  env: { ...process.env, COPYFILE_DISABLE: "1" },
});
rmSync(stage, { recursive: true, force: true });
console.log("wrote dist/cc-chrome-bridge.tar.gz");
