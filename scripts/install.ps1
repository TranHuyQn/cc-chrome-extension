# Claude Code Chrome Bridge — cài đặt trên máy Windows của bạn.
#
# Chạy:
#   irm <url>/install.ps1 -OutFile "$env:TEMP\install.ps1"
#   powershell -ExecutionPolicy Bypass -File "$env:TEMP\install.ps1"
#
# Script này KHÔNG cần quyền admin và chỉ ghi vào thư mục người dùng của bạn.
#
# NOT `irm ... | iex`, and the two reasons are structural rather than
# stylistic. This file begins with a UTF-8 BOM because Windows PowerShell 5.1
# reads a BOM-less file as the ANSI code page, which mangles every Vietnamese
# string here badly enough that the file no longer parses. Piping to iex hands
# that BOM to the parser as a literal character — "The term 'ï»¿#' is not
# recognized". And Invoke-RestMethod decodes a GitHub release asset (served as
# application/octet-stream) as ISO-8859-1, so every accented character would
# arrive corrupted even without the BOM. -OutFile writes the bytes untouched
# and -File reads them the way this file needs; that is also the path CI
# exercises.
#
# Counterpart of scripts/install.sh; the step order is the same, including the
# parts where the order is the whole point: stage and verify the new tree
# BEFORE touching the installed one, stop the service only once a replacement
# is ready, and overwrite tokens.json rather than merging it.
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1's console defaults to the machine's OEM code page, so
# the Vietnamese below renders as mojibake even when the file is read correctly.
# Best effort: some hosts have no console attached and this throws.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$Port = if ($env:CC_CHROME_PORT) { [int]$env:CC_CHROME_PORT } else { 8787 }
$InstallDir = Join-Path $env:USERPROFILE '.cc-chrome-bridge'
$StateFile = Join-Path $env:USERPROFILE '.ccchrome.json'
$CommandDest = Join-Path $env:USERPROFILE '.claude\commands\ccchrome.md'
# CC_CHROME_SOURCE installs from a checkout instead of downloading a release.
# Same variable name as install.sh; the test suite is its only normal user.
$Source = $env:CC_CHROME_SOURCE
$ReleaseUrl = if ($env:CC_CHROME_RELEASE_URL) { $env:CC_CHROME_RELEASE_URL } else {
    'https://github.com/TranHuyQn/cc-chrome-extension/releases/latest/download/cc-chrome-bridge.tar.gz'
}

function Say($m) { Write-Host $m }

# Runs `claude` and never throws, whatever it writes to stderr. Needed because
# of a PowerShell rule that is easy to miss: REDIRECTING a native command's
# stderr (`*> $null`) turns each line into an ErrorRecord, and with
# $ErrorActionPreference = 'Stop' that becomes a terminating error. So the
# entirely normal "No MCP server named 'chrome' in user scope" — what a first
# install always gets from `mcp remove` — killed the script one line before it
# registered the server and printed the ws URL. install.sh handles the same
# case with `|| true`; this is the equivalent. $LASTEXITCODE still reports what
# the CLI actually returned, which is what the caller checks.
function Invoke-CcClaude([string[]]$CcArgs) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    try {
        & claude @CcArgs 2>&1 | Out-Null
    } finally {
        $ErrorActionPreference = $previous
    }
}
function Die($m) { Write-Host "Lỗi: $m" -ForegroundColor Red; exit 1 }

# Owner-only, the Windows way. There is no umask here: a new file inherits its
# parent's ACL, and %USERPROFILE% grants Administrators as well as the user.
# /inheritance:r drops the inherited entries and /grant:r adds this user back —
# that is what `chmod 600` buys on unix.
function Protect-CcPath([string]$Path) {
    # (OI)(CI) are INHERITANCE flags and belong only on a directory. Put them on
    # a file and the ACE becomes inherit-only, granting nothing on the file
    # itself — which locked out the owner: the upgrade run could not rewrite
    # tokens.json ("Access to the path is denied"), uninstall could not delete
    # it, and it even read back as non-existent. CI caught all three.
    $grant = if ((Get-Item $Path -Force).PSIsContainer) {
        "${env:USERNAME}:(OI)(CI)F"
    } else {
        "${env:USERNAME}:F"
    }
    & icacls $Path /inheritance:r /grant:r $grant *> $null
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Die "chưa có 'node'. Cài Node.js 18 trở lên rồi chạy lại."
}
# Parsed from `node -v` ("v20.20.2") rather than by evaluating JS. Windows
# PowerShell 5.1 STRIPS embedded double quotes when it builds a native
# command's argument list, so `node -p 'x.split(".")[0]'` reaches node as
# x.split(.)[0] — a syntax error, empty stdout, [int]$null = 0, and this check
# rejected Node 20 with "cần Node.js 18 trở lên, máy đang có v20.20.2". CI
# caught it. Nothing below may pass a double quote to a native command.
$nodeVersion = (& node -v) -join ''
$nodeMajor = 0
if ($nodeVersion -match '^v(\d+)\.') { $nodeMajor = [int]$Matches[1] }
if ($nodeMajor -lt 18) { Die "cần Node.js 18 trở lên, máy đang có $nodeVersion." }

$upgrade = Test-Path $StateFile
Say "Claude Code Chrome Bridge — $(if ($upgrade) { 'nâng cấp' } else { 'cài đặt' })"
Say ""

# 1. Chuẩn bị mã nguồn mới trong .new và kiểm tra ĐẦY ĐỦ trước khi đụng bản cũ.
#    Staging nằm TRONG $InstallDir để bước hoán đổi ở mục 3 luôn là Move-Item
#    trên cùng ổ đĩa — đổi tên tức thời, không phải copy hàng chục MB.
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
    # The three files the bridge spawns for an in-panel update. Copied at
    # staging time so a missing one stops the script while the service is still
    # running and nothing has been replaced.
    $scriptsDir = Join-Path $Source 'scripts'
    foreach ($f in 'update-runner.mjs', 'install.sh', 'install.ps1') {
        Copy-Item (Join-Path $scriptsDir $f) (Join-Path $stage $f)
    }
} else {
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('cc-' + [guid]::NewGuid())
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    try {
        # -UseBasicParsing for Windows PowerShell 5.1, where the default path
        # goes through Internet Explorer's engine and fails on machines where
        # IE was never opened.
        Invoke-WebRequest -Uri $ReleaseUrl -OutFile (Join-Path $tmp 'release.tar.gz') -UseBasicParsing
    } catch {
        Die "không tải được gói phát hành. Bản cài hiện tại (nếu có) không bị thay đổi."
    }
    # tar.exe ships with Windows 10 1803 and later — no third-party unpacker.
    & tar -xzf (Join-Path $tmp 'release.tar.gz') -C $tmp
    if ($LASTEXITCODE -ne 0) {
        Die "gói phát hành hỏng, không giải nén được. Bản cài hiện tại không bị thay đổi."
    }
    Copy-Item -Recurse (Join-Path $tmp 'server') (Join-Path $stage 'server')
    Copy-Item -Recurse (Join-Path $tmp 'extension') (Join-Path $stage 'extension')
    Copy-Item (Join-Path $tmp 'ccchrome.md') (Join-Path $stage 'ccchrome.md')
    foreach ($f in 'uninstall.ps1', 'service-task.ps1') {
        if (-not (Test-Path (Join-Path $tmp $f))) { Die "gói phát hành thiếu $f." }
        Copy-Item (Join-Path $tmp $f) $stage
    }
    foreach ($f in 'update-runner.mjs', 'install.sh', 'install.ps1') {
        $src = Join-Path $tmp $f
        if (-not (Test-Path $src)) { throw "gói phát hành thiếu $f — không cập nhật được từ trong khung chat." }
        Copy-Item $src (Join-Path $stage $f)
    }
    Remove-Item -Recurse -Force $tmp
}
if (-not (Test-Path (Join-Path $stage 'server\node_modules'))) {
    Die "gói phát hành thiếu node_modules. Bản cài hiện tại không bị thay đổi."
}

# Prefer the freshly staged library — that is the version about to be
# installed, so the running script and the installed task can never disagree.
. (Join-Path $stage 'service-task.ps1')

# 2. Dừng task cũ — an toàn để làm bây giờ, vì mã nguồn thay thế đã sẵn sàng và
#    đã qua kiểm tra ở bước 1.
if ($env:CC_CHROME_SKIP_SERVICE) {
    Say "  (bỏ qua bước dừng dịch vụ — CC_CHROME_SKIP_SERVICE)"
} else {
    Say "→ Dừng dịch vụ đang chạy (nếu có)…"
    # -InstallDir so the running bridge is killed too, not just the task: an
    # upgrade that leaves the old node alive would swap the code underneath it
    # while it keeps serving the previous version on the same port.
    Stop-CcTask -InstallDir $InstallDir
}

# 3. Đưa mã nguồn đã kiểm tra vào vị trí thật.
Say "→ Cài mã nguồn vào $InstallDir"
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir 'logs') | Out-Null
foreach ($d in 'server', 'extension') {
    $dest = Join-Path $InstallDir $d
    if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
    Move-Item (Join-Path $stage $d) $dest
}
foreach ($f in 'ccchrome.md', 'uninstall.ps1', 'service-task.ps1', 'update-runner.mjs', 'install.sh', 'install.ps1') {
    Move-Item -Force (Join-Path $stage $f) (Join-Path $InstallDir $f)
}
Remove-Item -Recurse -Force $stage
Protect-CcPath $InstallDir

# 4. Token — giữ nguyên khi nâng cấp, để khỏi phải dán lại URL vào popup.
$token = $null
if ($upgrade) {
    try {
        $existing = (Get-Content $StateFile -Raw | ConvertFrom-Json).token
        if ($existing -match '^[0-9a-f]{16,}$') {
            $token = $existing
            Say "→ Giữ token cũ"
        }
    } catch {
        # Malformed JSON, missing file, missing key — all "no usable token".
    }
    if (-not $token) {
        Say "→ Token cũ trong $StateFile bị hỏng hoặc thiếu — sinh token mới."
        Say "  Token cũ (nếu còn dùng được) sẽ bị thu hồi — dán lại URL mới vào popup extension."
    }
}
if (-not $token) {
    # .NET's CSPRNG, not `node -e`: see the note on the version check above —
    # PowerShell 5.1 strips the double quotes out of a native command's
    # arguments, so `require("crypto")` reached node as require(crypto) and the
    # token came back EMPTY. That failure is silent and worse than a crash: it
    # would install a bridge whose credential is the empty string.
    $bytes = New-Object byte[] 16
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $token = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    if (-not $upgrade) { Say "→ Sinh token mới" }
}
# Belt and braces: never write a credential that is not hex. The bound is 16,
# not 32, to match the upgrade branch above and install.sh — a token carried
# over from an older install is kept as-is, and rejecting it here would break
# exactly the users who already work.
if ($token -notmatch '^[0-9a-f]{16,}$') {
    Die "token không hợp lệ, không ghi gì cả (sinh token thất bại?)."
}

# -Encoding ASCII, not the PS 5.1 default: Set-Content's default writes UTF-16
# with a BOM on Windows PowerShell, which JSON.parse in the server would choke
# on. ASCII is enough — both files hold hex, digits and ASCII paths.
[pscustomobject]@{ token = $token; port = $Port } | ConvertTo-Json |
    Set-Content -Path $StateFile -Encoding ASCII
Protect-CcPath $StateFile

# tokens.json holds exactly one live token, written wholesale rather than
# merged: server/tokens.js loads this file as the set of credentials that
# authorize full browser control, so merging previous entries in would mean
# nothing ever revokes them. Overwriting is what revocation IS.
$tokensFile = Join-Path $InstallDir 'tokens.json'
[pscustomobject]@{ $token = 'local' } | ConvertTo-Json |
    Set-Content -Path $tokensFile -Encoding ASCII
Protect-CcPath $tokensFile

# 5. Dịch vụ
Say "→ Cài dịch vụ nền"
Write-CcLauncher -InstallDir $InstallDir -Port $Port
if ($env:CC_CHROME_SKIP_SERVICE) {
    Say "  (bỏ qua bước nạp dịch vụ — CC_CHROME_SKIP_SERVICE)"
} else {
    $registered = $false
    try {
        Register-CcTask -InstallDir $InstallDir
        Start-CcTask
        $registered = $true
    } catch {
        # A failed registration must not abort before the MCP registration and
        # the closing instructions below — those are what let the user finish
        # the install by hand.
        Say "→ Cảnh báo: không đăng ký được dịch vụ nền: $($_.Exception.Message)"
        Say "   Bạn có thể tự chạy: node `"$InstallDir\server\index.js`" --http"
    }
    if ($registered) {
        Say "→ Chờ bridge sẵn sàng…"
        $ok = $false
        foreach ($i in 1..40) {
            try {
                Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 2 | Out-Null
                $ok = $true
                break
            } catch {
                Start-Sleep -Milliseconds 500
            }
        }
        if (-not $ok) {
            Say "→ Cảnh báo: bridge không phản hồi sau 20 giây. Xem log: $(Get-CcLogHint $InstallDir)"
        }
    }
}

# 6. Slash command
New-Item -ItemType Directory -Force -Path (Split-Path $CommandDest) | Out-Null
Copy-Item -Force (Join-Path $InstallDir 'ccchrome.md') $CommandDest
Say "→ Đã cài lệnh /ccchrome"

# 7. Đăng ký MCP với Claude Code
if (Get-Command claude -ErrorAction SilentlyContinue) {
    Invoke-CcClaude @('mcp', 'remove', '--scope', 'user', 'chrome') | Out-Null
    Invoke-CcClaude @(
        'mcp', 'add', '--scope', 'user', '--transport', 'http', 'chrome',
        "http://127.0.0.1:$Port/mcp", '--header', "Authorization: Bearer $token"
    ) | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Say "→ Đã đăng ký MCP server 'chrome' với Claude Code"
    } else {
        Say "→ Không đăng ký được MCP server tự động (có thể 'claude' bản cũ chưa hỗ trợ --transport http)."
        Say "   Đăng ký thủ công:"
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
Say "  Badge chuyển 'on' màu xanh là xong. Mở khung chat bằng nút 'Mở khung chat' trong popup."
Say ""
Say "  Gỡ cài đặt:  powershell -ExecutionPolicy Bypass -File `"$InstallDir\uninstall.ps1`""
