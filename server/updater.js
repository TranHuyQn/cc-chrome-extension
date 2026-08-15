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
  const scripts = ["uninstall.sh", "service-unit.sh", "uninstall.ps1", "service-task.ps1"];
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
