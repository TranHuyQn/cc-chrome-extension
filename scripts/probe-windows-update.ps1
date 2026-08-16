# Answers the Windows questions the update design depends on. Run on a real
# Windows machine. Writes only under %TEMP% and registers throwaway scheduled
# tasks which remove themselves again. Needs no administrator rights.
#
# ASCII ONLY, deliberately. Windows PowerShell 5.1 reads a .ps1 without a BOM as
# ANSI, so any character above 0x7F becomes mojibake and can terminate a string
# early. The first version of this script died exactly that way.
$ErrorActionPreference = 'Stop'

$probe = Join-Path $env:TEMP ('cc-probe-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $probe | Out-Null
Write-Host "probe dir: $probe"

# --- Q2/Q3/Q4: does a runner launched through Task Scheduler survive -------
# Stop-CcTask, does registration need admin rights, and does the task start
# on battery power? -----------------------------------------------------
#
# The previous version of this probe called Stop-ScheduledTask. The product
# does not: install.ps1 calls Stop-CcTask (scripts/service-task.ps1), which
# ends in `taskkill /pid <bridge> /T /F`. Measuring the wrong command gave a
# true answer to a question nobody asked.
#
# This probe therefore kills ITS OWN process tree, the same way Stop-CcTask
# kills the bridge's. That means this process cannot measure its own "after"
# state in-process - by the time the kill lands, this process is gone and no
# code after that point in THIS script will ever run. The after-check has to
# run from a SECOND, independently scheduled task instead, for the same
# reason the runner itself has to survive: only a process Task Scheduler
# owns directly (not a child of this script) can outlive this script's
# death. Everything is also appended to $result as it is learned, so the
# result FILE is the source of truth, not the console - console output stops
# the instant this process dies.
$beat         = Join-Path $probe 'heartbeat.txt'
$child        = Join-Path $probe 'child.ps1'
$observer     = Join-Path $probe 'observer.ps1'
$taskName     = 'CcProbeRunnerTask'
$observerTask = 'CcProbeObserverTask'
$result       = Join-Path $probe 'q2-result.txt'
New-Item -ItemType File -Path $result -Force | Out-Null
Write-Host "Q2/Q3/Q4 result file (check this even if this window dies): $result"
Add-Content -Path $result -Value "result file: $result"

# --- Q4: power source, answerable regardless of what Q2 finds ---------------
$battery = Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue
if ($battery) {
    $q4 = "Q4 ANSWER: battery present, BatteryStatus=$($battery.BatteryStatus) (1=discharging/on battery, 2=on AC)"
} else {
    $q4 = 'Q4 ANSWER: no battery found on this machine (desktop or VM) - on-battery start not testable here'
}
Write-Host $q4
Add-Content -Path $result -Value $q4

# Paths are baked into the generated scripts rather than passed as arguments:
# argument quoting through Task Scheduler is its own source of failures and
# is not what we are trying to measure.
Set-Content -Path $child -Value ("1..60 | ForEach-Object { Add-Content -Path '$beat' -Value ('beat ' + `$_); Start-Sleep -Seconds 1 }")

# --- Q3 + registration -------------------------------------------------------
# Same cmdlets, same settings, same principal as the win32 branch of
# buildRunnerSpawn() in server/updater.js: New-ScheduledTaskAction,
# New-ScheduledTaskSettingsSet with AllowStartIfOnBatteries /
# DontStopIfGoingOnBatteries / StartWhenAvailable / no ExecutionTimeLimit /
# MultipleInstances IgnoreNew, New-ScheduledTaskPrincipal with
# LogonType Interactive / RunLevel Limited, no -Trigger, Register-ScheduledTask
# then Start-ScheduledTask. The product wraps this in a spawned
# `powershell -Command` launcher that exits right after registering; that
# wrapping does not change whether the CHILD survives a taskkill on the
# bridge, so this probe calls the cmdlets directly instead of re-wrapping
# them. Only the -Execute/-Argument target differs: this probe's own
# child.ps1 instead of node.exe + update-runner.mjs.
#
# -ExecutionPolicy Bypass on every nested hop: the probe itself is launched
# with it, but child.ps1 and observer.ps1 are separate powershell
# invocations that do not inherit it, and a client Windows defaults to
# Restricted - which refuses to run a .ps1 from file, silently as far as the
# heartbeat is concerned.
$childArg = '-NoProfile -ExecutionPolicy Bypass -File "' + $child + '"'
try {
    $a = New-ScheduledTaskAction -Execute 'powershell' -Argument $childArg -WorkingDirectory $probe
    $s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    $p = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $taskName -Action $a -Settings $s -Principal $p -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
    $q3 = 'Q3 ANSWER: registration succeeded'
} catch {
    $q3 = "Q3 ANSWER: registration FAILED: $($_.Exception.Message)"
}
Write-Host $q3
Add-Content -Path $result -Value $q3

if ($q3 -like 'Q3 ANSWER: registration FAILED*') {
    $q2 = 'Q2 ANSWER: skipped, the task never registered - see Q3 above'
    Write-Host $q2
    Add-Content -Path $result -Value $q2
} else {
    Start-Sleep -Seconds 6
    $before = @(Get-Content $beat -ErrorAction SilentlyContinue).Count
    Write-Host "heartbeat lines before the kill: $before"
    Add-Content -Path $result -Value "heartbeat lines before the kill: $before"

    if ($before -eq 0) {
        $q2 = 'Q2 INCONCLUSIVE: the scheduled task never started its child. Report this.'
        Write-Host $q2
        Add-Content -Path $result -Value $q2
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    } else {
        # The observer: a second one-shot task, independent of this process,
        # that does both the kill and the after-check. It has to do both -
        # once it kills $PID, THIS process is gone and cannot write anything
        # further (see the comment at the top of this block).
        $observerBody = @(
            "Start-Sleep -Seconds 2",
            "taskkill /pid $PID /T /F *> `$null",
            "Start-Sleep -Seconds 10",
            "`$after = @(Get-Content '$beat' -ErrorAction SilentlyContinue).Count",
            "Add-Content -Path '$result' -Value ('heartbeat lines after the kill:  ' + `$after)",
            "if (`$after -gt $before) {",
            "    Add-Content -Path '$result' -Value 'Q2 ANSWER: the task-launched runner SURVIVES a taskkill /T on its launcher'",
            "} else {",
            "    Add-Content -Path '$result' -Value 'Q2 ANSWER: it DIES - the handover still does not work on Windows'",
            "}",
            "Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false -ErrorAction SilentlyContinue",
            "Unregister-ScheduledTask -TaskName '$observerTask' -Confirm:`$false -ErrorAction SilentlyContinue"
        )
        Set-Content -Path $observer -Value $observerBody

        try {
            $oa = New-ScheduledTaskAction -Execute 'powershell' -Argument ('-NoProfile -ExecutionPolicy Bypass -File "' + $observer + '"') -WorkingDirectory $probe
            $op = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
            Register-ScheduledTask -TaskName $observerTask -Action $oa -Principal $op -Force | Out-Null
            Start-ScheduledTask -TaskName $observerTask

            Write-Host "observer task started; it will kill this window's process tree (pid $PID) in ~2 seconds, the way Stop-CcTask kills the bridge"
            Add-Content -Path $result -Value "killing pid $PID (this window) via taskkill /T /F in ~2s, as Stop-CcTask does to the bridge"
            Write-Host 'this window is likely to die now. The final Q2 ANSWER lands in the result file in about 15 more seconds.'
            Write-Host 'Open a NEW PowerShell window and run:'
            Write-Host "    Get-Content '$result'"

            # If this window is NOT actually killed (for example, this
            # account cannot taskkill its own process), wait for the
            # observer anyway and surface its answer here too, instead of
            # this window just hanging with no explanation.
            $deadline = (Get-Date).AddSeconds(25)
            $seen = $null
            while ((Get-Date) -lt $deadline) {
                Start-Sleep -Seconds 1
                $seen = Get-Content $result -ErrorAction SilentlyContinue | Where-Object { $_ -like 'Q2 ANSWER*' }
                if ($seen) { break }
            }
            if ($seen) {
                Write-Host "this window survived long enough to see it: $seen"
            } else {
                Write-Host 'this window survived, but the observer has not reported yet - check the result file.'
            }
        } catch {
            $q2 = "Q2 ANSWER: could not register the observer task, so no kill happened: $($_.Exception.Message)"
            Write-Host $q2
            Add-Content -Path $result -Value $q2
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        }
    }
}

Write-Host ("probe files kept for inspection at: " + $probe)

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
