// Packages everything a machine needs to run the bridge locally into one
// tarball for GitHub Releases. node_modules ships inside it on purpose: the
// installer then needs neither npm nor network, and every machine runs the
// same three dependencies rather than whatever npm resolves that day.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

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
// server/package-lock.json if someone hand-edits it. The e2e suites
// (test:e2e, test:http, etc.) exercise the real server against this same
// node_modules and would catch a *broken* tree, but they would stay green
// on a merely stale-yet-working one — this is a partial safety net, not
// proof the tree matches the lockfile.

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// `cp -R`, not fs.cpSync: cpSync resolves symlinks via realpath rather than
// preserving their literal target, which rewrote the relative symlinks under
// server/node_modules/.bin/ into absolute paths pointing at this checkout —
// dangling and machine-specific on every other machine. `cp -R` copies a
// symlink as a symlink, unchanged.
execFileSync("cp", ["-R", join(root, "server"), join(stage, "server")]);
execFileSync("cp", ["-R", join(root, "extension"), join(stage, "extension")]);
for (const f of [
  "install.sh", "uninstall.sh", "service-unit.sh",
  "install.ps1", "uninstall.ps1", "service-task.ps1",
]) {
  copyFileSync(join(root, "scripts", f), join(stage, f));
}
copyFileSync(join(root, ".claude", "commands", "ccchrome.md"), join(stage, "ccchrome.md"));

// node_modules/.bin holds npm's CLI shims, and on this dependency tree exactly
// one of them is a symlink (`node-which` -> ../which/bin/node-which). Windows'
// bundled tar.exe cannot create a symlink without Developer Mode or elevation,
// so it fails the whole extraction — "Can't create ... Invalid argument", then
// "Error exit delayed from previous errors" — and install.ps1 correctly reports
// a broken release. Nothing in server/ ever executes a .bin shim: the runtime
// imports its three dependencies as modules. So the directory is dropped rather
// than dereferenced, which also keeps the archive symlink-free by construction.
// test/build.test.mjs asserts that.
rmSync(join(stage, "server", "node_modules", ".bin"), { recursive: true, force: true });

// -C stage so paths inside the archive are relative to the install root.
// COPYFILE_DISABLE=1 stops macOS's bsdtar from adding a ._<name> AppleDouble
// resource-fork entry for every real entry — otherwise the archive silently
// doubles in member count with junk files, invisible from macOS's own `tar
// -tzf` (which hides and merges them on read) but extracted for real, and
// permanently installed, on Linux.
//
// --no-xattrs (plus --no-acls for the same reason) stops bsdtar from also
// embedding a PAX extended header per entry for whatever xattrs the staged
// files happen to carry — most visibly `com.apple.provenance`, which recent
// macOS stamps onto files itself and COPYFILE_DISABLE does not touch (that
// variable only governs the legacy AppleDouble resource-fork copy above, a
// different mechanism). Those headers are silently accepted and dropped by
// macOS's own bsdtar on read, but GNU tar on Linux — every `install.sh`
// target — logs "Ignoring unknown extended header keyword
// 'LIBARCHIVE.xattr.com.apple.provenance'" once per affected entry. Harmless
// (the entry still extracts), but noisy enough on every install to look like
// a broken release. Deliberately not `--no-fflags` too: GNU tar (unlike
// bsdtar) doesn't recognize that option, and this script's own `npm test`
// path needs to run under either tar depending on the contributor's OS.
execFileSync("tar", [
  "--no-xattrs", "--no-acls",
  "-czf", join(dist, "cc-chrome-bridge.tar.gz"), "-C", stage, ".",
], {
  stdio: "inherit",
  env: { ...process.env, COPYFILE_DISABLE: "1" },
});
rmSync(stage, { recursive: true, force: true });
console.log("wrote dist/cc-chrome-bridge.tar.gz");

// Written in `shasum -a 256` format so a human can verify a download by hand
// with `shasum -c cc-chrome-bridge.tar.gz.sha256`, and so the updater's parser
// (server/updater.js parseChecksumFile) has something standard to read.
const tarballPath = join(dist, "cc-chrome-bridge.tar.gz");
const digest = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
writeFileSync(`${tarballPath}.sha256`, `${digest}  cc-chrome-bridge.tar.gz\n`);
console.log("wrote dist/cc-chrome-bridge.tar.gz.sha256");

// install.sh also ships as a STANDALONE release asset, copied straight to
// dist/ rather than only left inside the tarball above. The one-line install
// documented everywhere (README.md, .claude/commands/ccchrome.md) is
// `curl .../releases/latest/download/install.sh | bash` — install.sh has to
// exist on its own before the tarball it downloads is ever fetched, so
// packing it exclusively inside cc-chrome-bridge.tar.gz would make that
// command 404 no matter how carefully a release is published by hand.
// The same argument applies to install.ps1 and the Windows one-liner
// `irm .../releases/latest/download/install.ps1 | iex`, so FOUR assets have
// to be attached to every GitHub Release, not three. test/build.test.mjs asserts
// the checksum file exists and matches the tarball byte for byte.
copyFileSync(join(root, "scripts", "install.sh"), join(dist, "install.sh"));
console.log("wrote dist/install.sh");
copyFileSync(join(root, "scripts", "install.ps1"), join(dist, "install.ps1"));
console.log("wrote dist/install.ps1");
