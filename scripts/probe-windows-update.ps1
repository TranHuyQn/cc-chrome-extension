# Answers the two Windows questions the update design depends on. Run on a real
# Windows machine. Writes only under %TEMP% and registers one throwaway
# scheduled task which it removes again. Needs no administrator rights.
#
# ASCII ONLY, deliberately. Windows PowerShell 5.1 reads a .ps1 without a BOM as
# ANSI, so any character above 0x7F becomes mojibake and can terminate a string
# early. The first version of this script died exactly that way.
$ErrorActionPreference = 'Stop'

$probe = Join-Path $env:TEMP ('cc-probe-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $probe | Out-Null
Write-Host "probe dir: $probe"

# --- Q2: does a detached child survive the scheduled task being stopped? -----
# Production shape: the bridge runs as a Task Scheduler task, spawns the updater
# detached, and the installer then stops that task. What matters is whether
# stopping the task takes the detached child with it.
$beat     = Join-Path $probe 'heartbeat.txt'
$child    = Join-Path $probe 'child.ps1'
$parent   = Join-Path $probe 'parent.ps1'
$taskName = 'CcProbeDetachedChild'

# Paths are baked into the generated scripts rather than passed as arguments:
# argument quoting through Task Scheduler is its own source of parse failures,
# and it is not what we are trying to measure.
Set-Content -Path $child -Value ("1..30 | ForEach-Object { Add-Content -Path '$beat' -Value ('beat ' + `$_); Start-Sleep -Seconds 1 }")
Set-Content -Path $parent -Value ("Start-Process -FilePath 'powershell' -ArgumentList '-NoProfile','-WindowStyle','Hidden','-File','$child' | Out-Null; Start-Sleep -Seconds 300")

$action    = New-ScheduledTaskAction -Execute 'powershell' -Argument ('-NoProfile -WindowStyle Hidden -File "' + $parent + '"')
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Force | Out-Null

Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 6
$before = @(Get-Content $beat -ErrorAction SilentlyContinue).Count
Write-Host "heartbeat lines before stopping the task: $before"
if ($before -eq 0) {
    Write-Host 'Q2 INCONCLUSIVE: the child never started, so nothing was measured. Report this.'
} else {
    Stop-ScheduledTask -TaskName $taskName
    Start-Sleep -Seconds 8
    $after = @(Get-Content $beat -ErrorAction SilentlyContinue).Count
    Write-Host "heartbeat lines after stopping the task: $after"
    if ($after -gt $before) {
        Write-Host 'Q2 ANSWER: detached child SURVIVES the task being stopped'
    } else {
        Write-Host 'Q2 ANSWER: detached child DIES with the task - design change needed'
    }
}
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false

# --- Q1: does install.ps1 accept a reshaped CC_CHROME_SOURCE? ----------------
# Build the same checkout layout the updater will build, from the installed copy
# (the same file set a release tarball carries).
$src       = Join-Path $probe 'source'
$installed = Join-Path $env:USERPROFILE '.cc-chrome-bridge'
if (-not (Test-Path $installed)) {
    Write-Host "Q1 SKIPPED: no install found at $installed"
} else {
    New-Item -ItemType Directory -Path (Join-Path $src 'scripts') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $src '.claude\commands') -Force | Out-Null
    Copy-Item -Recurse (Join-Path $installed 'server')    (Join-Path $src 'server')
    Copy-Item -Recurse (Join-Path $installed 'extension') (Join-Path $src 'extension')
    Copy-Item (Join-Path $installed 'ccchrome.md')      (Join-Path $src '.claude\commands\ccchrome.md')
    Copy-Item (Join-Path $installed 'uninstall.ps1')    (Join-Path $src 'scripts\uninstall.ps1')
    Copy-Item (Join-Path $installed 'service-task.ps1') (Join-Path $src 'scripts\service-task.ps1')
    Write-Host ''
    Write-Host 'Q1 reshaped source built at:'
    Write-Host "    $src"
    Write-Host 'Q1 NEXT: from the repo checkout, run these two lines and report all output:'
    Write-Host ('    $env:CC_CHROME_SOURCE = ' + "'$src'")
    Write-Host '    .\scripts\install.ps1'
}
