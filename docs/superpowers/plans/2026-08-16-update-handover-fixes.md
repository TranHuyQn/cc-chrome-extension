# Update Handover Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Làm cho nút cập nhật thật sự chạy được: đưa ba file cần thiết vào thư mục cài, và tách trình cập nhật ra khỏi vòng đời của dịch vụ để nó không bị giết giữa chừng.

**Architecture:** Hai lỗi chặn, độc lập nhau. C1: `reshapeToCheckout` và cả hai installer phải đưa `update-runner.mjs`, `install.sh`, `install.ps1` vào `$INSTALL_DIR` — nơi `spawnUpdateRunner` đọc. C2: trình cập nhật không được là con cháu của dịch vụ; macOS giữ nguyên (đã đo là an toàn), Linux dùng `systemd-run --user`, Windows nhờ Task Scheduler làm cha. Cách bàn giao được tách thành một hàm thuần nhận `platform` làm tham số, theo đúng khuôn mẫu `buildSpawn()` đã có trong `server/agent.js`, nên cả ba nhánh test được từ bất kỳ máy nào.

**Tech Stack:** Node ESM, bash, PowerShell, systemd (`systemd-run`), Windows Task Scheduler (`schtasks`), launchd.

**Spec:** `docs/superpowers/specs/2026-08-15-extension-update-button-design.md` — đặc biệt **mục G2 (SỬA ĐỔI 2026-08-16)**, thay thế mục A bước 6.

## Global Constraints

- **`spawnUpdateRunner` đọc ba file từ `$INSTALL_DIR`**: `update-runner.mjs`, `install.sh`, `install.ps1`. Bất cứ đường nào không đưa chúng tới đó đều làm nút cập nhật hỏng im lặng trên mọi máy.
- **Được phép sửa `install.sh` và `install.ps1`.** Kế hoạch trước cấm điều này, và chính lệnh cấm đó đẻ ra C1. Nhưng chỉ sửa phần dàn dựng/chuyển file — không đụng vào logic dịch vụ, token, hay đăng ký MCP.
- **Chép file mới ở bước dàn dựng, TRƯỚC khi dừng dịch vụ.** Thiếu file thì phải dừng lại an toàn trong khi dịch vụ vẫn chạy, chứ không phải sau khi đã tắt nó.
- **Trình cập nhật không được là con cháu của dịch vụ** trên Linux và Windows. macOS giữ nguyên `spawn(detached)` — đã đo: heartbeat 18 → 26 qua `launchctl bootout`.
- **Cách bàn giao phải là hàm thuần nhận `platform`**, để cả ba nhánh test được từ macOS. Khuôn mẫu: `buildSpawn(bin, args, platform)` trong `server/agent.js`.
- **Linux chưa đo trên phần cứng thật** — không có máy Linux. Mọi tài liệu phải ghi rõ đó là suy luận từ hành vi có tài liệu của systemd, không phải kết quả đo.
- Code/comment/commit tiếng Anh; chuỗi người dùng đọc tiếng Việt. `npm run lint` giữ 0 lỗi.
- Version giữ **1.2.0** — chưa phát hành gì, không cần bump thêm.
- **Chạy `npm test` đầy đủ ít nhất một lần giữa kế hoạch**, không chỉ ở task cuối. Kế hoạch trước để `npm test` đỏ suốt sáu task vì mỗi task chỉ chạy suite hẹp.

---

### Task 1: `reshapeToCheckout` mang theo ba file

**Files:**
- Modify: `server/updater.js` (hằng `scripts` trong `reshapeToCheckout`)
- Test: `test/updater.test.mjs`

**Interfaces:**
- Produces: gói dựng lại có thêm `<target>/scripts/{update-runner.mjs, install.sh, install.ps1}`. Task 2 chép chúng từ đó vào `$INSTALL_DIR`.

- [ ] **Step 1: Viết test thất bại**

Trong `test/updater.test.mjs`, tìm khối dựng thư mục `extracted` giả. Thêm ba file vào danh sách file được tạo, và thêm khẳng định. Sửa vòng lặp tạo file:

```js
for (const f of ["ccchrome.md", "uninstall.sh", "service-unit.sh", "uninstall.ps1", "service-task.ps1",
                 "update-runner.mjs", "install.sh", "install.ps1"]) {
  writeFileSync(join(extracted, f), f);
}
```

và thêm ngay sau các khẳng định `scripts/` hiện có:

```js
// The three files spawnUpdateRunner reads out of the install directory. A
// release tarball missing any of them must fail HERE, while nothing has been
// touched — not at the moment the user presses the button, which is where the
// first version of this feature failed on every machine.
for (const f of ["update-runner.mjs", "install.sh", "install.ps1"]) {
  check(`${f} lands in scripts/ — spawnUpdateRunner reads it from the install dir`,
    readFileSync(join(target, "scripts", f), "utf8") === f);
}

const missingRunner = join(work, "no-runner");
mkdirSync(join(missingRunner, "server"), { recursive: true });
mkdirSync(join(missingRunner, "extension"), { recursive: true });
for (const f of ["ccchrome.md", "uninstall.sh", "service-unit.sh", "uninstall.ps1", "service-task.ps1",
                 "install.sh", "install.ps1"]) {
  writeFileSync(join(missingRunner, f), f);
}
let runnerErr = null;
try {
  reshapeToCheckout(missingRunner, join(work, "no-runner-out"));
} catch (err) {
  runnerErr = err.message;
}
check("a tarball missing update-runner.mjs is refused, by name",
  runnerErr && runnerErr.includes("update-runner.mjs"), String(runnerErr));
check("and leaves no half-built directory behind",
  !existsSync(join(work, "no-runner-out")), join(work, "no-runner-out"));
```

- [ ] **Step 2: Chạy để xác nhận đỏ**

Run: `node test/updater.test.mjs`
Expected: FAIL — `update-runner.mjs lands in scripts/` (ENOENT), vì hàm chưa chép file đó.

- [ ] **Step 3: Cài đặt tối thiểu**

Trong `server/updater.js`, sửa dòng khai báo `scripts` trong `reshapeToCheckout`:

```js
  // The last three are what spawnUpdateRunner reads out of the install
  // directory. They are listed here, not just in the tarball, so a release
  // missing them fails while nothing has been touched — the tarball carrying a
  // file is not the same as the installer putting it where the bridge looks.
  const scripts = [
    "uninstall.sh", "service-unit.sh", "uninstall.ps1", "service-task.ps1",
    "update-runner.mjs", "install.sh", "install.ps1",
  ];
```

- [ ] **Step 4: Chạy để xác nhận xanh**

Run: `node test/updater.test.mjs`
Expected: `ALL TESTS PASSED`

- [ ] **Step 5: Lint và commit**

```bash
npm run lint && npm run test:updater
git add server/updater.js test/updater.test.mjs
git commit -m "fix(update): carry the runner and both installers into the reshaped source

spawnUpdateRunner reads update-runner.mjs, install.sh and install.ps1 out of the
install directory, but reshapeToCheckout never carried them, so a release could
satisfy every check and still produce an install where the button does nothing.
Listing them here means a tarball missing one fails while nothing has been
touched, which is the whole reason this function validates before it writes."
```

---

### Task 2: Cả hai installer đưa ba file vào thư mục cài

**Files:**
- Modify: `scripts/install.sh` (khối dàn dựng ~105-127 và khối chuyển ~172-183)
- Modify: `scripts/install.ps1` (khối dàn dựng ~108-136 và khối chuyển ~160-170)
- Test: `test/install.test.mjs`

**Interfaces:**
- Consumes: `<source>/scripts/{update-runner.mjs, install.sh, install.ps1}` (Task 1)
- Produces: `$INSTALL_DIR/{update-runner.mjs, install.sh, install.ps1}` — thứ `spawnUpdateRunner` đọc.

Đây là task quan trọng nhất của kế hoạch: nó là thứ biến nút cập nhật từ "không chạy trên máy nào" thành "chạy".

- [ ] **Step 1: Viết test thất bại**

`test/install.test.mjs` đã chạy `install.sh` thật vào một `HOME` giả và khẳng định `uninstall.sh` có mặt. Thêm ngay cạnh đó:

```js
// The three files the update button spawns. They were in the release tarball
// but no installer moved them into place, so every install produced a bridge
// whose update button silently did nothing — the failure the manual install
// path can never reveal, because the manual path never uses them.
for (const f of ["update-runner.mjs", "install.sh", "install.ps1"]) {
  check(`install.sh puts ${f} in the install dir (spawnUpdateRunner reads it there)`,
    existsSync(join(installDir, f)), join(installDir, f));
}
```

- [ ] **Step 2: Chạy để xác nhận đỏ**

Run: `npm run test:install`
Expected: FAIL cả ba — `install.sh puts update-runner.mjs in the install dir`, v.v.

- [ ] **Step 3: Sửa `install.sh`**

Trong nhánh `CC_CHROME_SOURCE` (khối `if [ -n "$SOURCE" ]`), thêm sau dòng chép `service-unit.sh`:

```bash
  # The three files the bridge spawns when the user presses "Cập nhật". Copied
  # at STAGING time on purpose: if one is missing the script aborts here under
  # `set -euo pipefail`, with the service still running and nothing replaced.
  for f in update-runner.mjs install.sh install.ps1; do
    cp "$SOURCE/scripts/$f" "$stage/$f"
  done
```

Trong nhánh tải về (khối `else`), thêm sau dòng chép `service-unit.sh`:

```bash
  for f in update-runner.mjs install.sh install.ps1; do
    cp "$tmp/$f" "$stage/$f" || die "gói phát hành thiếu $f — không cập nhật được từ trong khung chat."
  done
```

Trong khối chuyển vào `$INSTALL_DIR` (sau dòng `mv "$stage/service-unit.sh" ...`), thêm:

```bash
for f in update-runner.mjs install.sh install.ps1; do
  mv "$stage/$f" "$INSTALL_DIR/$f"
done
```

- [ ] **Step 4: Chạy để xác nhận xanh**

Run: `npm run test:install`
Expected: PASS toàn bộ, gồm ba khẳng định mới.

- [ ] **Step 5: Sửa `install.ps1` tương ứng**

Trong nhánh `$Source`, sau dòng chép `service-task.ps1`:

```powershell
    # The three files the bridge spawns for an in-panel update. Copied at
    # staging time so a missing one stops the script while the service is still
    # running and nothing has been replaced.
    foreach ($f in 'update-runner.mjs', 'install.sh', 'install.ps1') {
        Copy-Item (Join-Path $Source 'scripts' | Join-Path -ChildPath $f) (Join-Path $stage $f)
    }
```

Trong nhánh tải về, sau vòng lặp chép `uninstall.ps1`/`service-task.ps1`:

```powershell
    foreach ($f in 'update-runner.mjs', 'install.sh', 'install.ps1') {
        $src = Join-Path $tmp $f
        if (-not (Test-Path $src)) { throw "gói phát hành thiếu $f — không cập nhật được từ trong khung chat." }
        Copy-Item $src (Join-Path $stage $f)
    }
```

Trong khối chuyển vào `$InstallDir`, mở rộng vòng lặp `foreach ($f in 'ccchrome.md', ...)` thành:

```powershell
foreach ($f in 'ccchrome.md', 'uninstall.ps1', 'service-task.ps1', 'update-runner.mjs', 'install.sh', 'install.ps1') {
    Move-Item -Force (Join-Path $stage $f) (Join-Path $InstallDir $f)
}
```

- [ ] **Step 6: Kiểm cú pháp PowerShell**

Máy này không có `pwsh`, nên CI là nơi bắt lỗi cú pháp `.ps1`. Đọc lại kỹ hai khối vừa thêm — đặc biệt `Join-Path` lồng nhau ở Step 5, dạng `Join-Path $Source 'scripts' | Join-Path -ChildPath $f`. Nếu thấy khó đọc, dùng dạng rõ ràng hơn:

```powershell
$scriptsDir = Join-Path $Source 'scripts'
foreach ($f in 'update-runner.mjs', 'install.sh', 'install.ps1') {
    Copy-Item (Join-Path $scriptsDir $f) (Join-Path $stage $f)
}
```

Và xác nhận file vẫn có BOM UTF-8 và không có ký tự ngoài ASCII trong phần bạn thêm:

```bash
head -c3 scripts/install.ps1 | od -An -tx1     # phải là ef bb bf
```

- [ ] **Step 7: Chạy toàn bộ và commit**

```bash
npm run lint && HEADED=1 npm test
git add scripts/install.sh scripts/install.ps1 test/install.test.mjs
git commit -m "fix(update): install the runner and both installers into the install dir

spawnUpdateRunner reads all three out of \$INSTALL_DIR, but neither installer
ever moved them there — they were extracted to a temp dir and deleted with it.
Every install produced a bridge whose update button spawned a path that did not
exist, failed with MODULE_NOT_FOUND into an ignored stdio, and left the panel to
time out after 90 seconds with a message describing something else.

The copies happen at staging time, before the service is stopped, so a release
missing a file aborts with the old install still running.

test/install.test.mjs now asserts all three land — it already ran a real
install.sh into a temp HOME, so the check that would have caught this from the
start was five lines away."
```

---

### Task 3: Bàn giao theo nền tảng — trình cập nhật thoát khỏi vòng đời dịch vụ

**Files:**
- Modify: `server/updater.js` (thêm `buildRunnerSpawn`)
- Modify: `server/index.js` (`spawnUpdateRunner` dùng nó)
- Modify: `scripts/update-runner.mjs` (tự gỡ scheduled task trên Windows)
- Test: `test/updater.test.mjs`

**Interfaces:**
- Produces: `buildRunnerSpawn(platform, { node, runner, args, taskName }) => { command, args }` — hàm thuần, ba nhánh nền tảng, test được từ mọi máy.

- [ ] **Step 1: Viết test thất bại**

Thêm vào `test/updater.test.mjs`:

```js
// --- how the runner is handed over, per platform ----------------------------
//
// The runner must not be a descendant of the service, because stopping the
// service is the installer's first act and every platform's stop kills
// differently. Measured 2026-08-16: macOS's `launchctl bootout` leaves a
// detached child running (heartbeat 18 -> 26), so darwin keeps spawning
// directly. Windows' Stop-CcTask ends in `taskkill /T /F`, which kills
// descendants by parent PID, and Linux's `systemctl --user disable --now` takes
// the whole cgroup — detached:true is setsid(), which does not leave a cgroup.
{
  const base = { node: "/usr/bin/node", runner: "/inst/update-runner.mjs", args: ["--port", "8787"], taskName: "cc-update-1" };

  const mac = buildRunnerSpawn("darwin", base);
  check("darwin spawns node directly — measured safe under launchctl bootout",
    mac.command === "/usr/bin/node" && mac.args[0] === "/inst/update-runner.mjs", JSON.stringify(mac));
  check("darwin passes the runner's own arguments through",
    mac.args.includes("--port") && mac.args.includes("8787"), JSON.stringify(mac.args));

  const linux = buildRunnerSpawn("linux", base);
  check("linux hands the runner to systemd so it gets its own cgroup",
    linux.command === "systemd-run", linux.command);
  check("linux runs it as a user unit, not a scope — a scope stays a child of the caller",
    linux.args.includes("--user") && linux.args.some((a) => a.startsWith("--unit=")), JSON.stringify(linux.args));
  check("linux lets systemd clean the unit up afterwards",
    linux.args.includes("--collect"), JSON.stringify(linux.args));
  check("linux still ends with node, the runner and its arguments",
    linux.args.includes("/usr/bin/node") && linux.args.includes("/inst/update-runner.mjs") && linux.args.includes("8787"),
    JSON.stringify(linux.args));

  const win = buildRunnerSpawn("win32", base);
  check("win32 goes through schtasks so Task Scheduler becomes the parent",
    win.command === "schtasks", win.command);
  check("win32 creates the task under the name it was given",
    win.args.includes("/tn") && win.args.includes("cc-update-1"), JSON.stringify(win.args));
  check("win32 schedules it to run once, not on a repeating trigger",
    win.args.includes("/sc") && win.args.includes("ONCE"), JSON.stringify(win.args));

  let badPlatform = null;
  try {
    buildRunnerSpawn("sunos", base);
  } catch (err) {
    badPlatform = err.message;
  }
  check("an unsupported platform is refused by name rather than silently spawning something",
    badPlatform && badPlatform.includes("sunos"), String(badPlatform));
}
```

Thêm `buildRunnerSpawn` vào dòng import ở đầu `test/updater.test.mjs`.

- [ ] **Step 2: Chạy để xác nhận đỏ**

Run: `node test/updater.test.mjs`
Expected: FAIL — `does not provide an export named 'buildRunnerSpawn'`

- [ ] **Step 3: Cài đặt tối thiểu**

Thêm vào `server/updater.js`:

```js
// How the updater is launched so that stopping the service does not kill it.
//
// Takes the platform as an argument, like buildSpawn() in server/agent.js does,
// so all three branches are testable from one machine — which matters here more
// than usual, because the branch that was wrong last time was the one nobody
// could run.
//
// Measured 2026-08-16, each against the command the installer actually runs:
//   macOS   `launchctl bootout`            -> detached child SURVIVES (18 -> 26 heartbeats)
//   Windows `Stop-CcTask` (taskkill /T /F) -> kills descendants by parent PID
//   Linux   `systemctl --user disable --now` -> kills the whole cgroup; NOT measured
//            on real hardware (no Linux machine), reasoned from KillMode=control-group
export function buildRunnerSpawn(platform, { node, runner, args, taskName }) {
  if (platform === "darwin") {
    return { command: node, args: [runner, ...args] };
  }
  if (platform === "linux") {
    // --unit, not --scope: a scope runs in the CALLER's cgroup and would die
    // with it. --unit asks systemd to fork the process itself, giving it its
    // own cgroup and its own lifetime. --collect removes the unit when it exits.
    return {
      command: "systemd-run",
      args: ["--user", "--collect", `--unit=${taskName}`, node, runner, ...args],
    };
  }
  if (platform === "win32") {
    // Task Scheduler becomes the parent, so taskkill /T against the bridge
    // cannot reach the runner. /f overwrites a stale task of the same name;
    // the runner deletes the task itself when it finishes.
    const command = [node, runner, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
    return {
      command: "schtasks",
      args: ["/create", "/tn", taskName, "/tr", command, "/sc", "ONCE", "/st", "00:00", "/f"],
    };
  }
  throw new Error(`Không hỗ trợ cập nhật tự động trên nền tảng '${platform}'.`);
}
```

- [ ] **Step 4: Chạy để xác nhận xanh**

Run: `node test/updater.test.mjs`
Expected: `ALL TESTS PASSED`

- [ ] **Step 5: Dùng nó trong `spawnUpdateRunner`**

Thay thân `spawnUpdateRunner` trong `server/index.js`:

```js
  function spawnUpdateRunner({ source, work, version }) {
    const installer = process.platform === "win32"
      ? join(INSTALL_DIR, "install.ps1")
      : join(INSTALL_DIR, "install.sh");
    const taskName = `cc-chrome-update-${version.replace(/\./g, "-")}-${process.pid}`;
    const runnerArgs = [
      "--source", source,
      "--work", work,
      "--install-dir", INSTALL_DIR,
      "--installer", installer,
      "--port", String(PORT),
      "--expect-version", version,
      "--status-file", UPDATE_STATUS_FILE,
      "--task-name", taskName,
    ];
    const { command, args } = buildRunnerSpawn(process.platform, {
      node: process.execPath,
      runner: join(INSTALL_DIR, "update-runner.mjs"),
      args: runnerArgs,
      taskName,
    });
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      cwd: tmpdir(),
      windowsHide: true,
    });
    child.unref();

    // schtasks /create only registers the task; it still has to be started.
    // This second call is short-lived and its death is harmless — by the time
    // the installer stops the service, Task Scheduler already owns the runner.
    if (process.platform === "win32") {
      const starter = spawn("schtasks", ["/run", "/tn", taskName], {
        detached: true, stdio: "ignore", windowsHide: true,
      });
      starter.unref();
    }
  }
```

Thêm `buildRunnerSpawn` vào dòng import từ `./updater.js`.

- [ ] **Step 6: Trình cập nhật tự gỡ task của mình trên Windows**

Trong `scripts/update-runner.mjs`, thêm `taskName` vào các tham số đọc được, và gỡ task ở cuối `main()` cũng như trong `main().catch()`:

```js
const taskName = arg("task-name");

// Windows only: the one-shot task that gave this process a parent other than
// the bridge. Left behind it would sit in Task Scheduler forever with a start
// time in the past. Best effort — a leftover task is harmless, and failing to
// remove it must never change the outcome that was already recorded.
function removeOwnTask() {
  if (process.platform !== "win32" || !taskName) return;
  try {
    spawnSync("schtasks", ["/delete", "/tn", taskName, "/f"], { stdio: "ignore", windowsHide: true });
  } catch { /* best effort */ }
}
```

Gọi `removeOwnTask()` ngay trước mỗi `process.exit(...)` trong `main()` và trong `main().catch()`. Thêm `spawnSync` vào import từ `node:child_process`.

- [ ] **Step 7: Chạy và commit**

```bash
npm run lint && node test/updater.test.mjs && node test/update-runner.test.mjs && npm run test:panelproto
git add server/updater.js server/index.js scripts/update-runner.mjs test/updater.test.mjs
git commit -m "fix(update): give the runner a parent that outlives the service

The runner was a child of the bridge, and every platform's service stop kills
differently: macOS's launchctl bootout leaves a detached child alone (measured,
18 -> 26 heartbeats), but Windows' Stop-CcTask ends in taskkill /T /F which kills
descendants by parent PID, and Linux's systemctl --user disable --now takes the
whole cgroup — detached:true is setsid(), which does not leave one. On both, the
process responsible for restoring the backup died before it could.

Linux now hands the runner to systemd-run --user --unit (a scope would stay in
the caller's cgroup), Windows registers a one-shot scheduled task so Task
Scheduler is the parent, and macOS keeps spawning directly.

buildRunnerSpawn takes the platform as an argument, like buildSpawn in
agent.js, so all three branches are tested from one machine. The branch that was
wrong last time was the one nobody could run."
```

---

### Task 4: Đo lại trên Windows — lần này đo bản sửa

**Files:**
- Modify: `scripts/probe-windows-update.ps1`

**Interfaces:**
- Consumes: cách bàn giao mới (Task 3)
- Produces: câu trả lời cho "trình cập nhật chạy qua scheduled task có sống sót khi `Stop-CcTask` giết bridge không"

Task này **người dùng chạy trên máy Windows thật**. Agent chỉ viết script.

- [ ] **Step 1: Viết lại phần Q2 để đo đúng đường mã sản phẩm dùng**

Lỗi lần trước là đo `Stop-ScheduledTask` trong khi sản phẩm gọi `Stop-CcTask`. Lần này script phải **nạp chính `service-task.ps1`** và gọi hàm thật. Thay khối Q2 bằng:

```powershell
# --- Q2: does a runner launched through Task Scheduler survive Stop-CcTask? --
# The previous version of this probe called Stop-ScheduledTask. The product does
# not: install.ps1 calls Stop-CcTask, which ends in `taskkill /pid <bridge> /T /F`.
# Measuring the wrong command produced a true answer to a question nobody asked.
$beat     = Join-Path $probe 'heartbeat.txt'
$child    = Join-Path $probe 'child.ps1'
$taskName = 'CcProbeRunnerTask'

Set-Content -Path $child -Value ("1..30 | ForEach-Object { Add-Content -Path '$beat' -Value ('beat ' + `$_); Start-Sleep -Seconds 1 }")

# Register the child the way spawnUpdateRunner now does: as its own one-shot
# task, so Task Scheduler is its parent rather than whoever created it.
$cmd = 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + $child + '"'
schtasks /create /tn $taskName /tr $cmd /sc ONCE /st 00:00 /f | Out-Null
schtasks /run /tn $taskName | Out-Null
Start-Sleep -Seconds 6

$before = @(Get-Content $beat -ErrorAction SilentlyContinue).Count
Write-Host "heartbeat lines before the kill: $before"
if ($before -eq 0) {
    Write-Host 'Q2 INCONCLUSIVE: the scheduled task never started its child. Report this.'
} else {
    # Kill this shell's whole process tree the way Stop-CcTask kills the bridge's.
    # If the runner were still a descendant, this would take it with it.
    Write-Host "killing this process tree (pid $PID) with taskkill /T, as Stop-CcTask does"
    Start-Process -FilePath 'cmd' -ArgumentList '/c', "timeout /t 2 >nul & taskkill /pid $PID /T /F" -WindowStyle Hidden
    Start-Sleep -Seconds 10
    $after = @(Get-Content $beat -ErrorAction SilentlyContinue).Count
    Write-Host "heartbeat lines after the kill:  $after"
    if ($after -gt $before) {
        Write-Host 'Q2 ANSWER: the task-launched runner SURVIVES a taskkill /T on its launcher'
    } else {
        Write-Host 'Q2 ANSWER: it DIES - the handover still does not work on Windows'
    }
}
schtasks /delete /tn $taskName /f | Out-Null
```

**Lưu ý cho người thực thi:** `taskkill /pid $PID /T /F` giết chính cửa sổ PowerShell đang chạy script, nên các dòng sau nó sẽ không in ra trong cửa sổ đó. Ghi kết quả ra file thay vì chỉ `Write-Host`, và in đường dẫn file đó ra **trước** khi giết:

```powershell
$result = Join-Path $probe 'q2-result.txt'
Write-Host "Q2 result will be written to: $result"
```

rồi dùng `Add-Content -Path $result` song song với mỗi `Write-Host` trong khối trên.

- [ ] **Step 2: Kiểm ASCII và BOM**

```bash
head -c3 scripts/probe-windows-update.ps1 | od -An -tx1              # ef bb bf
tail -c +4 scripts/probe-windows-update.ps1 | LC_ALL=C grep -n '[^ -~\t]'   # không in gì
```

- [ ] **Step 3: Commit**

```bash
git add scripts/probe-windows-update.ps1
git commit -m "probe: measure the command the product runs, not an equivalent

The previous Q2 called Stop-ScheduledTask; install.ps1 calls Stop-CcTask, which
ends in taskkill /pid <bridge> /T /F. That difference is the entire defect this
plan exists to fix, and the probe was blind to it.

Q2 now launches the child through a one-shot scheduled task — the way
spawnUpdateRunner does after this plan — and kills the launcher's process tree
with taskkill /T, which is what Stop-CcTask does to the bridge."
```

- [ ] **Step 4: Người dùng chạy, kết quả ghi vào spec**

Chạy trên Windows: `powershell -ExecutionPolicy Bypass -File .\scripts\probe-windows-update.ps1`, rồi đọc file kết quả mà script in đường dẫn ra.

Nếu `Q2 ANSWER: it DIES`, **dừng lại và báo** — cách bàn giao qua Task Scheduler không đủ, và phải quay lại spec. Nếu SURVIVES, ghi kết quả vào mục G2 của spec, cạnh bảng đã có.

---

### Task 5: Bốn lỗi Important

**Files:**
- Modify: `extension/sidepanel.js` (I1)
- Modify: `scripts/uninstall.sh`, `scripts/uninstall.ps1` (I2)
- Modify: `scripts/update-runner.mjs` (I3)
- Modify: `server/index.js`, `extension/sidepanel.js` (I4)
- Test: `test/verify-sidepanel.mjs`, `test/update-runner.test.mjs`

Bốn sửa nhỏ, độc lập nhau, gộp một task vì mỗi cái chỉ vài dòng.

- [ ] **Step 1: I1 — nút "Nạp lại extension" không được biến mất**

Sau khi cài xong, panel hiện băng "Đã cài X — Nạp lại extension". Nhưng socket kết nối lại, gửi `update_check`, bridge mới trả `available:false, lastResult.ok:true`, và handler rơi vào `hideUpdate()` — **xoá mất lời nhắc**, thường trong vòng 2–30 giây. README lại bảo người dùng **phải** bấm nút đó.

Trong `extension/sidepanel.js`, ngay đầu case `update_status`:

```js
      // The reload prompt outranks any status. After a successful install the
      // reconnecting socket asks again, the new bridge answers "no update
      // available", and the old code hid the one button the user still has to
      // press — usually within seconds of it appearing.
      if (updateState === "reload") break;
```

- [ ] **Step 2: I1 — kiểm chứng**

Thêm vào `test/verify-sidepanel.mjs`, sau các mục U1:

```js
  /* eslint-disable no-undef */
  await f6Page.evaluate(() => {
    showUpdate("reload", "Đã cài 1.2.1. Nạp lại extension để dùng giao diện mới.", "Nạp lại extension");
    handle({ type: "update_status", current: "1.2.1", latest: "1.2.1", available: false, notes: "",
      lastResult: { ok: true, version: "1.2.1" } });
  });
  /* eslint-enable no-undef */
  const u5 = await f6Page.$eval("#update", (el) => ({ hidden: el.hidden, text: el.querySelector("#updateText").textContent }));
  check("U5: a reconnect after a successful install does not erase the reload prompt",
    u5.hidden === false && u5.text.includes("Nạp lại"), JSON.stringify(u5));
```

`showUpdate` là khai báo hàm ở cấp cao nhất của một classic script (`extension/sidepanel.js:224`), nên nó đã là global và Playwright gọi thẳng được — không cần dựng trạng thái vòng vo.

- [ ] **Step 3: I2 — uninstall dọn sạch các file mới**

Tính năng này thêm bốn thứ vào `$HOME` mà không trình gỡ nào biết: `~/.ccchrome-update.json`, file nhật ký, `~/.cc-chrome-bridge.bak`, `~/.cc-chrome-bridge.failed`. Bản `.bak` là một bản sao đầy đủ, hàng chục MB. Điều này phá vỡ tính chất "gỡ một lần, không để lại gì" mà commit `85116f2` đã thiết lập.

Trong `scripts/uninstall.sh`, cạnh chỗ xoá `$INSTALL_DIR` và `~/.ccchrome.json`:

```bash
# Artifacts the in-panel updater leaves behind. A .bak is a full copy of the
# install — tens of megabytes — and nothing else ever prunes any of these.
step_rm "$HOME/.ccchrome-update.json"
step_rm "$HOME/.ccchrome-update.log"
step_rm "$INSTALL_DIR.bak"
step_rm "$INSTALL_DIR.failed"
```

Hàm là `step_rm` (`scripts/uninstall.sh:50`), không phải `remove_path` — đọc chữ ký của nó trước khi gọi, vì nó phân biệt thư mục với file và đếm vào phần tổng kết mà bản gỡ in ra cuối cùng. Đặt bốn dòng này cùng chỗ với các lần `step_rm` đang có, để `--dry-run` cũng liệt kê chúng.

Trong `scripts/uninstall.ps1`, thêm bốn đường dẫn tương ứng vào danh sách xoá đã có.

- [ ] **Step 4: I3 — nhật ký là file ẩn và không phình vô hạn**

`scripts/update-runner.mjs` đặt log ở `join(dirname(statusFile), "ccchrome-update.log")`, mà `dirname("~/.ccchrome-update.json")` là `~`, nên file hiện ra là `~/ccchrome-update.log` — file **không ẩn** duy nhất dự án này tạo trong thư mục nhà. Nó cũng mở ở chế độ `"a"` và không bao giờ bị cắt.

```js
// A dotfile, like every other artifact this project creates, and truncated per
// run: the log only ever needs to explain the most recent attempt, which is
// exactly what the status record points at.
const logPath = statusFile ? join(dirname(statusFile), ".ccchrome-update.log") : null;
```

và đổi cờ mở file từ `"a"` sang `"w"`.

- [ ] **Step 5: I4 — nhãn "Đang sao lưu" hiện sai thời điểm**

`server/index.js` gửi `step: "backing-up"` quanh lúc giải nén và dựng lại gói — nhưng bản sao lưu do **runner** tạo, muộn hơn nhiều. Người dùng đọc "Đang sao lưu bản hiện tại…" ở đúng lúc **chưa có** bản sao lưu nào; nếu họ tắt máy lúc đó, họ tin là có đường lui trong khi không có.

Trong `server/index.js` đổi `step: "backing-up"` thành `step: "extracting"`, và trong `extension/sidepanel.js` đổi khoá trong `UPDATE_STEP_TEXT`:

```js
  extracting: "Đang giải nén và kiểm tra gói…",
```

Xoá khoá `"backing-up"` cũ.

- [ ] **Step 6: Chạy toàn bộ và commit**

```bash
npm run lint && HEADED=1 npm test && npm run verify:sidepanel
git add extension/sidepanel.js scripts/uninstall.sh scripts/uninstall.ps1 scripts/update-runner.mjs server/index.js test/verify-sidepanel.mjs
git commit -m "fix(update): four defects found by the whole-branch review

The reload prompt was erased seconds after appearing: the reconnecting socket
asked for status again, the new bridge answered 'no update available', and the
handler hid the one button the user still has to press.

Uninstall left four new artifacts behind, one of them a full copy of the
install — breaking the 'one run, nothing left behind' property.

The update log was ~/ccchrome-update.log: the only non-dotfile this project
creates in \$HOME, appended to forever. Now a dotfile, truncated per run.

'Đang sao lưu bản hiện tại…' was shown around extraction, before any backup
exists — telling the user they had a way back at the exact moment they did not."
```

---

### Task 6: Tài liệu và chạy toàn bộ

**Files:**
- Modify: `CLAUDE.md`, `README.md`

- [ ] **Step 1: Sửa các câu đã thành sai trong `CLAUDE.md`**

Mục "Side panel chat operational notes" hiện có một câu nói tarball mang ba file là đủ *"vì bản cài là thứ bridge sinh ra"* — câu đó dừng đúng một bước trước kết luận. Sửa thành: tarball mang chúng **và** cả hai installer chép chúng vào `$INSTALL_DIR`, vì đó mới là nơi `spawnUpdateRunner` đọc; `test/install.test.mjs` canh điều này bằng cách chạy một lần cài thật.

Thêm một mục mới về cách bàn giao:

```markdown
- The updater must not be a descendant of the service, and each platform kills
  differently — measured 2026-08-16 against the command the installer actually
  runs, not an equivalent. macOS's `launchctl bootout` leaves a detached child
  running (heartbeat 18 → 26), so darwin still spawns directly. Windows'
  `Stop-CcTask` ends in `taskkill /pid <bridge> /T /F`, which kills descendants
  by parent PID, so the runner is registered as a one-shot scheduled task and
  Task Scheduler owns it. Linux's `systemctl --user disable --now` takes the
  whole cgroup — `detached: true` is `setsid()`, which changes session, not
  cgroup — so it goes through `systemd-run --user --collect --unit=…`; a
  `--scope` would stay in the caller's cgroup and die with it. **The Linux
  branch is reasoned, not measured: there is no Linux machine to run it on.**
  `buildRunnerSpawn` takes the platform as an argument, like `buildSpawn` in
  `server/agent.js`, precisely so the branch nobody can run is still tested.
- The release check is cached for 30 minutes (`RELEASE_CACHE_MS` in
  `server/index.js`). The panel asks on every `ready` — which includes every
  reconnect, and the panel reconnects with backoff capped at 30s — against
  GitHub's 60 unauthenticated requests per hour per IP, shared by every panel
  and every machine behind one address. Exceeding it fails closed, so an
  un-cached check goes quiet exactly when a release does exist. A newly
  published release can therefore take up to 30 minutes to appear.
```

- [ ] **Step 2: Sửa `README.md`**

`README.md` nói bridge hỏi GitHub mỗi lần mở khung chat — thêm rằng kết quả được nhớ 30 phút, nên bản mới có thể mất tới nửa tiếng mới hiện. Kiểm lại bảng liệt kê file được cài (`README.md` quanh dòng 125) và thêm ba file mới nếu bảng đó liệt kê từng file.

- [ ] **Step 3: Chạy toàn bộ**

```bash
npm run lint && HEADED=1 npm test
```

Expected: mọi suite `ALL TESTS PASSED`.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: the handover, the cache, and what is still unmeasured

Records why each platform hands the runner over differently, with the measured
evidence for macOS and the explicit note that the Linux branch is reasoned
rather than measured — there is no Linux machine here to run it on.

Corrects the sentence claiming the tarball carrying the three files was enough:
the installers have to put them in \$INSTALL_DIR, which is where the bridge
reads them, and that gap made the button silently dead on every machine.

Documents the 30-minute release cache, which shipped undocumented and made a
README sentence untrue."
```

---

## Ghi chú cho người thực thi

- **Thứ tự:** Task 1 → 2 → 3 tuần tự (2 dùng đầu ra của 1; 3 độc lập nhưng đụng `updater.js`). Task 4 người dùng chạy sau Task 3. Task 5 độc lập, chạy song song được với 4. Task 6 cuối.
- **Chạy `npm test` đầy đủ ở Task 2, không đợi tới cuối.** Kế hoạch trước để suite đỏ suốt sáu task vì chỉ chạy suite hẹp.
- **Nếu Task 4 trả lời `it DIES`, dừng lại và báo.** Cách bàn giao qua Task Scheduler không đủ, và đó là thay đổi thiết kế chứ không phải lỗi code.
- Không sửa logic dịch vụ, token hay đăng ký MCP trong hai installer — chỉ phần dàn dựng và chuyển file.
- Đường cập nhật thật vẫn **không** có test tự động nào chạy qua. Lần kiểm thử thật đầu tiên là cập nhật 1.2.0 → 1.2.1 trên máy thật, sau khi phát hành.
