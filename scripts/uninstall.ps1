# Gỡ Claude Code Chrome Bridge khỏi máy Windows này. Không cần quyền admin.
#
# Counterpart of scripts/uninstall.sh. The order is install.ps1's in reverse,
# and the first step is confirmed rather than assumed: deleting the tree out
# from under a running bridge is the surest way to leave a zombie holding port
# 8787 with the old token still valid.
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1's console defaults to the machine's OEM code page, so
# the Vietnamese below renders as mojibake even when the file is read correctly.
# Best effort: some hosts have no console attached and this throws.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$InstallDir = Join-Path $env:USERPROFILE '.cc-chrome-bridge'
$StateFile = Join-Path $env:USERPROFILE '.ccchrome.json'
$CommandDest = Join-Path $env:USERPROFILE '.claude\commands\ccchrome.md'
$PanelDir = Join-Path $InstallDir 'panel'

function Say($m) { Write-Host $m }

# Runs `claude` and never throws. Redirecting a native command's stderr turns
# each line into an ErrorRecord, and with $ErrorActionPreference = 'Stop' that
# is terminating — so "No MCP server named 'chrome' in user scope", which is
# the NORMAL answer when there is nothing left to remove, would abort the
# uninstall before it deleted anything. See the same helper in install.ps1.
function Invoke-CcClaude([string[]]$CcArgs) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    try {
        & claude @CcArgs 2>&1 | Out-Null
    } finally {
        $ErrorActionPreference = $previous
    }
}

# Prefer the installed copy of the library, the same one that created the task
# being removed; fall back to the sibling file when run straight out of a
# checkout.
$svc = Join-Path $InstallDir 'service-task.ps1'
if (-not (Test-Path $svc)) { $svc = Join-Path $PSScriptRoot 'service-task.ps1' }
if (-not (Test-Path $svc)) {
    Say "Lỗi: thiếu service-task.ps1, không biết tên scheduled task để gỡ."
    exit 1
}
. $svc

Say "Gỡ Claude Code Chrome Bridge"

# 1. Dừng và xoá scheduled task TRƯỚC khi xoá file, rồi xác nhận nó đã biến mất
#    thật. Stop/Unregister đều nuốt lỗi, nên exit code của chúng không nói lên
#    được điều gì — phải hỏi lại hệ thống.
Say "→ Dừng dịch vụ nền…"
# Unregister first, then kill. Stop-CcTask disables the task before killing for
# the same reason, but removing it outright is stronger and this is the one
# place where nothing needs the task afterwards.
Unregister-CcTask
Stop-CcTask -InstallDir $InstallDir
if (Test-CcTaskLoaded) {
    Say "→ Cảnh báo: không xoá được scheduled task '$(Get-CcTaskName)'."
    Say "   Xoá tay trong Task Scheduler rồi chạy lại script này. Chưa xoá file nào cả."
    exit 1
}
# The task being gone is NOT the same as the bridge being gone: the task runs
# wscript, and node.exe is its grandchild. Checking only the task let a live
# server survive the uninstall, still holding port 8787 and an open handle on
# logs\bridge.err.log — the delete below then failed on that one file, halfway
# through. Verify the process too, and stop before touching anything if it is
# somehow still there.
$alive = @(Get-CcBridgeProcess -InstallDir $InstallDir)
if ($alive.Count -gt 0) {
    Say "→ Cảnh báo: bridge vẫn đang chạy (PID $($alive.ProcessId -join ', ')) dù scheduled task đã bị xoá."
    Say "   Đóng nó rồi chạy lại script này. Chưa xoá file nào cả:"
    Say "   Get-CimInstance Win32_Process -Filter `"Name='node.exe'`" | Where-Object { `$_.CommandLine -like '*cc-chrome-bridge*' } | ForEach-Object { taskkill /pid `$_.ProcessId /T /F }"
    exit 1
}

# 2. Gỡ đăng ký MCP khỏi Claude Code.
if (Get-Command claude -ErrorAction SilentlyContinue) {
    Invoke-CcClaude @('mcp', 'remove', '--scope', 'user', 'chrome') | Out-Null
    if ($LASTEXITCODE -eq 0) { Say "→ Đã gỡ đăng ký MCP server 'chrome'" }
}

# 3. Lệnh /ccchrome.
if (Test-Path $CommandDest) {
    Remove-Item -Force $CommandDest
    Say "→ Đã xoá lệnh /ccchrome"
}

# 4. Token.
if (Test-Path $StateFile) {
    Remove-Item -Force $StateFile
    Say "→ Đã xoá $StateFile"
}

# 5. Thư mục cài. panel\ được giữ lại: đó là lịch sử hội thoại của side panel,
#    dữ liệu của người dùng, không phải file cài đặt. Cùng quy tắc với
#    uninstall.sh.
if (Test-Path $InstallDir) {
    $keptPanel = (Test-Path $PanelDir) -and ((Get-ChildItem $PanelDir -Force | Measure-Object).Count -gt 0)
    Get-ChildItem $InstallDir -Force |
        Where-Object { $_.FullName -ne $PanelDir } |
        Remove-Item -Recurse -Force
    if ($keptPanel) {
        Say "→ Đã xoá $InstallDir (giữ lại panel\ — lịch sử chat của bạn)"
    } else {
        Remove-Item -Recurse -Force $InstallDir
        Say "→ Đã xoá $InstallDir"
    }
}

Say ""
Say "Xong. Còn một việc trong Chrome: mở chrome://extensions và Remove extension"
Say "'Claude Code Chrome Bridge'."
