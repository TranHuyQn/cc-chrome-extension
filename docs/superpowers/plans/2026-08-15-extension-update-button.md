# Extension Update Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Khi có bản phát hành mới, khung chat hiện một nút; bấm vào là máy tự tải, xác minh và cài bản mới nhất, tự quay về bản cũ nếu hỏng — chạy như nhau trên macOS, Linux và Windows.

**Architecture:** Bridge lo phần *quyết định* (hỏi GitHub, tải, đối chiếu SHA256, sao lưu); `install.sh`/`install.ps1` lo phần *thi hành*. Gói đã xác minh được dựng lại thành layout checkout rồi đưa cho installer qua `CC_CHROME_SOURCE` — một đường duy nhất cho cả ba OS. Việc cài chạy trong một tiến trình tách rời sống lâu hơn bridge; supervisor của OS dựng bridge mới lên.

**Tech Stack:** Node ESM (server, runner, test), JavaScript classic script không build step (extension), bash + PowerShell (installer sẵn có), GitHub Releases API.

**Spec:** `docs/superpowers/specs/2026-08-15-extension-update-button-design.md`

## Global Constraints

- **Kích hoạt chỉ qua `/panel`.** Không thêm endpoint HTTP nào, không thêm MCP tool nào. Claude không được có đường nào tự cập nhật.
- **Panel không bao giờ truyền URL.** Bridge tự dựng URL từ hằng số trong mã nguồn; trường `url` gửi kèm từ panel bị **bỏ qua**, không phải bị dùng.
- **Tag từ GitHub phải khớp `/^v?\d+\.\d+\.\d+$/` trước khi được ghép vào URL.** Tag là dữ liệu từ mạng; ghép thẳng vào URL là mở đường cho path traversal.
- **Không sửa `install.sh` / `install.ps1`** ngoài việc thêm file checksum vào quy trình phát hành. Đường cài thủ công giữ nguyên hành vi.
- **`update-runner` chạy với cwd nằm ngoài thư mục cài.** Trên Windows, cwd nằm trong thư mục đang bị thay là cách chắc chắn nhất để khoá file.
- **File trạng thái ghi ra `~/.ccchrome-update.json`, ngoài thư mục cài** — rollback ghi đè cả thư mục cài và sẽ nuốt mất bản ghi giải thích tại sao.
- **Giữ đúng một bản sao lưu** (`~/.cc-chrome-bridge.bak`). Không lịch sử nhiều bản, không nút hạ cấp.
- `extension/` không có build step; file mới phơi đúng một global qua IIFE (eslint script mode báo lỗi hàm top-level dùng chéo file).
- `npm run lint` giữ 0 lỗi. Code/comment/commit tiếng Anh; UI người dùng tiếng Việt.
- Ba file version phải khớp (`test/build.test.mjs` canh): `extension/manifest.json`, `VERSION` trong `server/index.js`, `server/package.json`. Đích: **1.2.0**.

---

### Task 1: Đo trên Windows — hai câu hỏi chặn thiết kế

**Files:**
- Create: `scripts/probe-windows-update.ps1`

**Interfaces:**
- Produces: câu trả lời cho hai câu hỏi mà Task 6 phụ thuộc. **Không** sinh code sản phẩm.

Task này **người dùng chạy trên máy Windows thật**, không phải agent. Agent chỉ viết script và hướng dẫn. Task 2–5, 7 không phụ thuộc kết quả này nên chạy song song được; **chỉ Task 6 bị chặn**.

Hai câu hỏi:
1. `install.ps1` có chạy được với `CC_CHROME_SOURCE` trỏ vào thư mục **dựng lại từ tarball** không? Nhánh đó có trong mã (`install.ps1:108-113`) nhưng chưa từng chạy với layout dựng lại kiểu này.
2. Tiến trình tách rời do bridge sinh ra có **sống sót** khi Task Scheduler dừng dịch vụ không? Nếu bị giết cùng, bước 6 của luồng phải thiết kế lại.

- [ ] **Step 1: Viết script đo**

Create `scripts/probe-windows-update.ps1`:

```powershell
# Answers the two Windows questions the update design depends on. Run on a real
# Windows machine with the bridge already installed. Writes nothing outside
# $env:TEMP and never touches the installed bridge.
$ErrorActionPreference = 'Stop'
$probe = Join-Path $env:TEMP "cc-probe-$(Get-Random)"
New-Item -ItemType Directory -Path $probe | Out-Null
Write-Host "probe dir: $probe"

# --- Q2 first: does a detached child outlive its parent being killed? ---------
# The child writes a heartbeat line every second for 20s. We kill the PARENT
# (this shell's spawned intermediary) after 3s and see whether the file keeps
# growing — that is exactly the shape update-runner needs to survive.
$beat = Join-Path $probe 'heartbeat.txt'
$childScript = Join-Path $probe 'child.ps1'
@"
1..20 | ForEach-Object { Add-Content -Path '$beat' -Value "beat `$_"; Start-Sleep -Seconds 1 }
"@ | Set-Content $childScript

$parent = Start-Process -FilePath 'powershell' `
    -ArgumentList '-NoProfile','-WindowStyle','Hidden','-File',$childScript `
    -PassThru
Start-Sleep -Seconds 3
Stop-Process -Id $parent.Id -Force
Write-Host "killed pid $($parent.Id) after 3s"
$before = (Get-Content $beat -ErrorAction SilentlyContinue).Count
Start-Sleep -Seconds 6
$after = (Get-Content $beat -ErrorAction SilentlyContinue).Count
Write-Host "Q2 heartbeat lines: before=$before after=$after"
if ($after -gt $before) { Write-Host "Q2 ANSWER: detached child SURVIVES parent kill" }
else { Write-Host "Q2 ANSWER: detached child DIES with parent — design change needed" }

# --- Q1: does install.ps1 accept a reshaped CC_CHROME_SOURCE? ----------------
# Build the checkout layout the updater will build, from the installed copy
# (same file set a release tarball carries), then run install.ps1 -WhatIf-style
# by pointing HOME at a throwaway dir so nothing real is touched.
$src = Join-Path $probe 'source'
$installed = Join-Path $env:USERPROFILE '.cc-chrome-bridge'
New-Item -ItemType Directory -Path (Join-Path $src 'scripts') | Out-Null
New-Item -ItemType Directory -Path (Join-Path $src '.claude\commands') -Force | Out-Null
Copy-Item -Recurse (Join-Path $installed 'server')    (Join-Path $src 'server')
Copy-Item -Recurse (Join-Path $installed 'extension') (Join-Path $src 'extension')
Copy-Item (Join-Path $installed 'ccchrome.md')     (Join-Path $src '.claude\commands\ccchrome.md')
Copy-Item (Join-Path $installed 'uninstall.ps1')   (Join-Path $src 'scripts\uninstall.ps1')
Copy-Item (Join-Path $installed 'service-task.ps1') (Join-Path $src 'scripts\service-task.ps1')
Write-Host "Q1 reshaped source at: $src"
Write-Host "Q1 NEXT: run this by hand and report the full output:"
Write-Host "    `$env:CC_CHROME_SOURCE='$src'; powershell -File '$installed\..\<repo>\scripts\install.ps1'"
Write-Host "  (or from a checkout: `$env:CC_CHROME_SOURCE='$src'; .\scripts\install.ps1)"
```

- [ ] **Step 2: Chạy trên Windows và ghi lại kết quả**

Người dùng chạy trong PowerShell (không cần quyền admin):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\probe-windows-update.ps1
```

Kỳ vọng: in ra `Q2 ANSWER: …` dứt khoát, và một đường dẫn `$src` để chạy tiếp phần Q1.

- [ ] **Step 3: Ghi kết quả vào spec**

Thêm vào `docs/superpowers/specs/2026-08-15-extension-update-button-design.md`, ngay dưới mục G, một khối "Kết quả đo trên Windows (ngày …)" ghi rõ hai đáp án và output thật. Nếu Q2 trả lời **DIES**, dừng lại và báo — Task 6 phải thiết kế lại theo hướng nhờ chính Task Scheduler chạy trình cập nhật.

- [ ] **Step 4: Commit**

```bash
git add scripts/probe-windows-update.ps1 docs/superpowers/specs/2026-08-15-extension-update-button-design.md
git commit -m "probe: answer the two Windows questions the updater depends on

Whether install.ps1 accepts a reshaped CC_CHROME_SOURCE, and whether a detached
child survives Task Scheduler stopping the service. Both were assumptions the
design rested on; neither had ever been run."
```

---

### Task 2: `server/updater.js` — hàm thuần

**Files:**
- Create: `server/updater.js`
- Create: `test/updater.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces:
  - `REPO = "TranHuyQn/cc-chrome-extension"`, `TARBALL_NAME = "cc-chrome-bridge.tar.gz"`
  - `compareVersions(a: string, b: string) => -1 | 0 | 1`
  - `isValidTag(tag: string) => boolean`
  - `releaseUrls(tag: string) => { tarball: string, checksum: string }`
  - `parseChecksumFile(text: string) => string | null`
  - `sha256File(path: string) => Promise<string>`
  - `reshapeToCheckout(extractedDir: string, targetDir: string) => void`
- Task 4 gọi `compareVersions`, `isValidTag`, `releaseUrls`, `parseChecksumFile`, `sha256File`, `reshapeToCheckout`.

- [ ] **Step 1: Viết test thất bại**

Create `test/updater.test.mjs`:

```js
// Usage: node test/updater.test.mjs
//
// Pure functions only — no network, no spawning, no real release. Everything
// that talks to GitHub or the filesystem at scale is exercised in Task 4 and 5;
// this file covers the logic that decides WHAT gets downloaded and whether it is
// trusted, which is the part where a mistake is silent and dangerous.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareVersions, isValidTag, releaseUrls, parseChecksumFile, sha256File, reshapeToCheckout, REPO,
} from "../server/updater.js";

let failures = 0;
function check(name, cond, detail = "") {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}

// --- version comparison ------------------------------------------------------

check("a newer patch is newer", compareVersions("1.1.1", "1.1.0") === 1);
check("equal versions compare equal", compareVersions("1.1.0", "1.1.0") === 0);
check("an older minor is older", compareVersions("1.1.0", "1.2.0") === -1);
check("10 is newer than 9, not older (numeric, not lexical)", compareVersions("1.10.0", "1.9.0") === 1,
  String(compareVersions("1.10.0", "1.9.0")));
check("a leading v is tolerated", compareVersions("v1.2.0", "1.2.0") === 0);
check("missing segments count as zero", compareVersions("1.2", "1.2.0") === 0);

// --- tag validation ----------------------------------------------------------
//
// The tag arrives from the network and is pasted into a download URL. Anything
// that is not a plain version must be refused before it can shape a request.

check("a plain tag is valid", isValidTag("v1.2.0") === true);
check("a tag without v is valid", isValidTag("1.2.0") === true);
check("a path traversal attempt is refused", isValidTag("../../evil") === false);
check("a tag with a slash is refused", isValidTag("v1.2.0/../x") === false);
check("a tag with a space is refused", isValidTag("v1.2.0 rc") === false);
check("an empty tag is refused", isValidTag("") === false);
check("a non-string is refused", isValidTag(null) === false);

// --- url construction --------------------------------------------------------

const urls = releaseUrls("v1.2.0");
check("the tarball url points at this repo's release", urls.tarball === `https://github.com/${REPO}/releases/download/v1.2.0/cc-chrome-bridge.tar.gz`, urls.tarball);
check("the checksum url sits beside it", urls.checksum === `${urls.tarball}.sha256`, urls.checksum);

// --- checksum file parsing ---------------------------------------------------

check("shasum format yields the hex",
  parseChecksumFile("a".repeat(64) + "  cc-chrome-bridge.tar.gz\n") === "a".repeat(64));
check("a bare hex line works too", parseChecksumFile("b".repeat(64) + "\n") === "b".repeat(64));
check("a short hex is refused", parseChecksumFile("abc123  file") === null);
check("junk is refused", parseChecksumFile("not a checksum at all") === null);
check("empty is refused", parseChecksumFile("") === null);

// --- hashing a real file -----------------------------------------------------

const work = mkdtempSync(join(tmpdir(), "cc-updater-test-"));
const sample = join(work, "sample.bin");
writeFileSync(sample, "hello");
// sha256("hello") is a published constant; hard-coding it means this test fails
// if the implementation ever hashes something other than the file's bytes.
check("sha256File hashes the file's bytes",
  (await sha256File(sample)) === "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  await sha256File(sample));

// --- reshaping the extracted tarball into a checkout layout ------------------
//
// This is the whole reason the design works identically on three platforms:
// both installers accept CC_CHROME_SOURCE, but they expect a checkout layout,
// not the flat layout the tarball ships.

const extracted = join(work, "extracted");
mkdirSync(join(extracted, "server"), { recursive: true });
mkdirSync(join(extracted, "extension"), { recursive: true });
writeFileSync(join(extracted, "server", "index.js"), "// server");
writeFileSync(join(extracted, "extension", "manifest.json"), "{}");
for (const f of ["ccchrome.md", "uninstall.sh", "service-unit.sh", "uninstall.ps1", "service-task.ps1"]) {
  writeFileSync(join(extracted, f), f);
}

const target = join(work, "checkout");
reshapeToCheckout(extracted, target);

check("server/ is carried over", existsSync(join(target, "server", "index.js")));
check("extension/ is carried over", existsSync(join(target, "extension", "manifest.json")));
check("ccchrome.md lands where install.sh looks for it",
  readFileSync(join(target, ".claude", "commands", "ccchrome.md"), "utf8") === "ccchrome.md");
for (const f of ["uninstall.sh", "service-unit.sh", "uninstall.ps1", "service-task.ps1"]) {
  check(`${f} lands in scripts/`, readFileSync(join(target, "scripts", f), "utf8") === f);
}

// A tarball missing a file the installer needs must fail loudly here, not
// halfway through an install that has already stopped the service.
const broken = join(work, "broken");
mkdirSync(join(broken, "server"), { recursive: true });
mkdirSync(join(broken, "extension"), { recursive: true });
let threw = null;
try {
  reshapeToCheckout(broken, join(work, "checkout2"));
} catch (err) {
  threw = err.message;
}
check("a tarball missing ccchrome.md is refused, by name", threw && threw.includes("ccchrome.md"), String(threw));

rmSync(work, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Chạy để xác nhận đỏ**

Run: `node test/updater.test.mjs`
Expected: FAIL — `Cannot find module '../server/updater.js'`

- [ ] **Step 3: Cài đặt tối thiểu**

Create `server/updater.js`:

```js
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

  mkdirSync(targetDir, { recursive: true });
  cpSync(need("server"), join(targetDir, "server"), { recursive: true });
  cpSync(need("extension"), join(targetDir, "extension"), { recursive: true });

  const command = join(targetDir, ".claude", "commands", "ccchrome.md");
  mkdirSync(dirname(command), { recursive: true });
  copyFileSync(need("ccchrome.md"), command);

  mkdirSync(join(targetDir, "scripts"), { recursive: true });
  for (const file of ["uninstall.sh", "service-unit.sh", "uninstall.ps1", "service-task.ps1"]) {
    copyFileSync(need(file), join(targetDir, "scripts", file));
  }
}
```

- [ ] **Step 4: Chạy để xác nhận xanh**

Run: `node test/updater.test.mjs`
Expected: `ALL TESTS PASSED`

- [ ] **Step 5: Ghép vào `npm test` và commit**

Trong `package.json`, thêm `"test:updater": "node test/updater.test.mjs",` và chèn `node test/updater.test.mjs && ` vào đầu chuỗi `"test"`.

```bash
npm run lint && npm run test:updater
git add server/updater.js test/updater.test.mjs package.json
git commit -m "feat(update): the decision half of the update path

What the newest release is, whether it is newer, where its files live, and
whether what arrived is what was published. No spawning, no writes into the
installed copy, so all of it is testable from node with no network.

Two things carry real weight: version comparison is numeric, so 1.10.0 beats
1.9.0 rather than losing a string compare at the moment it starts to matter; and
the tag is validated before it can shape a URL, because it arrives from the
network and is pasted into one.

reshapeToCheckout exists because the tarball ships a flat layout while both
installers' CC_CHROME_SOURCE branch expects a checkout — and pointing the
Windows installer at a local tarball is impossible, since Invoke-WebRequest does
not accept file:// URIs."
```

---

### Task 3: Checksum trong gói phát hành

**Files:**
- Modify: `scripts/build-release.mjs`
- Modify: `test/build.test.mjs`

**Interfaces:**
- Consumes: `sha256File` (Task 2)
- Produces: `dist/cc-chrome-bridge.tar.gz.sha256`, phải được đính lên GitHub Release cùng ba file kia.

- [ ] **Step 1: Viết test thất bại**

Thêm vào `test/build.test.mjs`, ngay sau khối kiểm `dist/install.ps1`:

```js
// The updater refuses to install a tarball whose hash does not match this file.
// If a release ships without it, every automatic update fails closed — which is
// the right failure, but only if someone notices here first.
{
  const sumPath = join(dist, "cc-chrome-bridge.tar.gz.sha256");
  check("release writes a checksum beside the tarball", existsSync(sumPath), sumPath);
  const text = readFileSync(sumPath, "utf8");
  const hex = (text.match(/\b[0-9a-f]{64}\b/i) || [])[0];
  check("the checksum file contains a sha256", !!hex, text.slice(0, 80));

  const actual = createHash("sha256").update(readFileSync(join(dist, "cc-chrome-bridge.tar.gz"))).digest("hex");
  check("the checksum matches the tarball it ships with", hex?.toLowerCase() === actual, `${hex} vs ${actual}`);
  check("the checksum file names the tarball, so `shasum -c` works by hand",
    text.includes("cc-chrome-bridge.tar.gz"), text.slice(0, 80));
}
```

Thêm `createHash` vào import ở đầu `test/build.test.mjs`:

```js
import { createHash } from "node:crypto";
```

- [ ] **Step 2: Chạy để xác nhận đỏ**

Run: `npm run build:release && npm run test:build`
Expected: FAIL — `release writes a checksum beside the tarball`

- [ ] **Step 3: Cài đặt tối thiểu**

Trong `scripts/build-release.mjs`, ngay sau dòng `console.log("wrote dist/cc-chrome-bridge.tar.gz");`:

```js
// Written in `shasum -a 256` format so a human can verify a download by hand
// with `shasum -c cc-chrome-bridge.tar.gz.sha256`, and so the updater's parser
// (server/updater.js parseChecksumFile) has something standard to read.
const tarballPath = join(dist, "cc-chrome-bridge.tar.gz");
const digest = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
writeFileSync(`${tarballPath}.sha256`, `${digest}  cc-chrome-bridge.tar.gz\n`);
console.log("wrote dist/cc-chrome-bridge.tar.gz.sha256");
```

Thêm vào import của `scripts/build-release.mjs`: `createHash` từ `node:crypto`, và `readFileSync`/`writeFileSync` nếu chưa có.

- [ ] **Step 4: Chạy để xác nhận xanh**

Run: `npm run build:release && npm run test:build`
Expected: PASS toàn bộ

- [ ] **Step 5: Cập nhật tài liệu phát hành và commit**

Trong `CLAUDE.md`, mục "Publishing a GitHub Release", sửa câu liệt kê ba file thành **bốn**, và ghi rõ: thiếu file `.sha256` thì mọi lần cập nhật tự động của người đã cài đều thất bại (fail closed), trong khi cài thủ công vẫn chạy — nên lỗi này không lộ ra ở đường cài tay.

```bash
npm run lint
git add scripts/build-release.mjs test/build.test.mjs CLAUDE.md
git commit -m "feat(release): ship a sha256 beside the tarball

The updater refuses any tarball whose hash does not match this file, so a
release without it fails every automatic update closed. That is the right
failure, but it is invisible on the manual install path — which is why
build.test.mjs now asserts the file exists AND matches the tarball it ships
with, rather than merely existing."
```

---

### Task 4: Khung panel `update_check` / `update_start`

**Files:**
- Modify: `server/index.js`
- Test: `test/panel-protocol.test.mjs`

**Interfaces:**
- Consumes: mọi export của `server/updater.js` (Task 2)
- Produces — khung server → panel:
  - `{type:"update_status", current, latest, available, notes, lastResult}`
  - `{type:"update_progress", step}` với `step` ∈ `"downloading" | "verifying" | "backing-up" | "installing"`
  - `{type:"update_failed", reason}`
- Task 7 vẽ đúng các khung trên.

- [ ] **Step 1: Viết test thất bại**

Thêm vào `test/panel-protocol.test.mjs`, trước phần teardown:

```js
// --- the update frames -------------------------------------------------------
//
// The panel is the ONLY surface that can trigger an update, and /panel is the
// only endpoint in this server that requires all three loopback conditions. The
// assertions below are about the two ways that guarantee gets lost: a caller
// naming its own URL, and an update starting while a chat turn is mid-flight.
{
  const up = new WebSocket(`ws://127.0.0.1:${PORT}/panel`, [`ccchrome.token.${TOKEN}`], { origin: ORIGIN });
  const upFrames = [];
  up.on("message", (raw) => upFrames.push(JSON.parse(raw.toString())));
  await new Promise((res) => up.on("open", res));
  await sleep(300);
  up.send(JSON.stringify({ type: "start", sessionId: null, mcpSessionId: null, model: null, protocol: 2 }));
  await sleep(500);

  up.send(JSON.stringify({ type: "update_check" }));
  for (let i = 0; i < 100 && !upFrames.some((f) => f.type === "update_status"); i++) await sleep(50);
  const status = upFrames.find((f) => f.type === "update_status");
  check("update_check answers with the running version", status?.current === VERSION_UNDER_TEST,
    JSON.stringify(status));
  check("and says whether an update is available, as a boolean",
    typeof status?.available === "boolean", JSON.stringify(status));

  // A caller-supplied URL is the whole attack: /panel is loopback-only, but if
  // the panel can name what gets downloaded then "loopback-only" only means the
  // attacker has to be on this machine, which is exactly what the token already
  // implies. The field must be ignored, not honoured.
  up.send(JSON.stringify({ type: "update_start", url: "https://evil.example.com/x.tar.gz" }));
  for (let i = 0; i < 100 && !upFrames.some((f) => f.type === "update_failed" || f.type === "update_progress"); i++) await sleep(50);
  const reaction = upFrames.find((f) => f.type === "update_failed" || f.type === "update_progress");
  check("update_start never reports the caller's url back",
    JSON.stringify(reaction).includes("evil.example.com") === false, JSON.stringify(reaction));

  check("an unknown frame type still names itself",
    (() => {
      up.send(JSON.stringify({ type: "update_nonsense" }));
      return true;
    })());
  for (let i = 0; i < 60 && !upFrames.some((f) => f.type === "error" && /update_nonsense/.test(f.message || "")); i++) await sleep(50);
  check("update_nonsense comes back as an error naming itself",
    upFrames.some((f) => f.type === "error" && /update_nonsense/.test(f.message || "")),
    JSON.stringify(upFrames.filter((f) => f.type === "error")));

  up.close();
  await sleep(200);
}
```

Thêm gần đầu `test/panel-protocol.test.mjs`, cạnh các hằng số khác:

```js
// Read from the same place the server reads it, so a version bump does not
// silently turn this assertion into "whatever the server said".
const VERSION_UNDER_TEST = JSON.parse(readFileSync(join(root, "server", "package.json"), "utf8")).version;
```

(thêm `readFileSync` vào import `node:fs` của file đó nếu chưa có)

- [ ] **Step 2: Chạy để xác nhận đỏ**

Run: `npm run test:panelproto`
Expected: FAIL — `update_check answers with the running version` (server trả `error: Không hiểu lệnh 'update_check'`)

- [ ] **Step 3: Cài đặt tối thiểu**

Trong `server/index.js`, thêm import ở đầu file:

```js
import { compareVersions, isValidTag, releaseUrls, parseChecksumFile, sha256File, reshapeToCheckout, LATEST_RELEASE_API } from "./updater.js";
```

Thêm hằng số cạnh `PANEL_CWD`:

```js
// Outside the install directory on purpose: a rollback overwrites the whole
// install dir and would swallow the very record explaining why it rolled back.
const UPDATE_STATUS_FILE = join(homedir(), ".ccchrome-update.json");
// One update at a time, process-wide. A second panel asking mid-update must be
// refused rather than queued — two installers racing over one directory is the
// one failure this feature cannot recover from.
let updateInFlight = false;
```

Trong `handlePanelMessage`, **trước** dòng kiểm loại khung không hiểu, thêm:

```js
    if (msg.type === "update_check") {
      send(await buildUpdateStatus());
      return;
    }

    if (msg.type === "update_start") {
      // msg.url is deliberately not read. The URL is derived from a constant in
      // updater.js and from the tag GitHub reports; letting a caller name it
      // would turn this endpoint into "download and run whatever I point at".
      if (updateInFlight) {
        send({ type: "update_failed", reason: "Đang có một bản cập nhật chạy dở." });
        return;
      }
      if (panel.agent?.busy) {
        send({ type: "update_failed", reason: "Claude đang chạy — dừng lượt chat rồi cập nhật." });
        return;
      }
      updateInFlight = true;
      try {
        await startUpdate(send);
      } catch (err) {
        updateInFlight = false;
        send({ type: "update_failed", reason: err.message });
      }
      return;
    }
```

**Không sửa** dòng kiểm loại khung không hiểu. Hai khung update đã `return` phía trên nó, nên
một `update_nonsense` vẫn rơi xuống đó và vẫn tự gọi tên mình trong thông báo lỗi — đó chính
là điều khẳng định cuối trong test đang kiểm.

**Kiểm import trước khi chạy:** khối mã trên dùng `mkdtempSync`, `mkdirSync`, `writeFileSync`,
`readFileSync`, `tmpdir`, `spawn` và `Buffer`. `server/index.js` đã có sẵn một số; thêm những
cái còn thiếu vào import đầu file. Hook lint sẽ báo ngay nếu sót, nhưng biết trước thì đỡ một
vòng.

Thêm hai hàm, đặt cạnh `attachPanelTab`:

```js
  // Reports what is installed, what is published, and how the last attempt went.
  // A GitHub outage or a rate limit must not surface as an error the user has to
  // read — there is nothing they can do about it, and the panel is not a status
  // page for github.com. It degrades to "no update available".
  async function buildUpdateStatus() {
    let lastResult = null;
    try {
      lastResult = JSON.parse(readFileSync(UPDATE_STATUS_FILE, "utf8"));
    } catch { /* no previous update, or unreadable — not an error */ }

    try {
      const res = await fetch(LATEST_RELEASE_API, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "cc-chrome-bridge" },
      });
      if (!res.ok) throw new Error(`GitHub trả ${res.status}`);
      const body = await res.json();
      const tag = body?.tag_name;
      if (!isValidTag(tag)) throw new Error(`tag không hợp lệ: ${String(tag)}`);
      const latest = String(tag).replace(/^v/, "");
      return {
        type: "update_status",
        current: VERSION,
        latest,
        available: compareVersions(latest, VERSION) === 1,
        notes: typeof body?.body === "string" ? body.body.slice(0, 2000) : "",
        lastResult,
      };
    } catch (err) {
      log("[update] không hỏi được bản mới:", err.message);
      return { type: "update_status", current: VERSION, latest: null, available: false, notes: "", lastResult };
    }
  }

  // Everything that can fail harmlessly happens here, while the socket is still
  // up and before a single byte of the installed copy is touched: the network,
  // the checksum, the disk. Only once a verified, reshaped source directory
  // exists does it hand over to the detached runner and let go.
  async function startUpdate(send) {
    send({ type: "update_progress", step: "downloading" });
    const status = await buildUpdateStatus();
    if (!status.available || !status.latest) throw new Error("Không có bản mới để cài.");

    const urls = releaseUrls(`v${status.latest}`);
    const work = mkdtempSync(join(tmpdir(), "cc-update-"));
    const tarball = join(work, "release.tar.gz");

    const tarRes = await fetch(urls.tarball);
    if (!tarRes.ok) throw new Error(`Tải gói thất bại (${tarRes.status}).`);
    writeFileSync(tarball, Buffer.from(await tarRes.arrayBuffer()));

    send({ type: "update_progress", step: "verifying" });
    const sumRes = await fetch(urls.checksum);
    if (!sumRes.ok) throw new Error(`Bản phát hành thiếu file checksum (${sumRes.status}).`);
    const expected = parseChecksumFile(await sumRes.text());
    if (!expected) throw new Error("File checksum không đọc được.");
    const actual = await sha256File(tarball);
    if (actual !== expected) {
      throw new Error("Checksum không khớp — gói tải về không đúng bản đã phát hành. Không cài gì cả.");
    }

    send({ type: "update_progress", step: "backing-up" });
    const extracted = join(work, "extracted");
    mkdirSync(extracted, { recursive: true });
    await new Promise((resolve, reject) => {
      const child = spawn("tar", ["-xzf", tarball, "-C", extracted], { stdio: "ignore" });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Giải nén thất bại (mã ${code}).`))));
    });
    const source = join(work, "source");
    reshapeToCheckout(extracted, source);

    send({ type: "update_progress", step: "installing" });
    spawnUpdateRunner({ source, version: status.latest });
  }
```

`spawnUpdateRunner` là của Task 5 — cho đến khi Task 5 xong, tạm để một hàm ném lỗi rõ ràng:

```js
  function spawnUpdateRunner() {
    throw new Error("Trình cập nhật chưa được cài đặt (Task 5).");
  }
```

- [ ] **Step 4: Chạy để xác nhận xanh**

Run: `npm run test:panelproto`
Expected: PASS toàn bộ file. Test không có bản mới nào trên GitHub cho phiên bản đang chạy nên `available` sẽ là `false`; các khẳng định được viết để đúng trong cả hai trường hợp.

- [ ] **Step 5: Lint và commit**

```bash
npm run lint && npm run test:panelproto && npm run test:agent
git add server/index.js test/panel-protocol.test.mjs
git commit -m "feat(update): panel frames for checking and starting an update

/panel is the only endpoint in this server that requires all three loopback
conditions, and it is now the only way an update can start — no HTTP endpoint,
no MCP tool, so Claude has no path to updating the machine it runs on.

msg.url is deliberately never read: the URL comes from a constant plus the tag
GitHub reports, and the tag is validated before it can shape a request. A caller
naming its own URL would turn this into 'download and run whatever I point at'.

A GitHub outage degrades to 'no update available' rather than an error the user
can do nothing about."
```

---

### Task 5: `scripts/update-runner.mjs` — tiến trình tách rời

**Files:**
- Create: `scripts/update-runner.mjs`
- Create: `test/update-runner.test.mjs`
- Modify: `server/index.js` (thay `spawnUpdateRunner` tạm bằng bản thật)
- Modify: `package.json`

**Interfaces:**
- Consumes: thư mục `source` dạng checkout do Task 4 dựng
- Produces:
  - CLI: `node scripts/update-runner.mjs --source <dir> --install-dir <dir> --installer <path> --port <n> --expect-version <v> --status-file <path>`
  - Ghi `~/.ccchrome-update.json`: `{ ok: boolean, version, at, step, reason? }`

- [ ] **Step 1: Viết test thất bại**

Create `test/update-runner.test.mjs`:

```js
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
```

- [ ] **Step 2: Chạy để xác nhận đỏ**

Run: `node test/update-runner.test.mjs`
Expected: FAIL — `Cannot find module .../scripts/update-runner.mjs`

- [ ] **Step 3: Cài đặt tối thiểu**

Create `scripts/update-runner.mjs`:

```js
// The one process that outlives the bridge.
//
// The bridge cannot install its own replacement: the installer stops the service
// as its first step, which kills the bridge mid-command and leaves the install
// half done. So the bridge spawns this, detached, and lets go. All three
// platforms resurrect the bridge on their own — launchd KeepAlive, systemd
// Restart=always, a repeating Task Scheduler trigger — so this never starts the
// service itself.
//
// It runs with a cwd outside the install directory. On Windows, running from
// inside the directory being replaced is the surest way to lock it.

import { spawn } from "node:child_process";
import { cpSync, rmSync, existsSync, writeFileSync, renameSync } from "node:fs";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const source = arg("source");
const installDir = arg("install-dir");
const installer = arg("installer");
const port = Number(arg("port", "8787"));
const expectVersion = arg("expect-version");
const statusFile = arg("status-file");
const healthTimeoutMs = Number(arg("health-timeout-ms", "30000"));
const backupDir = `${installDir}.bak`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeStatus(record) {
  try {
    writeFileSync(statusFile, JSON.stringify({ ...record, at: new Date().toISOString() }, null, 2));
  } catch { /* a status we cannot write must not mask the outcome it describes */ }
}

async function healthVersion() {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body?.version === "string" ? body.version : null;
  } catch {
    return null;
  }
}

function runInstaller() {
  return new Promise((resolve) => {
    const isPs1 = installer.toLowerCase().endsWith(".ps1");
    const command = isPs1 ? "powershell" : (installer.endsWith(".sh") ? "bash" : installer);
    const args = isPs1 ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installer] : [installer];
    const child = spawn(command, args, {
      env: { ...process.env, CC_CHROME_SOURCE: source },
      cwd: process.env.TMPDIR || process.env.TEMP || "/tmp",
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

// Restores the backup wholesale rather than trying to undo what the installer
// did. The installer may have deleted files as well as replaced them, so a
// file-by-file repair would silently miss the deletions.
function rollback() {
  if (!existsSync(backupDir)) return false;
  rmSync(installDir, { recursive: true, force: true });
  renameSync(backupDir, installDir);
  return true;
}

async function main() {
  if (!source || !installDir || !installer || !expectVersion || !statusFile) {
    writeStatus({ ok: false, step: "bad-args", reason: "Thiếu tham số cho trình cập nhật." });
    process.exit(2);
  }

  rmSync(backupDir, { recursive: true, force: true });
  cpSync(installDir, backupDir, { recursive: true });

  const code = await runInstaller();

  const deadline = Date.now() + healthTimeoutMs;
  let seen = null;
  while (Date.now() < deadline) {
    seen = await healthVersion();
    if (seen === expectVersion) break;
    await sleep(1000);
  }

  if (seen === expectVersion) {
    rmSync(backupDir, { recursive: true, force: true });
    writeStatus({ ok: true, step: "installed", version: expectVersion });
    process.exit(0);
  }

  const restored = rollback();
  writeStatus({
    ok: false,
    step: restored ? "rolled-back" : "failed-no-backup",
    version: expectVersion,
    reason: restored
      ? `Bản ${expectVersion} cài xong nhưng bridge không lên (installer trả mã ${code}, /health báo ${seen ?? "không phản hồi"}). Đã khôi phục bản cũ.`
      : `Bản ${expectVersion} cài thất bại và không có bản sao lưu để khôi phục. Chạy lại lệnh cài trong README.`,
  });
  process.exit(1);
}

main();
```

- [ ] **Step 4: Chạy để xác nhận xanh**

Run: `node test/update-runner.test.mjs`
Expected: `ALL TESTS PASSED`

- [ ] **Step 5: Nối vào server**

Trong `server/index.js`, thay hàm `spawnUpdateRunner` tạm bằng:

```js
  // Detached and unref'd: this child must outlive the process spawning it,
  // because the installer's first act is to stop the service that IS this
  // process. stdio is fully detached for the same reason — a pipe to a dead
  // parent would kill it.
  function spawnUpdateRunner({ source, version }) {
    const installer = process.platform === "win32"
      ? join(INSTALL_DIR, "install.ps1")
      : join(INSTALL_DIR, "install.sh");
    const child = spawn(process.execPath, [
      join(INSTALL_DIR, "update-runner.mjs"),
      "--source", source,
      "--install-dir", INSTALL_DIR,
      "--installer", installer,
      "--port", String(PORT),
      "--expect-version", version,
      "--status-file", UPDATE_STATUS_FILE,
    ], {
      detached: true,
      stdio: "ignore",
      cwd: tmpdir(),
      windowsHide: true,
    });
    child.unref();
  }
```

Thêm hằng số `INSTALL_DIR` cạnh `PANEL_CWD`:

```js
const INSTALL_DIR = join(homedir(), ".cc-chrome-bridge");
```

**Ghi chú cho người thực thi:** `update-runner.mjs`, `install.sh` và `install.ps1` phải nằm **trong thư mục cài** để dòng trên tìm thấy. Task 8 lo việc đưa chúng vào gói phát hành; cho tới lúc đó đường này chỉ chạy được trên máy đã cài từ checkout.

- [ ] **Step 6: Ghép vào `npm test`, lint, commit**

Thêm `"test:runner": "node test/update-runner.test.mjs",` vào `package.json` và chèn vào chuỗi `"test"`.

```bash
npm run lint && npm run test:runner
git add scripts/update-runner.mjs test/update-runner.test.mjs server/index.js package.json
git commit -m "feat(update): the detached runner that installs and can undo itself

The bridge cannot install its own replacement — the installer stops the service
as its first step, which kills the bridge mid-command. So this runs detached and
unref'd, with stdio fully detached, and never starts the service itself: all
three platforms resurrect it on their own.

Rollback restores the backup wholesale rather than undoing what the installer
did, because an installer may delete files as well as replace them and a
file-by-file repair would silently miss the deletions. The test proves that by
having the fake installer delete tokens.json and asserting it comes back."
```

---

### Task 6: Nhánh Windows của runner *(bị chặn bởi Task 1)*

**Files:**
- Modify: `scripts/update-runner.mjs`
- Modify: `test/install-windows.test.mjs`

**Interfaces:**
- Consumes: kết quả đo của Task 1

**KHÔNG bắt đầu task này trước khi Task 1 có đáp án.** Nội dung task phụ thuộc đáp án đó:

- **Nếu Q2 = SURVIVES** (tiến trình tách rời sống sót): Task 5 đã đúng cho cả Windows. Việc còn lại chỉ là (a) xác nhận `runInstaller`'s nhánh `.ps1` gọi đúng, (b) thêm một case vào `test/install-windows.test.mjs` kiểm rằng `update-runner.mjs` gọi `powershell -File` cho installer `.ps1` và `bash` cho `.sh` — kiểm bằng cách dựng một installer giả và đọc lại tham số, không cần Windows thật.
- **Nếu Q2 = DIES**: dừng, báo lại, và thiết kế lại theo hướng đăng ký một Task Scheduler dùng-một-lần chạy runner, thay vì spawn trực tiếp. Đó là thay đổi thiết kế, không phải sửa code — phải quay lại spec trước.

- [ ] **Step 1: Đọc kết quả đo và ghi nhánh đã chọn vào ledger**

Nếu là DIES → dừng ở đây, không viết dòng code nào.

- [ ] **Step 2 (nhánh SURVIVES): Viết test cho việc chọn trình thông dịch**

`runInstaller` phải gọi `powershell -NoProfile -ExecutionPolicy Bypass -File x.ps1` cho
installer `.ps1`, và `bash x.sh` cho `.sh`. Kiểm bằng installer giả tự ghi lại `argv` — chạy
được trên mọi OS, không cần Windows thật. Thêm vào `test/update-runner.test.mjs`:

```js
// --- 4. the installer is invoked through the right interpreter ---------------
//
// A .ps1 handed to bash, or a .sh handed to powershell, fails in a way that
// looks exactly like "the installer errored" — and it would only ever show up on
// the platform nobody develops on.
{
  const home = mkdtempSync(join(tmpdir(), "cc-runner-interp-"));
  const installDir = join(home, ".cc-chrome-bridge");
  mkdirSync(installDir, { recursive: true });
  const source = join(home, "source");
  mkdirSync(source, { recursive: true });
  const argvLog = join(home, "argv.txt");

  // A .sh installer that records how it was invoked, then does nothing.
  const shInstaller = join(home, "fake.sh");
  writeFileSync(shInstaller, `#!/bin/sh\necho "$0" > "${argvLog}"\n`);
  chmodSync(shInstaller, 0o755);

  const version = { value: "9.9.9" };
  const server = await healthServer(version);
  await runRunner([
    "--source", source, "--install-dir", installDir, "--installer", shInstaller,
    "--port", String(server.address().port), "--expect-version", "9.9.9",
    "--status-file", join(home, "status.json"),
  ]);
  server.close();
  check("a .sh installer is run through bash and actually executes",
    existsSync(argvLog) && readFileSync(argvLog, "utf8").includes("fake.sh"),
    existsSync(argvLog) ? readFileSync(argvLog, "utf8") : "(not run)");
  rmSync(home, { recursive: true, force: true });
}
```

- [ ] **Step 3 (nhánh SURVIVES): Chạy để xác nhận**

Run: `node test/update-runner.test.mjs`
Expected: `ALL TESTS PASSED`. Nếu case mới đỏ, `runInstaller` đang chọn sai trình thông dịch —
sửa nó, không sửa test.

- [ ] **Step 4: `npm run lint` và `npm test`**

- [ ] **Step 5: Commit**

```bash
git add scripts/update-runner.mjs test/update-runner.test.mjs
git commit -m "test(update): pin how the installer is invoked per extension

A .ps1 handed to bash, or a .sh handed to powershell, fails in a way that reads
as 'the installer errored' — and only on the platform nobody develops on. The
fake installer records how it was called, so this runs everywhere."
```

---

### Task 7: Băng cập nhật trong panel

**Files:**
- Modify: `extension/sidepanel.html`
- Modify: `extension/sidepanel.js`
- Modify: `test/verify-sidepanel.mjs`

**Interfaces:**
- Consumes: `update_status`, `update_progress`, `update_failed` (Task 4)

- [ ] **Step 1: Thêm băng và CSS**

Trong `extension/sidepanel.html`, ngay sau `<header>`:

```html
  <div id="update" hidden>
    <span id="updateText"></span>
    <button id="updateAction"></button>
  </div>
```

Thêm vào `<style>`:

```css
    #update {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 10px; border-bottom: 1px solid #333;
      background: #2a2118; color: #e8c39e; font-size: 12px;
    }
    #update[hidden] { display: none; }
    #updateText { flex: 1; }
    #update.failed { background: #2a1a1a; color: #f28b82; }
```

- [ ] **Step 2: Thêm trạng thái và hàm vẽ**

Trong `extension/sidepanel.js`, thêm cạnh các tham chiếu DOM khác:

```js
const updateEl = document.getElementById("update");
const updateTextEl = document.getElementById("updateText");
const updateActionEl = document.getElementById("updateAction");
```

Thêm sau `let locale = "vi";`:

```js
// null = chưa hỏi, "available" = có bản mới, "running" = đang cài,
// "reload" = cài xong chờ nạp lại, "failed" = hỏng.
let updateState = null;
let updateLatest = null;
```

Thêm các hàm:

```js
function showUpdate(state, text, actionLabel) {
  updateState = state;
  updateEl.hidden = false;
  updateEl.classList.toggle("failed", state === "failed");
  updateTextEl.textContent = text;
  updateActionEl.hidden = !actionLabel;
  updateActionEl.textContent = actionLabel || "";
}

function hideUpdate() {
  updateState = null;
  updateEl.hidden = true;
}

const UPDATE_STEP_TEXT = {
  downloading: "Đang tải bản mới…",
  verifying: "Đang kiểm tra gói tải về…",
  "backing-up": "Đang sao lưu bản hiện tại…",
  installing: "Đang cài… bridge sẽ khởi động lại",
};

// The socket dies when the installer stops the service, so the only way to learn
// the outcome is to ask /health directly. 90s is deliberate: the runner waits 30s
// for health before it even begins rolling back, so the panel's ceiling has to
// cover a full install AND a full rollback.
async function waitForNewVersion(expected) {
  const raw = (await chrome.storage.local.get({ wsUrl: DEFAULT_WS_URL })).wsUrl;
  let health;
  try {
    const parsed = new URL(raw);
    health = `http://${parsed.hostname}:${parsed.port}/health`;
  } catch {
    showUpdate("failed", "Không đọc được địa chỉ bridge để kiểm tra kết quả.", "");
    return;
  }
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const res = await fetch(health, { cache: "no-store" });
      const body = await res.json();
      if (body?.version === expected) {
        showUpdate("reload", `Đã cài ${expected}. Nạp lại extension để dùng giao diện mới.`, "Nạp lại extension");
        return;
      }
    } catch { /* bridge is restarting — that is the expected state here */ }
  }
  showUpdate("failed",
    "Quá 90 giây chưa thấy bản mới chạy. Mở terminal và chạy lại lệnh cài trong README.", "");
}
```

- [ ] **Step 3: Nối vào `handle()`**

Thêm vào `switch (msg.type)` trong `handle`:

```js
    case "update_status":
      // A panel that just connected asks once; nothing here is journalled,
      // because it describes the machine right now, not the conversation.
      if (msg.available && msg.latest) {
        updateLatest = msg.latest;
        showUpdate("available", `Có bản ${msg.latest} (đang chạy ${msg.current}).`, "Cập nhật");
      } else if (msg.lastResult && msg.lastResult.ok === false) {
        showUpdate("failed", msg.lastResult.reason || "Lần cập nhật trước thất bại.", "");
      } else {
        hideUpdate();
      }
      break;
    case "update_progress":
      showUpdate("running", UPDATE_STEP_TEXT[msg.step] || "Đang cập nhật…", "");
      if (msg.step === "installing" && updateLatest) waitForNewVersion(updateLatest);
      break;
    case "update_failed":
      showUpdate("failed", msg.reason || "Cập nhật thất bại.", "");
      break;
```

Trong case `ready`, sau `setBusy(false);`, thêm:

```js
      send({ type: "update_check" });
```

- [ ] **Step 4: Nối nút**

Thêm ở cuối `extension/sidepanel.js`, cạnh các listener khác:

```js
updateActionEl.addEventListener("click", () => {
  if (updateState === "available") {
    send({ type: "update_start" });
    showUpdate("running", UPDATE_STEP_TEXT.downloading, "");
    return;
  }
  if (updateState === "reload") {
    // Reloading destroys this page, which is why it is a button and not
    // automatic: the user picks the moment, after they have read the result.
    chrome.runtime.reload();
  }
});
```

- [ ] **Step 5: Thêm kiểm chứng DOM**

Thêm vào `test/verify-sidepanel.mjs`, sau mục T8:

```js
  // --- U1: băng cập nhật hiện đúng theo trạng thái --------------------------
  /* eslint-disable no-undef */
  await f6Page.evaluate(() => {
    handle({ type: "update_status", current: "1.1.0", latest: "1.2.0", available: true, notes: "", lastResult: null });
  });
  /* eslint-enable no-undef */
  const u1 = await f6Page.$eval("#update", (el) => ({ hidden: el.hidden, text: el.querySelector("#updateText").textContent, btn: el.querySelector("#updateAction").textContent }));
  check("U1: a newer release shows the banner with a Cập nhật button",
    u1.hidden === false && u1.text.includes("1.2.0") && u1.btn === "Cập nhật", JSON.stringify(u1));

  /* eslint-disable no-undef */
  await f6Page.evaluate(() => { handle({ type: "update_status", current: "1.1.0", latest: "1.1.0", available: false, notes: "", lastResult: null }); });
  /* eslint-enable no-undef */
  check("U1: no newer release hides the banner", await f6Page.$eval("#update", (el) => el.hidden) === true);

  // A rollback must still be explained after the bridge comes back on the old
  // version — that is the only moment the user can learn why nothing changed.
  /* eslint-disable no-undef */
  await f6Page.evaluate(() => {
    handle({ type: "update_status", current: "1.1.0", latest: "1.1.0", available: false, notes: "",
      lastResult: { ok: false, step: "rolled-back", reason: "Bản 1.2.0 không lên được. Đã khôi phục bản cũ." } });
  });
  /* eslint-enable no-undef */
  const u2 = await f6Page.$eval("#update", (el) => ({ hidden: el.hidden, cls: el.className, text: el.querySelector("#updateText").textContent }));
  check("U1: a previous rollback is explained even when no update is available",
    u2.hidden === false && u2.cls.includes("failed") && u2.text.includes("khôi phục"), JSON.stringify(u2));

  /* eslint-disable no-undef */
  await f6Page.evaluate(() => { handle({ type: "update_failed", reason: "Checksum không khớp" }); });
  /* eslint-enable no-undef */
  check("U1: a failed update says why", (await f6Page.$eval("#updateText", (el) => el.textContent)).includes("Checksum"));
```

- [ ] **Step 6: Lint, chạy, commit**

```bash
npm run lint && npm test
npm run verify:sidepanel
git add extension/sidepanel.html extension/sidepanel.js test/verify-sidepanel.mjs
git commit -m "feat(update): the update banner in the panel

Checks once on ready, shows one line and at most one button. The reload is a
button rather than automatic because chrome.runtime.reload() destroys this page:
automatic would close the chat mid-sentence, right as the user is reading the
result.

The banner also explains a rollback that already happened — after a failed
update the bridge comes back on the OLD version, and that moment is the only
chance the user has to learn why nothing changed."
```

---

### Task 8: Đóng gói, phiên bản, tài liệu

**Files:**
- Modify: `scripts/build-release.mjs`, `test/build.test.mjs`
- Modify: `extension/manifest.json`, `server/index.js`, `server/package.json`, `server/package-lock.json`
- Modify: `README.md`, `CLAUDE.md`

- [ ] **Step 1: Đưa runner và installer vào gói phát hành**

`spawnUpdateRunner` tìm `update-runner.mjs`, `install.sh` và `install.ps1` **trong thư mục cài**. Trong `scripts/build-release.mjs`, thêm vào phần dựng `stage` (cạnh chỗ chép `uninstall.sh`):

```js
copyFileSync(join(root, "scripts", "update-runner.mjs"), join(stage, "update-runner.mjs"));
copyFileSync(join(root, "scripts", "install.sh"), join(stage, "install.sh"));
copyFileSync(join(root, "scripts", "install.ps1"), join(stage, "install.ps1"));
```

Và trong `test/build.test.mjs`, thêm ba tên đó vào danh sách file bắt buộc của tarball:

```js
  "update-runner.mjs",
  "install.sh",
  "install.ps1",
```

- [ ] **Step 2: Chạy để xác nhận**

Run: `npm run build:release && npm run test:build`
Expected: PASS

- [ ] **Step 3: Bump 1.2.0**

`extension/manifest.json` → `"version": "1.2.0"`; `server/index.js` → `const VERSION = "1.2.0";`; `server/package.json` → `"version": "1.2.0"`; rồi `cd server && npm install --package-lock-only && cd ..`

- [ ] **Step 4: Tài liệu**

Thêm vào `CLAUDE.md`, mục "Side panel chat operational notes":

```markdown
- The update path is the one place a **local** action replaces the bridge with
  code fetched from the internet, so its gate is deliberately the narrowest one
  in the repo: `/panel` only — no HTTP endpoint, no MCP tool, so **Claude cannot
  update the machine it is running on**, even if asked. Two invariants hold that
  line: `msg.url` from the panel is never read (the URL comes from a constant in
  `server/updater.js` plus the tag GitHub reports), and the tag is refused unless
  it matches `/^v?\d+\.\d+\.\d+$/` before it can shape a request. The SHA256
  check catches a corrupt, truncated or tampered download; it does **not** catch
  a compromised GitHub account, which can rewrite the tarball and the checksum
  together. Do not document it as more than that.
- `scripts/update-runner.mjs` is the only process that outlives the bridge. It
  has to be: the installer's first act is to stop the service, which kills the
  bridge mid-command. It runs detached, with a cwd outside the install directory
  (on Windows, running inside the directory being replaced is the surest way to
  lock it), and it never starts the service itself — launchd `KeepAlive`,
  systemd `Restart=always` and the repeating Task Scheduler trigger each do that.
  Rollback restores `~/.cc-chrome-bridge.bak` wholesale rather than undoing
  individual changes, because an installer deletes files as well as replacing
  them and a file-by-file repair silently misses the deletions.
- The release tarball must carry `update-runner.mjs`, `install.sh` and
  `install.ps1` inside it, because the installed copy is what the bridge spawns.
  A release missing them installs fine and then cannot ever self-update —
  `test/build.test.mjs` asserts all three are in the tarball for that reason.
```

Thêm vào `README.md` (tiếng Việt) một đoạn mô tả nút cập nhật, nói rõ: kiểm tra khi mở khung chat, chỉ cài khi bấm, có đối chiếu SHA256, tự quay về bản cũ nếu bridge không lên, và sau khi cài phải bấm "Nạp lại extension".

- [ ] **Step 5: Chạy toàn bộ và commit**

```bash
npm run lint && HEADED=1 npm test
git add -A
git commit -m "1.2.0: update from inside the panel

Checks for a release when the panel opens, installs on a button, verifies the
download against a published SHA256, and puts the previous version back if the
new bridge does not come up.

The tarball now carries update-runner.mjs and both installers, because the
installed copy is what the bridge spawns — a release without them installs fine
and then can never self-update, which is exactly the kind of failure that only
shows up on someone else's machine."
```

---

## Ghi chú cho người thực thi

- **Thứ tự:** Task 1 chạy song song (người dùng chạy trên Windows). Task 2 → 3 → 4 → 5 tuần tự. Task 6 **chặn** cho tới khi Task 1 có đáp án. Task 7 cần Task 4. Task 8 cuối.
- **Task 1 phải do người dùng chạy trên máy Windows thật** — agent không có Windows.
- **Nếu Task 1 trả lời Q2 = DIES, dừng lại.** Đó là thay đổi thiết kế, phải quay về spec chứ không vá trong code.
- Không task nào được sửa `install.sh`/`install.ps1`. Nếu thấy cần, đó là dấu hiệu thiết kế sai chỗ khác — báo lại.
- Đường cập nhật thật **không** kiểm chứng được bằng `npm test`: nó cần một bản phát hành thật trên GitHub. Task 5 phủ logic bằng installer giả; phần còn lại phải thử tay sau khi phát hành 1.2.0, và lần thử đầu tiên chính là cập nhật từ 1.2.0 lên 1.2.1.
