# Hỗ trợ Windows — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Người dùng Windows cài được Chrome Bridge bằng một lệnh, bridge chạy nền tự lên khi đăng nhập, và side panel chat hoạt động — ngang với macOS và Linux.

**Architecture:** Giữ nguyên mô hình "dịch vụ nền theo từng người dùng" của 3.5.0, chỉ thay lớp dịch vụ: launchd → systemd --user → **Task Scheduler với trigger At log on**, chạy dưới chính tài khoản người dùng, **không cần quyền admin**. Installer viết bằng PowerShell (`install.ps1`) song song với `install.sh`, dùng chung mọi thứ khác (server, extension, token, đăng ký MCP). Phần lõi Node đã cross-platform sẵn nên không đụng tới; ngoại lệ duy nhất là `AgentSession.spawn()`, hiện không chạy được `claude.cmd`.

**Tech Stack:** PowerShell 5.1 (có sẵn trong mọi Windows 10/11 — không đòi PowerShell 7), Task Scheduler qua cmdlet `ScheduledTasks`, `icacls` cho quyền file, Node.js ≥ 18, GitHub Actions.

**Spec:** Không có file spec riêng. Các quyết định phạm vi được Huy chốt trong phiên 2026-08-13 và chép nguyên vào "Quyết định đã chốt" bên dưới; plan này lập luận từ đó.

## Quyết định đã chốt (thay cho spec)

1. **Cơ chế dịch vụ: Task Scheduler, trigger At log on.** Không dùng Windows Service. Lý do: Windows Service chạy ở session 0, khiến `claude` con của side panel không có profile người dùng và không có thông tin đăng nhập → chat hỏng; ngoài ra cần quyền admin và một nhị phân bên thứ ba (NSSM/winsw) trong gói phát hành.
2. **Side panel chat PHẢI chạy được trên Windows.** Đây là ràng buộc quyết định điểm 1.
3. **WSL nằm ngoài phạm vi.** Không hỗ trợ, và phải nói rõ trong tài liệu thay vì để người dùng tự phát hiện.
4. **Thêm CI GitHub Actions** chạy trên `ubuntu-latest` và `windows-latest`. Repo hiện không có CI nào.
5. **Không phát minh thêm tính năng.** Mục tiêu là ngang bằng ba nền tảng, không phải làm Windows khác đi.

## Global Constraints

- Node.js ≥ 18 (giống `install.sh`; kiểm tra trước khi tải bất cứ thứ gì).
- **Không cần quyền admin** ở bất kỳ bước nào của `install.ps1` / `uninstall.ps1`. Nếu một bước đòi nâng quyền thì bước đó sai thiết kế, phải đổi cách làm chứ không được yêu cầu người dùng "Run as administrator".
- **Không thêm dependency runtime nào** cho `server/` — vẫn đúng 3 gói: `@modelcontextprotocol/sdk`, `ws`, `zod`.
- **Không thêm build step cho `extension/`** — vẫn là JS thuần Chrome nạp trực tiếp.
- Ba chỗ version phải khớp: `extension/manifest.json`, `const VERSION` trong `server/index.js`, `server/package.json`. Task cuối bump lên **3.6.0**.
- Tài liệu người dùng (`README.md`, `.claude/commands/ccchrome.md`, output của installer) bằng **tiếng Việt**. Code, comment, commit message bằng **tiếng Anh**.
- Bridge luôn bind `127.0.0.1`. Không có ngoại lệ nào cho Windows.
- Token file và `tokens.json` phải **chỉ chủ sở hữu đọc được**. Trên Windows không có `chmod`; dùng `icacls /inheritance:r` (Task 3).
- `npm run lint` phải giữ 0 lỗi. File `.ps1` và `.vbs` không thuộc phạm vi eslint.

## File Structure

**Tạo mới:**
- `scripts/service-task.ps1` — hàm dùng chung cho install/uninstall: dựng launcher, đăng ký/xoá/khởi động/dừng/truy vấn scheduled task. Tương ứng `service-unit.sh`.
- `scripts/install.ps1` — installer Windows. Tương ứng `install.sh`.
- `scripts/uninstall.ps1` — gỡ cài đặt. Tương ứng `uninstall.sh`.
- `test/install-windows.test.mjs` — chạy `install.ps1`/`uninstall.ps1` với `$env:USERPROFILE` giả. Trên OS khác thì in SKIP và exit 0.
- `.github/workflows/ci.yml` — lint + các bộ test không cần trình duyệt, trên ubuntu và windows.

**Sửa:**
- `server/agent.js` — `mcpConfig()` ghi ra file tạm thay vì trả JSON inline; thêm nhánh spawn cho win32.
- `scripts/build-release.mjs` — đóng gói `install.ps1` (asset rời) và các `.ps1` (trong tarball).
- `test/agent-session.test.mjs` — assertion cho hai thay đổi ở `agent.js`.
- `README.md`, `CLAUDE.md`, `.claude/commands/ccchrome.md` — mục Windows, và nói rõ WSL không hỗ trợ.
- `extension/manifest.json`, `server/index.js`, `server/package.json` — bump 3.6.0.

**Không đụng tới:** `extension/background.js` (đã cross-platform hoàn toàn), `server/index.js` phần lõi (đã dùng `path.join` + `homedir()`).

---

### Task 1: `AgentSession` spawn được `claude` trên Windows

Node ≥ 18.20 / 20.12 **từ chối** spawn file `.cmd`/`.bat` khi không có `shell: true` (bản vá CVE-2024-27980). Trên Windows `claude` là `claude.cmd`, nên `spawn(this.claudeBin, ...)` hiện ném `ENOENT` ngay lần chat đầu tiên.

Bật `shell: true` thì toàn bộ argv bị nối thành một chuỗi đưa cho `cmd.exe`. Argv hiện chứa `--mcp-config <JSON>` — JSON đầy dấu `"`, mà `"` là ký tự bật/tắt trích dẫn của `cmd`. Nên phải bỏ JSON khỏi argv **trước**, rồi mới bật shell.

Đưa MCP config ra file cũng thu hẹp một đánh đổi đang được ghi trong `CLAUDE.md`: token Bearer hiện nằm trong argv của tiến trình con, đọc được bằng `ps` / Task Manager suốt vòng đời tiến trình đó. File tạm quyền chủ-sở-hữu thì không.

**Files:**
- Modify: `server/agent.js` — `mcpConfig()`, `buildArgs()`, `send()`
- Modify: `test/agent-session.test.mjs`

**Interfaces:**
- Produces: `AgentSession.mcpConfigPath()` → `string` (đường dẫn tuyệt đối file JSON, mode 0600), thay cho `mcpConfig()` trả JSON inline.
- Produces: `buildSpawn(bin, args)` → `{ command: string, args: string[], options: object }` — hàm thuần, export để test trực tiếp trên mọi OS.
- Produces: `winQuote(s)` → `string` — hàm thuần, bọc dấu nháy kép cho `cmd.exe`.

- [ ] **Step 1: Viết test đỏ cho `buildSpawn` trên cả hai nhánh**

Thêm vào cuối `test/agent-session.test.mjs`:

```js
// buildSpawn is a pure function so both platform branches are testable from
// any machine -- the Windows branch would otherwise only ever run on Windows,
// which is exactly how the .cmd problem shipped unnoticed.
import { buildSpawn, winQuote } from "../server/agent.js";

{
  const posix = buildSpawn("claude", ["-p", "--mcp-config", "/tmp/a b.json"], "linux");
  check("posix: spawns the binary directly", posix.command === "claude", posix.command);
  check("posix: passes args untouched", posix.args[2] === "/tmp/a b.json", JSON.stringify(posix.args));
  check("posix: no shell", posix.options.shell !== true, JSON.stringify(posix.options));

  const win = buildSpawn("claude", ["-p", "--mcp-config", "C:\\Users\\Huy Tran\\a.json"], "win32");
  check("win32: uses a shell so PATHEXT finds claude.cmd", win.options.shell === true, JSON.stringify(win.options));
  check("win32: hides the console window", win.options.windowsHide === true, JSON.stringify(win.options));
  check(
    "win32: quotes a path containing a space",
    win.args.includes('"C:\\Users\\Huy Tran\\a.json"'),
    JSON.stringify(win.args),
  );
  check("win32: leaves flags unquoted", win.args.includes("-p"), JSON.stringify(win.args));
  check("winQuote escapes an embedded double quote", winQuote('a"b') === '"a\\"b"', winQuote('a"b'));
}
```

- [ ] **Step 2: Chạy để xác nhận đỏ**

Run: `node test/agent-session.test.mjs`
Expected: FAIL — `SyntaxError: The requested module '../server/agent.js' does not provide an export named 'buildSpawn'`

- [ ] **Step 3: Cài đặt `winQuote` + `buildSpawn` trong `server/agent.js`**

```js
// cmd.exe quoting, kept to the one rule we actually need: wrap in double
// quotes, escape any double quote inside. Arguments here are repo-controlled
// (flags, absolute paths, a UUID-validated session id) -- the chat prompt
// itself never reaches argv, it goes over stdin -- so this does not have to
// survive hostile input, only spaces in %USERPROFILE%.
export function winQuote(s) {
  return /^[A-Za-z0-9_\-.:\\/=]+$/.test(s) ? s : `"${String(s).replace(/"/g, '\\"')}"`;
}

// Node >= 18.20/20.12 refuses to spawn a .cmd without a shell (CVE-2024-27980),
// and on Windows `claude` IS claude.cmd. shell:true is only safe here because
// Task 1 moved the MCP config -- the one argument containing JSON quotes --
// out of argv and into a file.
export function buildSpawn(bin, args, platform = process.platform) {
  if (platform !== "win32") {
    return { command: bin, args, options: { shell: false } };
  }
  return {
    command: bin,
    args: args.map(winQuote),
    options: { shell: true, windowsHide: true },
  };
}
```

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `node test/agent-session.test.mjs`
Expected: PASS, `ALL TESTS PASSED`

- [ ] **Step 5: Viết test đỏ cho `mcpConfigPath()`**

```js
{
  const session = new AgentSession({ mcpUrl: "http://127.0.0.1:8787/mcp", token: "t0kent0ken", cwd: tmpCwd });
  const p = session.mcpConfigPath();
  check("mcp config is a path, not inline JSON", !p.trim().startsWith("{"), p);
  check("mcp config file exists", existsSync(p), p);
  const cfg = JSON.parse(readFileSync(p, "utf8"));
  check("mcp config names the chrome server", !!cfg.mcpServers?.chrome, JSON.stringify(cfg));
  check("mcp config carries the bearer token", cfg.mcpServers.chrome.headers.Authorization === "Bearer t0kent0ken", JSON.stringify(cfg));
  check("the token is not in argv any more", !session.buildArgs().some((a) => a.includes("t0kent0ken")), JSON.stringify(session.buildArgs()));
  if (process.platform !== "win32") {
    check("mcp config file is owner-only (0600)", (statSync(p).mode & 0o777) === 0o600, String(statSync(p).mode & 0o777));
  }
}
```

- [ ] **Step 6: Chạy để xác nhận đỏ**

Run: `node test/agent-session.test.mjs`
Expected: FAIL — `session.mcpConfigPath is not a function`

- [ ] **Step 7: Cài đặt `mcpConfigPath()`**

Thay `mcpConfig()` bằng:

```js
  // Written to a file rather than passed inline. Two reasons, both real:
  // cmd.exe re-parses double quotes when spawning through a shell (which
  // Windows needs, see buildSpawn), and CLAUDE.md documents the inline form
  // leaking the Bearer token into `ps` output for the child's lifetime. A
  // 0600 file in the session's own cwd has neither problem.
  //
  // Written once per session and reused: `claude` reads it at startup on
  // every turn, so it must outlive the first child.
  mcpConfigPath() {
    if (this._mcpConfigPath) return this._mcpConfigPath;
    const file = join(this.cwd, `.mcp-config-${this.sessionId || "panel"}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          chrome: { type: "http", url: this.mcpUrl, headers: { Authorization: `Bearer ${this.token}` } },
        },
      }),
      { mode: 0o600 },
    );
    // mode only applies at creation; an existing file from an earlier run keeps
    // whatever it had, so repair it unconditionally (same reason install.sh
    // chmods on every run). No-op on Windows, where Task 3's icacls on the
    // install dir is what restricts access.
    if (process.platform !== "win32") chmodSync(file, 0o600);
    this._mcpConfigPath = file;
    return file;
  }
```

Trong `buildArgs()` đổi `"--mcp-config", this.mcpConfig(),` thành `"--mcp-config", this.mcpConfigPath(),`.

Trong `send()` đổi lời gọi spawn:

```js
    const { command, args, options } = buildSpawn(this.claudeBin, this.buildArgs());
    const child = spawn(command, args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
      ...options,
    });
```

Thêm `import { writeFileSync, chmodSync } from "node:fs";` và `import { join } from "node:path";` nếu chưa có.

- [ ] **Step 8: Chạy test, xác nhận xanh**

Run: `node test/agent-session.test.mjs && node test/panel-protocol.test.mjs`
Expected: cả hai in `ALL TESTS PASSED`

- [ ] **Step 9: Cập nhật `CLAUDE.md`**

Mục "The panel's MCP Bearer token travels in the spawned `claude` child's argv" giờ **sai**. Thay bằng đoạn nói: token nằm trong file `.mcp-config-<id>.json` mode 0600 trong `PANEL_CWD`, không còn trong argv; đổi này là điều kiện để Windows spawn qua shell được.

- [ ] **Step 10: Commit**

```bash
git add server/agent.js test/agent-session.test.mjs CLAUDE.md
git commit -m "Spawn claude through a shell on Windows, and move the MCP config out of argv"
```

---

### Task 2: `scripts/service-task.ps1` — lớp dịch vụ Windows

Tương ứng `service-unit.sh`: một file dùng chung để install và uninstall không bao giờ bất đồng về tên task và đường dẫn.

Task Scheduler bật `node.exe` sẽ hiện một cửa sổ console đen suốt phiên làm việc. Cách chặn: task gọi `wscript.exe` chạy một file `.vbs` một dòng, file này gọi `bridge.cmd` với cờ ẩn cửa sổ. `bridge.cmd` giữ phần đặt biến môi trường và chuyển hướng log — đúng những thứ Task Scheduler không tự làm được.

**Files:**
- Create: `scripts/service-task.ps1`

**Interfaces:**
- Produces: `Get-CcTaskName` → `"ccchrome-bridge"`
- Produces: `Write-CcLauncher -InstallDir <string> -Port <int>` → ghi `bridge.cmd` + `bridge-launcher.vbs` vào `$InstallDir`
- Produces: `Register-CcTask -InstallDir <string>` → đăng ký scheduled task (ghi đè nếu đã có)
- Produces: `Start-CcTask`, `Stop-CcTask`, `Unregister-CcTask`, `Test-CcTaskLoaded` → `[bool]`
- Produces: `Get-CcLogHint -InstallDir <string>` → `string` (đường dẫn file log)

- [ ] **Step 1: Viết `scripts/service-task.ps1`**

```powershell
# Shared by install.ps1 and uninstall.ps1. Dot-sourced, never run directly:
# both need the same task name and paths, and two copies of that knowledge is
# the surest way to have them disagree. Mirrors scripts/service-unit.sh.

function Get-CcTaskName { 'ccchrome-bridge' }

function Get-CcLogHint {
    param([Parameter(Mandatory)][string]$InstallDir)
    Join-Path $InstallDir 'logs\bridge.err.log'
}

# node.exe is resolved once, now, and baked in as an absolute path: a scheduled
# task does not inherit an interactive shell's PATH. Same tradeoff as the unix
# side -- if that node is later removed, the task fails until the installer is
# re-run.
function Write-CcLauncher {
    param(
        [Parameter(Mandatory)][string]$InstallDir,
        [Parameter(Mandatory)][int]$Port
    )
    $node = (Get-Command node -ErrorAction Stop).Source
    $logs = Join-Path $InstallDir 'logs'
    New-Item -ItemType Directory -Force -Path $logs | Out-Null

    # bridge.cmd holds the environment and the log redirection. Task Scheduler
    # can do neither, and putting them in the .vbs would mean quoting them
    # twice.
    $cmd = @"
@echo off
set CC_CHROME_HOST=127.0.0.1
set CC_CHROME_PORT=$Port
set CC_CHROME_TOKENS_FILE=$InstallDir\tokens.json
"$node" "$InstallDir\server\index.js" --http >> "$logs\bridge.log" 2>> "$logs\bridge.err.log"
"@
    Set-Content -Path (Join-Path $InstallDir 'bridge.cmd') -Value $cmd -Encoding ASCII

    # Run(..., 0, True): 0 hides the window, True makes wscript WAIT for the
    # bridge. Waiting is load-bearing, not incidental -- with False, wscript
    # exits immediately, Task Scheduler considers the task finished while node
    # is still running, and both the "already running" check and restart-on-
    # failure stop working.
    $vbs = @"
CreateObject("WScript.Shell").Run """$InstallDir\bridge.cmd""", 0, True
"@
    Set-Content -Path (Join-Path $InstallDir 'bridge-launcher.vbs') -Value $vbs -Encoding ASCII
}

function Register-CcTask {
    param([Parameter(Mandatory)][string]$InstallDir)
    $vbs = Join-Path $InstallDir 'bridge-launcher.vbs'
    $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`""

    # Two triggers on purpose. At-logon is the equivalent of a LaunchAgent.
    # The repeating one is the equivalent of KeepAlive/Restart=always: paired
    # with MultipleInstances=IgnoreNew it is a no-op while the bridge is up and
    # restarts it within five minutes when it is not.
    $atLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) `
        -RepetitionInterval (New-TimeSpan -Minutes 5)

    # ExecutionTimeLimit 0 = no limit. The default is 3 days, after which Task
    # Scheduler would kill a perfectly healthy bridge.
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -Hidden `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -MultipleInstances IgnoreNew

    # LogonType Interactive, UserId the current user: this is what keeps the
    # task inside the user's own session, which is what lets the side panel
    # spawn `claude` with the user's profile and credentials -- and what makes
    # registration possible without administrator rights.
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

    Register-ScheduledTask -TaskName (Get-CcTaskName) -Action $action `
        -Trigger @($atLogon, $repeat) -Settings $settings -Principal $principal -Force | Out-Null
}

function Test-CcTaskLoaded {
    $null -ne (Get-ScheduledTask -TaskName (Get-CcTaskName) -ErrorAction SilentlyContinue)
}

function Start-CcTask { Start-ScheduledTask -TaskName (Get-CcTaskName) }

function Stop-CcTask {
    if (Test-CcTaskLoaded) {
        Stop-ScheduledTask -TaskName (Get-CcTaskName) -ErrorAction SilentlyContinue
    }
}

function Unregister-CcTask {
    if (Test-CcTaskLoaded) {
        Unregister-ScheduledTask -TaskName (Get-CcTaskName) -Confirm:$false
    }
}
```

- [ ] **Step 2: Kiểm tra cú pháp mà không cần Windows**

Run (trên máy có PowerShell 7, hoặc bỏ qua và để CI làm):
`pwsh -NoProfile -Command "[System.Management.Automation.Language.Parser]::ParseFile('scripts/service-task.ps1', [ref]$null, [ref]$null) | Out-Null; 'SYNTAX OK'"`
Expected: in `SYNTAX OK`

- [ ] **Step 3: Nghiệm thu thủ công trên máy Windows thật — ba câu hỏi chưa trả lời được từ macOS**

Chạy trong PowerShell **không nâng quyền**:

```powershell
. .\scripts\service-task.ps1
Write-CcLauncher -InstallDir "$env:USERPROFILE\.cc-chrome-bridge" -Port 8787
Register-CcTask -InstallDir "$env:USERPROFILE\.cc-chrome-bridge"
Start-CcTask
```

Ghi lại kết quả cho từng câu, vì mỗi câu có phương án dự phòng riêng:

1. **Đăng ký task có cần quyền admin không?** Nếu `Register-ScheduledTask` báo Access Denied → đổi sang `schtasks.exe /create /sc onlogon` (tạo trong thư mục người dùng, không đụng root folder).
2. **Có cửa sổ console nào hiện ra không?** Nếu có → VBScript có thể đã bị tắt trên máy đó; dự phòng: đổi action sang `powershell.exe -WindowStyle Hidden -NoProfile -File launcher.ps1`, chấp nhận có thể nháy cửa sổ một nhịp lúc đăng nhập, và ghi rõ đánh đổi đó vào README.
3. **Task có ở trạng thái Running không?** `(Get-ScheduledTask ccchrome-bridge).State` phải là `Running`, không phải `Ready` — `Ready` nghĩa là wscript đã thoát sớm và cờ `True` ở `Run()` không có tác dụng.

Verify: `curl.exe -s http://127.0.0.1:8787/health` trả `{"ok":true,...}`.

- [ ] **Step 4: Commit**

```bash
git add scripts/service-task.ps1
git commit -m "Add the Windows service layer: a scheduled task run under the user's own logon"
```

---

### Task 3: `scripts/install.ps1`

Bám sát thứ tự của `install.sh`, kể cả những chỗ thứ tự là có lý do: chuẩn bị mã nguồn mới **trước** khi đụng bản cũ, dừng dịch vụ **sau** khi đã có bản thay thế, và ghi đè `tokens.json` chứ không gộp (ghi đè mới là thu hồi token cũ).

**Files:**
- Create: `scripts/install.ps1`

**Interfaces:**
- Consumes: `scripts/service-task.ps1` (Task 2)
- Produces: bố cục `$env:USERPROFILE\.cc-chrome-bridge\` giống hệt bản unix — `server\`, `extension\`, `logs\`, `tokens.json`, `ccchrome.md`, `uninstall.ps1`, `service-task.ps1`, `bridge.cmd`, `bridge-launcher.vbs`
- Produces: `$env:USERPROFILE\.ccchrome.json` — `{ token, port }`
- Produces: biến môi trường `CC_CHROME_SOURCE` (cài từ checkout, dùng cho test) và `CC_CHROME_SKIP_SERVICE` (bỏ qua đăng ký task) — **cùng tên** với bản unix

- [ ] **Step 1: Viết `scripts/install.ps1`**

```powershell
# Claude Code Chrome Bridge — cài đặt trên máy Windows của bạn.
#
# Chạy:  irm https://github.com/TranHuyQn/cc-chrome-extension/releases/latest/download/install.ps1 | iex
#
# Script này KHÔNG cần quyền admin và chỉ ghi vào thư mục người dùng của bạn.
$ErrorActionPreference = 'Stop'

$Port = if ($env:CC_CHROME_PORT) { [int]$env:CC_CHROME_PORT } else { 8787 }
$InstallDir = Join-Path $env:USERPROFILE '.cc-chrome-bridge'
$StateFile = Join-Path $env:USERPROFILE '.ccchrome.json'
$CommandDest = Join-Path $env:USERPROFILE '.claude\commands\ccchrome.md'
$Source = $env:CC_CHROME_SOURCE
$ReleaseUrl = if ($env:CC_CHROME_RELEASE_URL) { $env:CC_CHROME_RELEASE_URL } else {
    'https://github.com/TranHuyQn/cc-chrome-extension/releases/latest/download/cc-chrome-bridge.tar.gz'
}

function Say($m) { Write-Host $m }
function Die($m) { Write-Error "Lỗi: $m"; exit 1 }

# Owner-only, the Windows way. There is no umask: a new file inherits the
# parent's ACL, and %USERPROFILE% is readable by administrators and by any
# process running as this user. /inheritance:r drops inherited entries, then
# the user is granted back explicitly -- this is what `chmod 600` buys on unix.
function Protect-CcFile([string]$Path) {
    & icacls $Path /inheritance:r /grant:r "${env:USERNAME}:(R,W)" | Out-Null
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Die "chưa có 'node'. Cài Node.js 18 trở lên rồi chạy lại."
}
$nodeMajor = [int](& node -p 'process.versions.node.split(".")[0]')
if ($nodeMajor -lt 18) { Die "cần Node.js 18 trở lên, máy đang có $(& node -v)." }

$upgrade = Test-Path $StateFile
Say "Claude Code Chrome Bridge — $(if ($upgrade) { 'nâng cấp' } else { 'cài đặt' })"
Say ""

# 1. Chuẩn bị mã nguồn mới trong .new và kiểm tra ĐẦY ĐỦ trước khi đụng bản cũ.
Say "→ Chuẩn bị mã nguồn mới…"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$stage = Join-Path $InstallDir '.new'
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

if ($Source) {
    Copy-Item -Recurse (Join-Path $Source 'server') (Join-Path $stage 'server')
    Copy-Item -Recurse (Join-Path $Source 'extension') (Join-Path $stage 'extension')
    Copy-Item (Join-Path $Source '.claude\commands\ccchrome.md') (Join-Path $stage 'ccchrome.md')
    Copy-Item (Join-Path $Source 'scripts\uninstall.ps1') $stage
    Copy-Item (Join-Path $Source 'scripts\service-task.ps1') $stage
} else {
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("cc-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    try {
        Invoke-WebRequest -Uri $ReleaseUrl -OutFile (Join-Path $tmp 'release.tar.gz') -UseBasicParsing
    } catch {
        Die "không tải được gói phát hành. Bản cài hiện tại (nếu có) không bị thay đổi."
    }
    # tar.exe ships with Windows 10 1803+ — no third-party unpacker needed.
    & tar -xzf (Join-Path $tmp 'release.tar.gz') -C $tmp
    if ($LASTEXITCODE -ne 0) { Die "gói phát hành hỏng, không giải nén được. Bản cài hiện tại không bị thay đổi." }
    Copy-Item -Recurse (Join-Path $tmp 'server') (Join-Path $stage 'server')
    Copy-Item -Recurse (Join-Path $tmp 'extension') (Join-Path $stage 'extension')
    Copy-Item (Join-Path $tmp 'ccchrome.md') (Join-Path $stage 'ccchrome.md')
    foreach ($f in 'uninstall.ps1', 'service-task.ps1') {
        if (-not (Test-Path (Join-Path $tmp $f))) { Die "gói phát hành thiếu $f." }
        Copy-Item (Join-Path $tmp $f) $stage
    }
}
if (-not (Test-Path (Join-Path $stage 'server\node_modules'))) {
    Die "gói phát hành thiếu node_modules. Bản cài hiện tại không bị thay đổi."
}

. (Join-Path $stage 'service-task.ps1')

# 2. Dừng task cũ — an toàn vì mã nguồn thay thế đã sẵn sàng.
if ($env:CC_CHROME_SKIP_SERVICE) {
    Say "  (bỏ qua bước dừng dịch vụ — CC_CHROME_SKIP_SERVICE)"
} else {
    Say "→ Dừng dịch vụ đang chạy (nếu có)…"
    Stop-CcTask
}

# 3. Đưa mã nguồn đã kiểm tra vào vị trí thật.
Say "→ Cài mã nguồn vào $InstallDir"
foreach ($d in 'server', 'extension') {
    $dest = Join-Path $InstallDir $d
    if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
    Move-Item (Join-Path $stage $d) $dest
}
foreach ($f in 'ccchrome.md', 'uninstall.ps1', 'service-task.ps1') {
    Move-Item -Force (Join-Path $stage $f) (Join-Path $InstallDir $f)
}
Remove-Item -Recurse -Force $stage
Protect-CcFile $InstallDir

# 4. Token — giữ nguyên khi nâng cấp để khỏi phải dán lại URL vào popup.
$token = $null
if ($upgrade) {
    try {
        $existing = (Get-Content $StateFile -Raw | ConvertFrom-Json).token
        if ($existing -match '^[0-9a-f]{16,}$') { $token = $existing; Say "→ Giữ token cũ" }
    } catch { }
    if (-not $token) {
        Say "→ Token cũ trong $StateFile bị hỏng hoặc thiếu — sinh token mới."
        Say "  Token cũ (nếu còn dùng được) sẽ bị thu hồi — dán lại URL mới vào popup extension."
    }
}
if (-not $token) {
    # Generated through node, already a hard requirement above, rather than
    # adding a second way of making randomness.
    $token = & node -e 'process.stdout.write(require("crypto").randomBytes(16).toString("hex"))'
    if (-not $upgrade) { Say "→ Sinh token mới" }
}

@{ token = $token; port = $Port } | ConvertTo-Json | Set-Content -Path $StateFile -Encoding UTF8
Protect-CcFile $StateFile

# tokens.json holds exactly one live token, written wholesale. Merging previous
# entries in would mean nothing ever revokes them.
$tokensFile = Join-Path $InstallDir 'tokens.json'
@{ $token = 'local' } | ConvertTo-Json | Set-Content -Path $tokensFile -Encoding UTF8
Protect-CcFile $tokensFile

# 5. Dịch vụ
Say "→ Cài dịch vụ nền"
Write-CcLauncher -InstallDir $InstallDir -Port $Port
if ($env:CC_CHROME_SKIP_SERVICE) {
    Say "  (bỏ qua bước nạp dịch vụ — CC_CHROME_SKIP_SERVICE)"
} else {
    try {
        Register-CcTask -InstallDir $InstallDir
        Start-CcTask
        Say "→ Chờ bridge sẵn sàng…"
        $ok = $false
        foreach ($i in 1..40) {
            try {
                Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 2 | Out-Null
                $ok = $true; break
            } catch { Start-Sleep -Milliseconds 500 }
        }
        if (-not $ok) { Say "→ Cảnh báo: bridge không phản hồi sau 20 giây. Xem log: $(Get-CcLogHint $InstallDir)" }
    } catch {
        # A failed registration must not abort before the MCP registration and
        # the closing instructions below — those are what let the user finish
        # by hand.
        Say "→ Cảnh báo: không đăng ký được dịch vụ nền: $($_.Exception.Message)"
        Say "   Bạn có thể tự chạy: node `"$InstallDir\server\index.js`" --http"
    }
}

# 6. Slash command
New-Item -ItemType Directory -Force -Path (Split-Path $CommandDest) | Out-Null
Copy-Item -Force (Join-Path $InstallDir 'ccchrome.md') $CommandDest
Say "→ Đã cài lệnh /ccchrome"

# 7. Đăng ký MCP với Claude Code
if (Get-Command claude -ErrorAction SilentlyContinue) {
    & claude mcp remove --scope user chrome 2>$null | Out-Null
    & claude mcp add --scope user --transport http chrome "http://127.0.0.1:$Port/mcp" --header "Authorization: Bearer $token" 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Say "→ Đã đăng ký MCP server 'chrome' với Claude Code"
    } else {
        Say "→ Không đăng ký được MCP server tự động. Đăng ký thủ công:"
        Say "   claude mcp add --scope user --transport http chrome http://127.0.0.1:$Port/mcp --header `"Authorization: Bearer $token`""
    }
} else {
    Say "→ Không thấy lệnh 'claude' — bỏ qua đăng ký MCP. Cài Claude Code rồi chạy lại script này."
}

Say ""
Say "Xong. Còn hai việc bạn phải tự làm trong Chrome:"
Say ""
Say "  1. Mở chrome://extensions → bật Developer mode → Load unpacked"
Say "     → chọn thư mục:  $InstallDir\extension"
Say ""
Say "  2. Bấm icon extension, dán URL này vào ô địa chỉ rồi bấm 'Lưu & kết nối lại':"
Say "     ws://127.0.0.1:$Port/ws?token=$token"
Say ""
Say "  Badge chuyển 'on' màu xanh là xong."
Say ""
Say "  Gỡ cài đặt:  powershell -ExecutionPolicy Bypass -File `"$InstallDir\uninstall.ps1`""
```

- [ ] **Step 2: Chạy thử với `CC_CHROME_SKIP_SERVICE` trên máy Windows**

```powershell
$env:CC_CHROME_SOURCE = (Get-Location).Path
$env:CC_CHROME_SKIP_SERVICE = "1"
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

Expected: in `Xong.` kèm URL `ws://127.0.0.1:8787/ws?token=<32 hex>`; `$env:USERPROFILE\.cc-chrome-bridge\server\index.js` tồn tại.

- [ ] **Step 3: Kiểm tra ACL thật sự chặn**

```powershell
icacls "$env:USERPROFILE\.ccchrome.json"
```

Expected: chỉ có dòng cho chính user hiện tại; **không** có `BUILTIN\Users` hay `NT AUTHORITY\Authenticated Users`.

- [ ] **Step 4: Commit**

```bash
git add scripts/install.ps1
git commit -m "Add install.ps1: the Windows installer, no administrator rights needed"
```

---

### Task 4: `scripts/uninstall.ps1`

Thứ tự đảo ngược của install, và phải kiểm chứng task đã dừng **trước** khi xoá thư mục — xoá mã nguồn dưới chân một tiến trình đang chạy là cách chắc chắn nhất để lại một bridge zombie giữ cổng 8787.

`~/.cc-chrome-bridge\panel` (lịch sử hội thoại của side panel) **được giữ lại**, giống bản unix.

**Files:**
- Create: `scripts/uninstall.ps1`

**Interfaces:**
- Consumes: `scripts/service-task.ps1` (Task 2), bố cục do `install.ps1` tạo (Task 3)

- [ ] **Step 1: Viết `scripts/uninstall.ps1`**

```powershell
# Gỡ Claude Code Chrome Bridge khỏi máy Windows này. Không cần quyền admin.
$ErrorActionPreference = 'Stop'

$InstallDir = Join-Path $env:USERPROFILE '.cc-chrome-bridge'
$StateFile = Join-Path $env:USERPROFILE '.ccchrome.json'
$CommandDest = Join-Path $env:USERPROFILE '.claude\commands\ccchrome.md'
$PanelDir = Join-Path $InstallDir 'panel'

function Say($m) { Write-Host $m }

$svc = Join-Path $InstallDir 'service-task.ps1'
if (Test-Path $svc) { . $svc } else { . (Join-Path $PSScriptRoot 'service-task.ps1') }

Say "Gỡ Claude Code Chrome Bridge"

# 1. Dừng và xoá task TRƯỚC khi xoá file, và xác nhận nó đã dừng thật.
Say "→ Dừng dịch vụ nền…"
Stop-CcTask
Unregister-CcTask
if (Test-CcTaskLoaded) {
    Say "→ Cảnh báo: không xoá được scheduled task '$(Get-CcTaskName)'. Xoá tay trong Task Scheduler rồi chạy lại."
    exit 1
}

# 2. Gỡ đăng ký MCP.
if (Get-Command claude -ErrorAction SilentlyContinue) {
    & claude mcp remove --scope user chrome 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { Say "→ Đã gỡ đăng ký MCP server 'chrome'" }
}

# 3. Lệnh /ccchrome.
if (Test-Path $CommandDest) { Remove-Item -Force $CommandDest; Say "→ Đã xoá lệnh /ccchrome" }

# 4. Token.
if (Test-Path $StateFile) { Remove-Item -Force $StateFile; Say "→ Đã xoá $StateFile" }

# 5. Thư mục cài — giữ lại panel/, đó là lịch sử hội thoại của bạn, không phải
#    file cài đặt.
if (Test-Path $InstallDir) {
    Get-ChildItem $InstallDir -Force | Where-Object { $_.FullName -ne $PanelDir } | Remove-Item -Recurse -Force
    if ((Test-Path $PanelDir) -and (Get-ChildItem $PanelDir -Force)) {
        Say "→ Đã xoá $InstallDir (giữ lại panel\ — lịch sử chat của bạn)"
    } else {
        Remove-Item -Recurse -Force $InstallDir
        Say "→ Đã xoá $InstallDir"
    }
}

Say ""
Say "Xong. Còn một việc trong Chrome: mở chrome://extensions và Remove extension 'Claude Code Chrome Bridge'."
```

- [ ] **Step 2: Chạy thử ngay sau install trên máy Windows**

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.cc-chrome-bridge\uninstall.ps1"
```

Expected: in đủ các dòng `→ Đã xoá`, và:

```powershell
Get-ScheduledTask ccchrome-bridge -ErrorAction SilentlyContinue   # không trả về gì
Test-Path "$env:USERPROFILE\.ccchrome.json"                        # False
curl.exe -s http://127.0.0.1:8787/health                           # không kết nối được
```

- [ ] **Step 3: Chạy lần hai để kiểm tính idempotent**

Run: lệnh y hệt Step 2
Expected: exit 0, không có lỗi đỏ, không báo đã xoá thứ vốn không còn.

- [ ] **Step 4: Commit**

```bash
git add scripts/uninstall.ps1
git commit -m "Add uninstall.ps1, reversing install.ps1 in the correct order"
```

---

### Task 5: Test tự động cho đường Windows

`test/install.test.mjs` chạy `bash` nên không dùng được trên Windows. File mới này là bản song song, và trên OS khác thì in SKIP rồi exit 0 — để `npm test` trên macOS/Linux không đỏ vì một nền tảng nó không chạy được.

**Files:**
- Create: `test/install-windows.test.mjs`
- Modify: `package.json` — thêm `test:installwin`, nối vào chuỗi `test`

**Interfaces:**
- Consumes: `scripts/install.ps1`, `scripts/uninstall.ps1` (Task 3, 4)

- [ ] **Step 1: Viết `test/install-windows.test.mjs`**

```js
// Runs install.ps1 / uninstall.ps1 against a throwaway USERPROFILE. Nothing
// here touches the real machine: USERPROFILE is a temp dir and
// CC_CHROME_SKIP_SERVICE keeps Task Scheduler out of the real logon session.
//
// Skips with exit 0 off Windows: the whole point is the platform the other
// install suite cannot reach, and a hard failure on macOS would just teach
// everyone to ignore it.
//
// Usage: node test/install-windows.test.mjs

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.log("SKIP  install-windows: only runs on Windows (this is " + process.platform + ")");
  console.log("\nALL TESTS PASSED");
  process.exit(0);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
function check(name, cond, detail = "") {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}

const fakeHome = mkdtempSync(join(tmpdir(), "cc-win-home-"));
const installDir = join(fakeHome, ".cc-chrome-bridge");

const env = {
  ...process.env,
  USERPROFILE: fakeHome,
  CC_CHROME_SKIP_SERVICE: "1",
  CC_CHROME_SOURCE: root,
};

const ps = (file) =>
  spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file], {
    env, encoding: "utf8",
  });

const out = ps(join(root, "scripts", "install.ps1"));
check("install.ps1 exits 0", out.status === 0, `${out.stdout}\n${out.stderr}`);
check("installs the server", existsSync(join(installDir, "server", "index.js")));
check("installs the extension", existsSync(join(installDir, "extension", "manifest.json")));
check("ships node_modules", existsSync(join(installDir, "server", "node_modules", "ws")));
check("writes the launcher cmd", existsSync(join(installDir, "bridge.cmd")));
check("writes the vbs shim", existsSync(join(installDir, "bridge-launcher.vbs")));
check("installs uninstall.ps1 next to the tree", existsSync(join(installDir, "uninstall.ps1")));
check("writes a token file", existsSync(join(fakeHome, ".ccchrome.json")));

const state = JSON.parse(readFileSync(join(fakeHome, ".ccchrome.json"), "utf8"));
check("the token is at least 16 hex chars", /^[0-9a-f]{16,}$/.test(state.token || ""), state.token);

const tokens = JSON.parse(readFileSync(join(installDir, "tokens.json"), "utf8"));
check("tokens.json holds exactly the state token", Object.keys(tokens).length === 1 && tokens[state.token] === "local", JSON.stringify(tokens));

const cmdBody = readFileSync(join(installDir, "bridge.cmd"), "utf8");
check("the launcher binds the bridge to loopback", cmdBody.includes("CC_CHROME_HOST=127.0.0.1"), cmdBody);
check("the launcher points at the installed server", cmdBody.includes(join(installDir, "server", "index.js")), cmdBody);
check("the launcher redirects both streams to logs", cmdBody.includes("bridge.log") && cmdBody.includes("bridge.err.log"), cmdBody);
check("prints the ws URL for the popup", /ws:\/\/127\.0\.0\.1:8787\/ws\?token=/.test(out.stdout), out.stdout.slice(-400));

// Upgrade keeps the token, so the user does not have to re-paste the URL.
const second = ps(join(root, "scripts", "install.ps1"));
check("re-running install.ps1 exits 0", second.status === 0, `${second.stdout}\n${second.stderr}`);
check("it takes the upgrade path", /nâng cấp/.test(second.stdout), second.stdout.slice(0, 200));
const state2 = JSON.parse(readFileSync(join(fakeHome, ".ccchrome.json"), "utf8"));
check("the upgrade keeps the same token", state2.token === state.token, `${state.token} -> ${state2.token}`);

const un = ps(join(installDir, "uninstall.ps1"));
check("uninstall.ps1 exits 0", un.status === 0, `${un.stdout}\n${un.stderr}`);
check("uninstall removes the token file", !existsSync(join(fakeHome, ".ccchrome.json")));
check("uninstall removes the install dir", !existsSync(join(installDir, "server")));

const un2 = ps(join(root, "scripts", "uninstall.ps1"));
check("uninstall.ps1 is idempotent", un2.status === 0, `${un2.stdout}\n${un2.stderr}`);

rmSync(fakeHome, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Thêm vào `package.json`**

Thêm `"test:installwin": "node test/install-windows.test.mjs",` và chèn `node test/install-windows.test.mjs && ` vào chuỗi `"test"`, ngay sau `test/install.test.mjs`.

- [ ] **Step 3: Chạy trên macOS để xác nhận nhánh SKIP**

Run: `node test/install-windows.test.mjs`
Expected: in `SKIP  install-windows: only runs on Windows (this is darwin)` rồi `ALL TESTS PASSED`, exit 0.

- [ ] **Step 4: Chạy trên Windows**

Run: `node test/install-windows.test.mjs`
Expected: `ALL TESTS PASSED`, không có FAIL nào.

- [ ] **Step 5: Commit**

```bash
git add test/install-windows.test.mjs package.json
git commit -m "Cover install.ps1 and uninstall.ps1, skipping cleanly off Windows"
```

---

### Task 6: CI GitHub Actions

Repo hiện **không có CI nào**, nên mọi lỗi nền tảng đều phải đợi ai đó chạy tay trên đúng OS. CI không thay được nghiệm thu thật (nó không có Chrome thật, không có phiên đăng nhập thật), nhưng nó bắt được cả hai lỗi Linux vừa sửa hôm nay.

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `package.json` scripts (Task 5)

- [ ] **Step 1: Xác định chính xác bộ test nào chạy được không cần trình duyệt**

Run: `for f in test/*.mjs; do grep -q playwright "$f" || echo "$f"; done`
Expected: `agent-session`, `install`, `panel-auth`, `panel-protocol`, `ratelimit`, `reconnect-grace`, `session-ttl`, cộng ba file `fake-claude*.mjs` (không phải bộ test, là fixture).

Lưu ý cho người thực thi: **không** đưa `build.test.mjs` vào CI — nó chạy `npm run build`, cần `key.pem` vốn bị gitignore.

- [ ] **Step 2: Viết `.github/workflows/ci.yml`**

```yaml
name: ci

on:
  push:
  pull_request:

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install
      - run: npm run lint

  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install
      - run: npm install
        working-directory: server

      # Browser-free suites only. The playwright ones need a real Chromium
      # with the extension loaded; on macOS they additionally need HEADED=1
      # and a visible window, so they stay a manual step (see CLAUDE.md).
      - run: node test/agent-session.test.mjs
      - run: node test/ratelimit.test.mjs
      - run: node test/session-ttl.test.mjs
      - run: node test/reconnect-grace.test.mjs
      - run: node test/panel-auth.test.mjs
      - run: node test/panel-protocol.test.mjs

      # install.test.mjs drives bash + the unix service layer; the .ps1 suite
      # is its Windows counterpart and skips cleanly on ubuntu.
      - run: node test/install.test.mjs
        if: runner.os == 'Linux'
      - run: node test/install-windows.test.mjs
        if: runner.os == 'Windows'
```

- [ ] **Step 3: Đẩy lên và đọc kết quả thật**

Run: `git push` rồi mở tab Actions của repo.
Expected: cả `lint`, `test (ubuntu-latest)` và `test (windows-latest)` đều xanh.

Nếu `panel-protocol` đỏ vì cổng: nó bind cứng cổng 8793 (ghi trong `CLAUDE.md`). Trên runner sạch thì không sao; nếu đỏ, đó là bug thật của bộ test chứ không phải của CI — sửa bộ test để lấy cổng động, đừng bỏ nó khỏi CI.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "Add CI: lint plus the browser-free suites on ubuntu and windows"
```

---

### Task 7: Đóng gói phát hành, tài liệu, và bump 3.6.0

**Files:**
- Modify: `scripts/build-release.mjs`
- Modify: `README.md`, `CLAUDE.md`, `.claude/commands/ccchrome.md`
- Modify: `extension/manifest.json`, `server/index.js`, `server/package.json`, `server/package-lock.json`
- Modify: `test/build.test.mjs`

**Interfaces:**
- Consumes: mọi file của Task 2–6
- Produces: `dist/install.ps1` (asset rời, song song `dist/install.sh`) và các `.ps1` nằm trong `cc-chrome-bridge.tar.gz`

- [ ] **Step 1: Viết assertion đỏ trong `test/build.test.mjs`**

```js
check("release ships install.ps1 as a standalone asset", existsSync(join(dist, "install.ps1")));
check(
  "dist/install.ps1 is byte-identical to scripts/install.ps1",
  readFileSync(join(dist, "install.ps1"), "utf8") === readFileSync(join(root, "scripts", "install.ps1"), "utf8"),
);
for (const f of ["uninstall.ps1", "service-task.ps1"]) {
  check(`tarball contains ${f}`, members.includes(`./${f}`), f);
}
```

- [ ] **Step 2: Chạy để xác nhận đỏ**

Run: `node test/build.test.mjs`
Expected: FAIL ở cả bốn assertion mới.

- [ ] **Step 3: Sửa `scripts/build-release.mjs`**

Dòng 43, thêm ba file `.ps1` vào danh sách copy vào tarball:

```js
for (const f of [
  "install.sh", "uninstall.sh", "service-unit.sh",
  "install.ps1", "uninstall.ps1", "service-task.ps1",
]) {
  copyFileSync(join(root, "scripts", f), join(stage, f));
}
```

Dòng 68, thêm bản sao rời cho Windows ngay cạnh bản `.sh` — cùng lý do đã ghi ở comment phía trên nó: lệnh cài một dòng tải chính file này **trước khi** có tarball, nên thiếu asset rời là `irm` trả 404 và người dùng không thấy gì xảy ra:

```js
copyFileSync(join(root, "scripts", "install.sh"), join(dist, "install.sh"));
console.log("wrote dist/install.sh");
copyFileSync(join(root, "scripts", "install.ps1"), join(dist, "install.ps1"));
console.log("wrote dist/install.ps1");
```

Cập nhật luôn mục "Publishing a GitHub Release" trong `CLAUDE.md`: giờ là **ba** asset phải upload tay (`cc-chrome-bridge.tar.gz`, `install.sh`, `install.ps1`), không phải hai.

- [ ] **Step 4: Chạy lại, xác nhận xanh**

Run: `node test/build.test.mjs`
Expected: `ALL TESTS PASSED`

- [ ] **Step 5: Bump version lên 3.6.0 ở đúng ba chỗ + lockfile**

`extension/manifest.json`, `const VERSION` trong `server/index.js`, `server/package.json`, rồi `cd server && npm install --package-lock-only`.

Run: `node test/build.test.mjs`
Expected: PASS — bộ test này đỏ nếu ba chỗ lệch nhau.

- [ ] **Step 6: Tài liệu**

`README.md`:
- Mục cài đặt: thêm lệnh Windows `irm https://…/install.ps1 | iex` cạnh lệnh `curl … | bash`.
- Nói rõ: dịch vụ nền trên Windows là **scheduled task chạy khi bạn đăng nhập**, nên bridge chỉ lên sau khi đăng nhập — khác LaunchAgent/systemd ở chỗ nào thì ghi ra.
- **WSL không được hỗ trợ**, và lý do: Chrome chạy ở Windows host còn bridge trong WSL là hai bên hàng rào mạng.
- Nếu Step 3 của Task 2 phải dùng phương án dự phòng PowerShell thay cho VBScript: ghi rõ là có thể nháy cửa sổ console một nhịp lúc đăng nhập.

`CLAUDE.md`: thêm Windows vào mục "Setup and commands" (ba lớp dịch vụ, ba installer), và ghi rằng `test/install-windows.test.mjs` skip ngoài Windows nên **xanh trên máy bạn không có nghĩa là nó đã chạy**.

`.claude/commands/ccchrome.md`: phần chẩn đoán hiện chỉ nói `launchctl`/`systemctl`; thêm nhánh Windows (`Get-ScheduledTask ccchrome-bridge`, đường dẫn log).

- [ ] **Step 7: Chạy toàn bộ + lint**

Run: `HEADED=1 npm test && npm run lint`
Expected: exit 0 cả hai, không FAIL nào.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Release 3.6.0: Windows support"
```

---

## Nghiệm thu thủ công — việc của Huy, không tự động hoá được

Chạy trên **máy Windows thật**, theo thứ tự, dừng lại ngay khi có bước đỏ:

1. Cài bằng lệnh một dòng từ GitHub Release thật (không phải từ checkout).
2. `Get-ScheduledTask ccchrome-bridge` → `State` là **Running**, không phải `Ready`.
3. **Không có cửa sổ console đen nào** hiện ra, cả lúc cài lẫn lúc đăng nhập lại.
4. Load unpacked extension, dán URL, badge chuyển **on** xanh.
5. `/health` báo `extensionsConnected: 1`.
6. Trong Claude Code: gọi `list_tabs`, `navigate`, `take_screenshot` → chạy được.
7. **Side panel chat**: mở khung chat, gửi một câu, nhận được trả lời — đây là thứ quyết định toàn bộ lựa chọn kiến trúc ở đầu plan này.
8. **Khởi động lại máy**, đăng nhập → `/health` trả lời mà không phải làm gì.
9. Gỡ cài đặt, xác nhận task biến mất và `panel\` còn nguyên.

Trên **máy Linux thật**, lặp lại từ bước 1 với `install.sh`, cộng thêm: `systemctl --user status ccchrome-bridge` sống, và log nằm đúng chỗ `install.sh` đã in ra (file hay `journalctl`, tuỳ phiên bản systemd của máy đó).
