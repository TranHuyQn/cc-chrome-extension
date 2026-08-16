# Answers the Windows questions the update design depends on. Run on a real
# Windows machine. Writes only under %TEMP% and registers throwaway scheduled
# tasks which remove themselves again (and cannot fire on their own even if
# left behind - see the Q2/Q3 section). Needs no administrator rights.
#
# ASCII ONLY, deliberately. Windows PowerShell 5.1 reads a .ps1 without a BOM as
# ANSI, so any character above 0x7F becomes mojibake and can terminate a string
# early. The first version of this script died exactly that way.
$ErrorActionPreference = 'Stop'

$probe = Join-Path $env:TEMP ('cc-probe-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $probe | Out-Null
Write-Host "probe dir: $probe"

# The Q2/Q3/Q4 block below ends by killing this process's own tree, so
# everything reportable is appended to this file as it is learned, and the
# file's path is printed now, before anything else runs - console output
# stops the instant that kill lands, but the file does not.
$result = Join-Path $probe 'result.txt'
New-Item -ItemType File -Path $result -Force | Out-Null
Write-Host "result file (check this even if a window dies): $result"
Add-Content -Path $result -Value "result file: $result" -Encoding ASCII

# Doubles an embedded single quote so a value survives being written as TEXT
# into a single-quoted string inside a GENERATED script (child.ps1,
# observer.ps1). Mirrors psQuote() in server/updater.js - a %TEMP% or
# %USERPROFILE% path containing "'" (an apostrophe in the account name)
# would otherwise end the string early and corrupt the generated script.
function PsQuote($value) {
    return [string]$value -replace "'", "''"
}

# Get-Content on the heartbeat file competes with the child's per-second
# Add-Content; a momentary sharing violation returns nothing, which would
# otherwise read as a false 0. Retried here for the same reason the
# GENERATED observer script retries its own reads of the same file (see
# Read-BeatCount inside $observerBody below - duplicated, not shared,
# because that one runs in a separate process this script cannot call into).
function Read-HeartbeatCount($path) {
    for ($i = 0; $i -lt 3; $i++) {
        $n = @(Get-Content $path -ErrorAction SilentlyContinue).Count
        if ($n -gt 0) { return $n }
        Start-Sleep -Milliseconds 300
    }
    return $n
}

# --- Q1: does install.ps1 accept a reshaped CC_CHROME_SOURCE, and does this --
# install even have what self-update needs? ----------------------------------
# Deliberately placed BEFORE the Q2/Q3/Q4 block: that block ends by killing
# this process's own tree, so anything placed after it only runs on the run
# that should NOT be trusted (the kill failing). Q1 has nothing to do with
# that kill, so it runs first and always completes.
Add-Content -Path $result -Value '' -Encoding ASCII
Add-Content -Path $result -Value '--- Q1 ---' -Encoding ASCII
$src       = Join-Path $probe 'source'
$installed = Join-Path $env:USERPROFILE '.cc-chrome-bridge'
if (-not (Test-Path $installed)) {
    $msg = "Q1: no install found at $installed"
    Write-Host ''
    Write-Host $msg
    Add-Content -Path $result -Value $msg -Encoding ASCII
    Write-Host 'Q1 ALTERNATIVE: a checkout IS already the layout CC_CHROME_SOURCE expects,'
    Write-Host 'so Q1 can be answered from the repo directly. From the checkout root run:'
    Write-Host '    cd server; npm.cmd install; cd ..'
    Write-Host '    $env:CC_CHROME_SOURCE = (Get-Location).Path'
    Write-Host '    powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1'
    Write-Host 'That INSTALLS the bridge on this machine. Report the full output either way.'
    Add-Content -Path $result -Value 'Q1 ALTERNATIVE: no install found; see console output for the from-checkout instructions.' -Encoding ASCII
} else {
    # H6: the whole point of Q1 in this plan is whether THIS install can
    # self-update at all. Report what it actually has, by name, before
    # trying to use any of it - server/index.js's spawnUpdateRunner() reads
    # join(INSTALL_DIR, "update-runner.mjs") and join(INSTALL_DIR,
    # "install.ps1") directly, both at the TOP LEVEL of the installed copy.
    $selfUpdateFiles = @('update-runner.mjs', 'install.sh', 'install.ps1')
    foreach ($f in $selfUpdateFiles) {
        $present = Test-Path (Join-Path $installed $f)
        $line = "Q1: $f present in install dir = $present"
        Write-Host $line
        Add-Content -Path $result -Value $line -Encoding ASCII
    }

    New-Item -ItemType Directory -Path (Join-Path $src 'scripts') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $src '.claude\commands') -Force | Out-Null

    # H5: those same three files live at the top level of the INSTALLED copy,
    # but install.ps1's own CC_CHROME_SOURCE branch reads them from scripts\
    # (a checkout layout - see scripts/install.ps1 around its
    # `$scriptsDir = Join-Path $Source 'scripts'` line). So the reshaped tree
    # needs them copied from the installed top level INTO scripts\, exactly
    # like uninstall.ps1 and service-task.ps1 already are below.
    #
    # H6: every copy is guarded. Under $ErrorActionPreference = 'Stop' a
    # single missing file in an older install would otherwise abort the
    # whole probe with a red error instead of reporting the finding - which
    # IS the finding this question exists to surface.
    $copies = @(
        @{ Kind = 'dir';  From = 'server';            To = 'server' },
        @{ Kind = 'dir';  From = 'extension';         To = 'extension' },
        @{ Kind = 'file'; From = 'ccchrome.md';       To = '.claude\commands\ccchrome.md' },
        @{ Kind = 'file'; From = 'uninstall.ps1';     To = 'scripts\uninstall.ps1' },
        @{ Kind = 'file'; From = 'service-task.ps1';  To = 'scripts\service-task.ps1' },
        @{ Kind = 'file'; From = 'update-runner.mjs'; To = 'scripts\update-runner.mjs' },
        @{ Kind = 'file'; From = 'install.sh';        To = 'scripts\install.sh' },
        @{ Kind = 'file'; From = 'install.ps1';       To = 'scripts\install.ps1' }
    )
    $allCopied = $true
    foreach ($c in $copies) {
        $fromPath = Join-Path $installed $c.From
        $toPath   = Join-Path $src $c.To
        if (-not (Test-Path $fromPath)) {
            $allCopied = $false
            $line = "Q1: source missing, not copied: $fromPath"
            Write-Host $line
            Add-Content -Path $result -Value $line -Encoding ASCII
            continue
        }
        try {
            if ($c.Kind -eq 'dir') {
                Copy-Item -Recurse $fromPath $toPath -ErrorAction Stop
            } else {
                Copy-Item $fromPath $toPath -ErrorAction Stop
            }
        } catch {
            $allCopied = $false
            $line = "Q1: could not copy $($c.From): $($_.Exception.Message)"
            Write-Host $line
            Add-Content -Path $result -Value $line -Encoding ASCII
        }
    }

    Write-Host ''
    if ($allCopied) {
        Write-Host 'Q1 reshaped source built at:'
        Write-Host "    $src"
        Write-Host 'Q1 NEXT: from the repo checkout, run these two lines and report all output:'
        Write-Host ('    $env:CC_CHROME_SOURCE = ' + "'$src'")
        Write-Host '    .\scripts\install.ps1'
        Add-Content -Path $result -Value "Q1: reshaped source built at $src - run install.ps1 against it (see console for the exact lines) and report the output separately." -Encoding ASCII
    } else {
        Write-Host 'Q1 INCOMPLETE: one or more files above are missing from this install, so the'
        Write-Host 'reshaped source is not a full copy. See the lines above for which ones.'
        Add-Content -Path $result -Value 'Q1 INCOMPLETE: see the missing/failed lines above.' -Encoding ASCII
    }
}

Write-Host ("probe files kept for inspection at: " + $probe)
Add-Content -Path $result -Value "probe files kept for inspection at: $probe" -Encoding ASCII
Add-Content -Path $result -Value '' -Encoding ASCII
Add-Content -Path $result -Value '--- Q2/Q3/Q4 ---' -Encoding ASCII

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
# run from a SECOND, independently scheduled task instead (the "observer"),
# for the same reason the runner itself has to survive: only a process Task
# Scheduler owns directly (not a child of this script) can outlive this
# script's death.
#
# The verdict is measured strictly AFTER the kill, not by comparing to a
# baseline taken before it: the observer samples the heartbeat count
# immediately before it runs taskkill ($mid), confirms the target process is
# actually gone (not just that taskkill was invoked), then samples twice more
# a few seconds apart ($after1, $after2). SURVIVES requires $after2 -gt
# $after1 - growth strictly after a CONFIRMED kill is the only evidence that
# means anything. Sampling against $before (measured minutes earlier by this
# script, before the kill was even armed) cannot distinguish "survived" from
# "died 4-7 seconds after the baseline, before the kill" - the child writes
# one heartbeat a second, so that gap alone is enough heartbeats to look like
# survival even when the child is already dead. $before is kept only as a
# liveness check ("the child was writing before any of this started").
$beat         = Join-Path $probe 'heartbeat.txt'
$child        = Join-Path $probe 'child.ps1'
$observer     = Join-Path $probe 'observer.ps1'
$taskName     = 'CcProbeRunnerTask'
$observerTask = 'CcProbeObserverTask'

# --- Q4: power source, answerable regardless of what Q2 finds ---------------
$battery = Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue
if ($battery) {
    $q4 = "Q4 ANSWER: battery present, BatteryStatus=$($battery.BatteryStatus) (1=discharging/on battery, 2=on AC). Re-run this probe unplugged to actually exercise the on-battery start setting."
} else {
    $q4 = 'Q4 ANSWER: no battery found on this machine (desktop or VM) - on-battery start not testable here'
}
Write-Host $q4
Add-Content -Path $result -Value $q4 -Encoding ASCII

# Paths are baked into the generated scripts rather than passed as arguments:
# argument quoting through Task Scheduler is its own source of failures and
# is not what we are trying to measure.
$beatQ = PsQuote $beat
Set-Content -Path $child -Encoding ASCII -Value (
    "1..60 | ForEach-Object { Add-Content -Path '$beatQ' -Value ('beat ' + `$_); Start-Sleep -Seconds 1 }"
)

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
# child.ps1 instead of node.exe + update-runner.mjs. -WindowStyle Hidden is
# added on top, purely so the child's console does not sit next to the
# observer's for a minute and confuse whoever is watching - it has no
# equivalent in the product's own command (node.exe has no such flag).
#
# -ExecutionPolicy Bypass on every nested hop: the probe itself is launched
# with it, but child.ps1 and observer.ps1 are separate powershell
# invocations that do not inherit it, and a client Windows defaults to
# Restricted - which refuses to run a .ps1 from file, silently as far as the
# heartbeat is concerned.
$childArg = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $child + '"'

# Register and Start are two separate try blocks (not one), so a Start
# failure is never misreported as a registration failure, and so a Start
# failure after a successful Register still triggers cleanup instead of
# leaving the task orphaned.
$runnerRegistered = $false
try {
    $a = New-ScheduledTaskAction -Execute 'powershell' -Argument $childArg -WorkingDirectory $probe
    $s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    $p = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $taskName -Action $a -Settings $s -Principal $p -Force | Out-Null
    $runnerRegistered = $true
    $q3 = 'Q3 ANSWER: registration succeeded'
} catch {
    $q3 = "Q3 ANSWER: registration FAILED: $($_.Exception.Message)"
}
Write-Host $q3
Add-Content -Path $result -Value $q3 -Encoding ASCII

# H7: both throwaway tasks are registered with NO -Trigger, so neither can
# ever fire on its own - an orphan left by an interrupted run is inert, not
# a ticking time bomb. Still, print the exact recovery commands now, before
# anything is killed, so an aborted run leaves the user holding them.
$recoverRunner   = "Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
$recoverObserver = "Unregister-ScheduledTask -TaskName '$observerTask' -Confirm:`$false"
Write-Host 'both throwaway tasks below are registered with NO trigger, so neither can fire on its own if left behind.'
Write-Host 'if this run is interrupted, clean up manually with:'
Write-Host "    $recoverRunner"
Write-Host "    $recoverObserver"
Add-Content -Path $result -Value 'both throwaway tasks are registered with NO trigger and cannot fire on their own if left behind.' -Encoding ASCII
Add-Content -Path $result -Value "manual cleanup if interrupted: $recoverRunner" -Encoding ASCII
Add-Content -Path $result -Value "manual cleanup if interrupted: $recoverObserver" -Encoding ASCII

$runnerStarted = $false
if ($runnerRegistered) {
    try {
        Start-ScheduledTask -TaskName $taskName
        $runnerStarted = $true
    } catch {
        $msg = "Q3b ANSWER: Start-ScheduledTask for the runner FAILED: $($_.Exception.Message)"
        Write-Host $msg
        Add-Content -Path $result -Value $msg -Encoding ASCII
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    }
}

if (-not ($runnerRegistered -and $runnerStarted)) {
    $q2 = 'Q2 ANSWER: skipped, the runner task did not register and start - see Q3/Q3b above'
    Write-Host $q2
    Add-Content -Path $result -Value $q2 -Encoding ASCII
} else {
    Start-Sleep -Seconds 6
    $before = Read-HeartbeatCount $beat
    $beforeMsg = "heartbeat lines before any of this started (liveness check only, NOT the SURVIVES/DIES baseline): $before"
    Write-Host $beforeMsg
    Add-Content -Path $result -Value $beforeMsg -Encoding ASCII

    if ($before -eq 0) {
        # H4: distinguish "task never ran" from "ran and wrote nothing".
        # LastTaskResult 0x2 is server/updater.js's own named silent-failure
        # mode for a bad working directory or executable path.
        $info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
        if ($info) {
            $state = (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue).State
            $infoMsg = "runner task LastRunTime=$($info.LastRunTime) LastTaskResult=$($info.LastTaskResult) State=$state"
        } else {
            $infoMsg = 'runner task: Get-ScheduledTaskInfo returned nothing'
        }
        Write-Host $infoMsg
        Add-Content -Path $result -Value $infoMsg -Encoding ASCII
        $q2 = 'Q2 INCONCLUSIVE: the scheduled task never started its child (or wrote nothing before the check) - see LastTaskResult above. Report this.'
        Write-Host $q2
        Add-Content -Path $result -Value $q2 -Encoding ASCII
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    } else {
        # The observer: a second one-shot task, independent of this process,
        # that does the kill, verifies it, and measures survive/die. It has
        # to do all three - once it kills $PID, THIS process is gone and
        # cannot write anything further (see the comment above this block).
        $resultQ = PsQuote $result
        $observerBody = @(
            "`$ErrorActionPreference = 'Stop'",
            # H4: this is the observer's FIRST action, unconditionally, so
            # "never launched", "launched and crashed immediately", and
            # "killed the window then failed before writing anything" are
            # distinguishable in the result file instead of all looking like
            # silence.
            "Add-Content -Path '$resultQ' -Value 'observer started, about to kill $PID' -Encoding ASCII",
            "function Read-BeatCount {",
            "    for (`$i = 0; `$i -lt 3; `$i++) {",
            "        `$n = @(Get-Content '$beatQ' -ErrorAction SilentlyContinue).Count",
            "        if (`$n -gt 0) { return `$n }",
            "        Start-Sleep -Milliseconds 300",
            "    }",
            "    return `$n",
            "}",
            "Start-Sleep -Seconds 2",
            "`$mid = Read-BeatCount",
            "Add-Content -Path '$resultQ' -Value ('heartbeat lines immediately before the kill (mid): ' + `$mid) -Encoding ASCII",
            "& taskkill /pid $PID /T /F *> `$null",
            "`$killExit = `$LASTEXITCODE",
            # H2: confirm the target actually died instead of trusting the
            # exit code alone - retry briefly, since TerminateProcess is
            # asynchronous and the process may take a moment to fully exit.
            "`$stillAlive = `$true",
            "for (`$j = 0; `$j -lt 5; `$j++) {",
            "    Start-Sleep -Milliseconds 500",
            "    `$stillAlive = [bool](Get-Process -Id $PID -ErrorAction SilentlyContinue)",
            "    if (-not `$stillAlive) { break }",
            "}",
            "Add-Content -Path '$resultQ' -Value ('taskkill exit code: ' + `$killExit + ', target still running: ' + `$stillAlive) -Encoding ASCII",
            "if (`$stillAlive) {",
            # H2: refuse to print SURVIVES when the kill did not even take -
            # continuing heartbeats prove nothing if the process that was
            # supposed to die never did.
            "    Add-Content -Path '$resultQ' -Value ('Q2 INCONCLUSIVE: the kill did not take (exit code ' + `$killExit + ', target still running)') -Encoding ASCII",
            "} else {",
            # H1: the verdict compares two samples taken AFTER a CONFIRMED
            # kill, never against $before. Growth strictly after the kill is
            # the only evidence that means anything.
            "    Start-Sleep -Seconds 5",
            "    `$after1 = Read-BeatCount",
            "    Start-Sleep -Seconds 5",
            "    `$after2 = Read-BeatCount",
            "    Add-Content -Path '$resultQ' -Value ('heartbeat lines ~5s after the kill (after1): ' + `$after1) -Encoding ASCII",
            "    Add-Content -Path '$resultQ' -Value ('heartbeat lines ~10s after the kill (after2): ' + `$after2) -Encoding ASCII",
            "    if (`$after2 -gt `$after1) {",
            "        Add-Content -Path '$resultQ' -Value 'Q2 ANSWER: the task-launched runner SURVIVES a taskkill /T on its launcher' -Encoding ASCII",
            "    } else {",
            "        Add-Content -Path '$resultQ' -Value 'Q2 ANSWER: it DIES - the handover still does not work on Windows' -Encoding ASCII",
            "    }",
            "}",
            "Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false -ErrorAction SilentlyContinue",
            "Unregister-ScheduledTask -TaskName '$observerTask' -Confirm:`$false -ErrorAction SilentlyContinue"
        )
        Set-Content -Path $observer -Encoding ASCII -Value $observerBody

        $observerRegistered = $false
        try {
            $oa = New-ScheduledTaskAction -Execute 'powershell' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $observer + '"') -WorkingDirectory $probe
            $op = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
            Register-ScheduledTask -TaskName $observerTask -Action $oa -Principal $op -Force | Out-Null
            $observerRegistered = $true
        } catch {
            $msg = "Q2 ANSWER: could not register the observer task, so no verified kill happened: $($_.Exception.Message)"
            Write-Host $msg
            Add-Content -Path $result -Value $msg -Encoding ASCII
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        }

        if ($observerRegistered) {
            try {
                Start-ScheduledTask -TaskName $observerTask
            } catch {
                $msg = "Q2 ANSWER: observer task registered but failed to start, so no verified kill happened: $($_.Exception.Message)"
                Write-Host $msg
                Add-Content -Path $result -Value $msg -Encoding ASCII
                Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
                Unregister-ScheduledTask -TaskName $observerTask -Confirm:$false -ErrorAction SilentlyContinue
                $observerRegistered = $false
            }
        }

        if ($observerRegistered) {
            Write-Host "observer task started; it will kill this window's process tree (pid $PID) in ~2 seconds, the way Stop-CcTask kills the bridge"
            Add-Content -Path $result -Value "killing pid $PID (this window) via taskkill /T /F in ~2s, as Stop-CcTask does to the bridge" -Encoding ASCII
            Write-Host 'this window is likely to die now. The final Q2 ANSWER lands in the result file in about 20-25 more seconds.'
            Write-Host 'Open a NEW PowerShell window and run:'
            Write-Host "    Get-Content '$result'"

            # If this window is NOT actually killed (for example, this
            # account cannot taskkill its own process), wait for the
            # observer anyway and surface its answer here too, instead of
            # this window just hanging with no explanation.
            $deadline = (Get-Date).AddSeconds(35)
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
        }
    }
}

# --- Residual limitations of this probe, not fixable here -------------------
# 1. This probe kills an ordinary console powershell.exe. In production, the
#    killed process is itself a Task Scheduler task instance (wscript.exe ->
#    node.exe under the CcChromeBridge task). If task-instance job-object
#    semantics ever reached across to a task started BY that instance, this
#    probe cannot see it.
# 2. Register-ScheduledTask has no 262-character argument limit, unlike
#    `schtasks /create /tr`. A green Q2/Q3 here proves the CMDLET shape
#    works, not that the product's real, much longer
#    `node.exe ... update-runner.mjs ...` command line registers and runs.
