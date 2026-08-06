// Packages everything a machine needs to run the bridge locally into one
// tarball for GitHub Releases. node_modules ships inside it on purpose: the
// installer then needs neither npm nor network, and every machine runs the
// same three dependencies rather than whatever npm resolves that day.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, cpSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const stage = join(dist, "release-stage");

if (!existsSync(join(root, "server", "node_modules"))) {
  console.error("server/node_modules is missing — run `npm install` inside server/ first.");
  process.exit(1);
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

cpSync(join(root, "server"), join(stage, "server"), { recursive: true });
cpSync(join(root, "extension"), join(stage, "extension"), { recursive: true });
for (const f of ["install.sh", "uninstall.sh", "service-unit.sh"]) {
  copyFileSync(join(root, "scripts", f), join(stage, f));
}
copyFileSync(join(root, ".claude", "commands", "ccchrome.md"), join(stage, "ccchrome.md"));

// -C stage so paths inside the archive are relative to the install root.
execFileSync("tar", ["-czf", join(dist, "cc-chrome-bridge.tar.gz"), "-C", stage, "."], { stdio: "inherit" });
rmSync(stage, { recursive: true, force: true });
console.log("wrote dist/cc-chrome-bridge.tar.gz");
