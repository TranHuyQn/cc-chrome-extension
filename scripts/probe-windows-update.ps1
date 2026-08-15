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
$started  = Join-Path $probe 'parent-started.txt'
$child    = Join-Path $probe 'child.ps1'
$parent   = Join-Path $probe 'parent.ps1'
$taskName = 'CcProbeDetachedChild'

# Paths are baked into the generated scripts rather than passed as arguments:
# argument quoting through Task Scheduler is its own source of failures and is
# not what we are trying to measure.
#
# -ExecutionPolicy Bypass on BOTH hops. The probe itself is launched with it,
# but the scheduled task and the Start-Process inside it are separate powershell
# invocations that do not inherit it, and a client Windows defaults to
# Restricted - which refuses to run a .ps1 from file, silently as far as the
# heartbeat is concerned.
Set-Content -Path $child -Value ("1..30 | ForEach-Object { Add-Content -Path '$beat' -Value ('beat ' + `$_); Start-Sleep -Seconds 1 }")

$parentBody = @()
$parentBody += "Set-Content -Path '$started' -Value 'parent running'"
$parentBody += "Start-Process -FilePath 'powershell' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File','$child' | Out-Null"
$parentBody += "Start-Sleep -Seconds 300"
Set-Content -Path $parent -Value $parentBody

$action    = New-ScheduledTaskAction -Execute 'powershell' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $parent + '"')
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Force | Out-Null

Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 8

# Diagnostics first, so an inconclusive run still says WHERE it stopped.
$info = Get-ScheduledTaskInfo -TaskName $taskName
Write-Host ("task LastRunTime : " + $info.LastRunTime)
Write-Host ("task LastTaskResult : " + $info.LastTaskResult)
Write-Host ("task state : " + (Get-ScheduledTask -TaskName $taskName).State)
Write-Host ("parent started marker exists : " + (Test-Path $started))
Write-Host ("child script exists : " + (Test-Path $child))

$before = @(Get-Content $beat -ErrorAction SilentlyContinue).Count
Write-Host "heartbeat lines before stopping the task: $before"

if ($before -eq 0) {
    if (-not (Test-Path $started)) {
        Write-Host 'Q2 INCONCLUSIVE: the scheduled task never ran its action. Check LastTaskResult above.'
    } else {
        Write-Host 'Q2 INCONCLUSIVE: the task ran but the detached child never wrote a heartbeat.'
    }
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

Write-Host ("probe files kept for inspection at: " + $probe)
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false

# --- Q1: does install.ps1 accept a reshaped CC_CHROME_SOURCE? ----------------
# Build the same checkout layout the updater will build, from the installed copy
# (the same file set a release tarball carries).
$src       = Join-Path $probe 'source'
$installed = Join-Path $env:USERPROFILE '.cc-chrome-bridge'
if (-not (Test-Path $installed)) {
    Write-Host ''
    Write-Host "Q1: no install found at $installed"
    Write-Host 'Q1 ALTERNATIVE: a checkout IS already the layout CC_CHROME_SOURCE expects,'
    Write-Host 'so Q1 can be answered from the repo directly. From the checkout root run:'
    Write-Host '    cd server; npm.cmd install; cd ..'
    Write-Host '    $env:CC_CHROME_SOURCE = (Get-Location).Path'
    Write-Host '    powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1'
    Write-Host 'That INSTALLS the bridge on this machine. Report the full output either way.'
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
