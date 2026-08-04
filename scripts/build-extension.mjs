// Packages the extension into installable files under dist/:
//
//   dist/claude-code-chrome-bridge-v<version>.zip   (+ copy: dist/extension.zip)
//   dist/claude-code-chrome-bridge-v<version>.crx   (+ copy: dist/extension.crx)
//
// The .crx is a signed CRX3 package. The signing key (key.pem, gitignored) is
// generated on first run and MUST be kept: the same key keeps the same
// extension ID across versions, which team members' Chrome relies on for
// updates and admins rely on for policy allowlists.
//
// Usage: npm install && npm run build
//        KEY_FILE=/secure/path/key.pem npm run build

import { generateKeyPairSync, createHash, createPublicKey } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, chmodSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import ChromeExtension from "crx";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const extensionDir = join(root, "extension");
const distDir = join(root, "dist");
const keyFile = process.env.KEY_FILE || join(root, "key.pem");
const commandFile = join(root, ".claude", "commands", "ccchrome.md");

const manifest = JSON.parse(readFileSync(join(extensionDir, "manifest.json"), "utf8"));
const baseName = `claude-code-chrome-bridge-v${manifest.version}`;
mkdirSync(distDir, { recursive: true });

// --- signing key ------------------------------------------------------------

if (!existsSync(keyFile)) {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  writeFileSync(keyFile, privateKey);
  chmodSync(keyFile, 0o600);
  console.log(`Generated NEW signing key: ${keyFile}`);
  console.log("  -> Back it up and keep it out of git. Losing it changes the extension ID.");
} else {
  console.log(`Using existing signing key: ${keyFile}`);
}
const privateKeyPem = readFileSync(keyFile);

// Chrome extension ID = first 16 bytes of sha256(DER SPKI public key), hex
// mapped to letters a-p.
const spkiDer = createPublicKey(privateKeyPem).export({ type: "spki", format: "der" });
const extensionId = [...createHash("sha256").update(spkiDer).digest().subarray(0, 16)]
  .map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 0xf)))
  .join("");

// --- zip --------------------------------------------------------------------

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

const zip = new AdmZip();
for (const file of listFiles(extensionDir)) {
  zip.addLocalFile(file, dirname(relative(extensionDir, file)) === "." ? "" : dirname(relative(extensionDir, file)));
}
const zipPath = join(distDir, `${baseName}.zip`);
zip.writeZip(zipPath);
copyFileSync(zipPath, join(distDir, "extension.zip"));

// --- crx (CRX3, signed) -----------------------------------------------------

const crx = new ChromeExtension({ privateKey: privateKeyPem });
await crx.load(extensionDir);
const crxBuffer = await crx.pack();
const crxPath = join(distDir, `${baseName}.crx`);
writeFileSync(crxPath, crxBuffer);
copyFileSync(crxPath, join(distDir, "extension.crx"));

// --- slash command (staged for the server to serve at GET /ccchrome.md) -----
//
// The Docker image copies only server/*.js; dist/ reaches the container
// through a read-only bind mount. Staging the command file here, alongside
// the zip/crx, is what lets the server serve it without any other change to
// what gets deployed.

const commandDestPath = join(distDir, "ccchrome.md");
copyFileSync(commandFile, commandDestPath);

// ---------------------------------------------------------------------------

console.log(`
Built ${manifest.name} v${manifest.version}
  ${relative(root, zipPath)}  (+ dist/extension.zip)
  ${relative(root, crxPath)}  (+ dist/extension.crx)
  ${relative(root, commandDestPath)}
  Extension ID (stable while key.pem is kept): ${extensionId}

Cài đặt:
  - ZIP (mọi OS): giải nén -> chrome://extensions -> Developer mode -> Load unpacked
  - CRX (Linux):  kéo thả file .crx vào trang chrome://extensions (Developer mode)
  - Windows/macOS chặn .crx ngoài Web Store trừ khi dùng enterprise policy
    (ExtensionInstallAllowlist với ID ở trên) — xem README.
`);
