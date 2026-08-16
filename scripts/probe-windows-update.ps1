# Answers the Windows questions the update design depends on. Run on a real
# Windows machine, in a NON-ELEVATED PowerShell window (Q3 measures whether
# registration needs admin rights - running elevated would make that
# unanswerable, which is why this script records IsInRole(Administrator)
# rather than trusting the operator remembered). Writes only under %TEMP% and
# registers throwaway scheduled tasks which remove themselves again (and
# cannot fire on their own even if left behind - see the Q2/Q3 section).
# Needs no administrator rights.
#
# Run it with `powershell`, NOT `pwsh`. This script writes every file with
# -Encoding Default, which is what Windows PowerShell 5.1's own "a BOM-less
# .ps1 is ANSI" read behaviour pairs with - and which PowerShell 6+ removed.
# Under pwsh the very first Add-Content fails on parameter binding and leaves
# a zero-byte result file: the one failure mode where the file itself says
# nothing at all.
#
# ASCII ONLY, deliberately, for THIS file. Windows PowerShell 5.1 reads a
# .ps1 without a BOM as the system ANSI code page, so any character above
# 0x7F in a BOM-less file becomes mojibake and can terminate a string early.
# The first version of this script died exactly that way. This rule is about
# this file's own bytes only - the GENERATED scripts below (child.ps1,
# observer.ps1) are deliberately written BOM-less with -Encoding Default so
# they round-trip correctly through the same ANSI assumption; see the J4
# comment further down for why -Encoding ASCII on those was a regression.
$ErrorActionPreference = 'Stop'

# Same GUID suffix is reused for the probe directory name and both task
# names (J6): the task names used to be constants, so an aborted run (which
# leaves the previous child running for up to 3 minutes under
# -MultipleInstances IgnoreNew - see the child's 1..180 loop further down)
# made the NEXT run's Start-ScheduledTask a silent no-op - new heartbeat
# file never created, probe wrongly reports "the scheduled task never
# started its child". A fresh suffix per run makes that collision
# impossible instead of asking the operator to remember to clean up first.
$runId = [guid]::NewGuid().ToString('N').Substring(0, 8)
$probe = Join-Path $env:TEMP ('cc-probe-' + $runId)
New-Item -ItemType Directory -Path $probe | Out-Null
Write-Host "probe dir: $probe"

# The Q2/Q3/Q4 block below ends by killing this process's own tree, so
# everything reportable is appended to this file as it is learned, and the
# file's path is printed now, before anything else runs - console output
# stops the instant that kill lands, but the file does not.
$result = Join-Path $probe 'result.txt'
New-Item -ItemType File -Path $result -Force | Out-Null
Write-Host "result file (check this even if a window dies): $result"
Add-Content -Path $result -Value "result file: $result" -Encoding Default

$psVer = $PSVersionTable.PSVersion.ToString()
$osVer = [System.Environment]::OSVersion.VersionString
$envMsg = "PowerShell version: $psVer | OS: $osVer"
Write-Host $envMsg
Add-Content -Path $result -Value $envMsg -Encoding Default

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
Add-Content -Path $result -Value '' -Encoding Default
Add-Content -Path $result -Value '--- Q1 ---' -Encoding Default
$src       = Join-Path $probe 'source'
$installed = Join-Path $env:USERPROFILE '.cc-chrome-bridge'
if (-not (Test-Path $installed)) {
    $msg = "Q1: no install found at $installed"
    Write-Host ''
    Write-Host $msg
    Add-Content -Path $result -Value $msg -Encoding Default
    # J7: the from-checkout instructions used to be console-only ("see
    # console output for ..."), which is worthless once this window is gone.
    # Every line the user needs is now ALSO written to $result.
    $alt1 = 'Q1 ALTERNATIVE: a checkout IS already the layout CC_CHROME_SOURCE expects, so Q1 can be answered from the repo directly. From the checkout root run:'
    $alt2 = '    cd server; npm.cmd install; cd ..'
    $alt3 = '    $env:CC_CHROME_SOURCE = (Get-Location).Path'
    $alt4 = '    powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1'
    $alt5 = 'That INSTALLS the bridge on this machine, REPLACING any existing install and stopping/restarting the bridge service. Report the full output either way.'
    Write-Host $alt1
    Write-Host $alt2
    Write-Host $alt3
    Write-Host $alt4
    Write-Host $alt5
    Add-Content -Path $result -Value $alt1 -Encoding Default
    Add-Content -Path $result -Value $alt2 -Encoding Default
    Add-Content -Path $result -Value $alt3 -Encoding Default
    Add-Content -Path $result -Value $alt4 -Encoding Default
    Add-Content -Path $result -Value $alt5 -Encoding Default
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
        Add-Content -Path $result -Value $line -Encoding Default
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
    # Minor: server\node_modules is the first thing copied and can be large;
    # say so, or the long silent pause reads as a hang.
    Write-Host 'Q1: copying server\node_modules now - this can take a while with no console output. That pause is expected, not a hang.'
    Add-Content -Path $result -Value 'Q1: copying server\node_modules now - a long silent pause here is expected.' -Encoding Default
    $allCopied = $true
    foreach ($c in $copies) {
        $fromPath = Join-Path $installed $c.From
        $toPath   = Join-Path $src $c.To
        if (-not (Test-Path $fromPath)) {
            $allCopied = $false
            $line = "Q1: source missing, not copied: $fromPath"
            Write-Host $line
            Add-Content -Path $result -Value $line -Encoding Default
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
            Add-Content -Path $result -Value $line -Encoding Default
        }
    }

    Write-Host ''
    if ($allCopied) {
        # J7 + Minor (PsQuote the pasted line): every line the user needs to
        # run install.ps1 against the reshaped source goes into $result too,
        # not just the console, and the path is apostrophe-safe.
        $srcQ = PsQuote $src
        $next1 = 'Q1 reshaped source built at:'
        $next2 = "    $src"
        $next3 = 'Q1 NEXT: from the repo checkout, run these two lines and report all output. This REPLACES your current install and stops/restarts the bridge service:'
        $next4 = '    $env:CC_CHROME_SOURCE = ' + "'$srcQ'"
        $next5 = '    .\scripts\install.ps1'
        Write-Host $next1
        Write-Host $next2
        Write-Host $next3
        Write-Host $next4
        Write-Host $next5
        Add-Content -Path $result -Value $next1 -Encoding Default
        Add-Content -Path $result -Value $next2 -Encoding Default
        Add-Content -Path $result -Value $next3 -Encoding Default
        Add-Content -Path $result -Value $next4 -Encoding Default
        Add-Content -Path $result -Value $next5 -Encoding Default
    } else {
        Write-Host 'Q1 INCOMPLETE: one or more files above are missing from this install, so the'
        Write-Host 'reshaped source is not a full copy. See the lines above for which ones.'
        Add-Content -Path $result -Value 'Q1 INCOMPLETE: see the missing/failed lines above.' -Encoding Default
    }
}

Write-Host ("probe files kept for inspection at: " + $probe)
Add-Content -Path $result -Value "probe files kept for inspection at: $probe" -Encoding Default
Add-Content -Path $result -Value '' -Encoding Default
Add-Content -Path $result -Value '--- Q2/Q3/Q4 ---' -Encoding Default

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
# J1: the observer's own Register-ScheduledTask below passes the SAME
# -Settings object the runner uses (built once, reused). Task Scheduler's
# default settings object has DisallowStartIfOnBatteries = $true and
# StopIfGoingOnBatteries = $true - without this, the OBSERVER (not the
# runner) would silently refuse to launch on battery power: no kill, no
# verdict, both tasks left registered, result file ending at "killing pid
# ... in ~2s" with no explanation. That the runner needs
# AllowStartIfOnBatteries / DontStopIfGoingOnBatteries at all is the
# product's own position (server/updater.js sets them for this exact launch
# path); the observer needs it for the same reason.
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
$taskName     = "CcProbeRunnerTask-$runId"
$observerTask = "CcProbeObserverTask-$runId"

# --- Q4: power source, answerable regardless of what Q2 finds ---------------
$battery = Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue
if ($battery) {
    $q4 = "Q4 ANSWER: battery present, BatteryStatus=$($battery.BatteryStatus) (1=discharging/on battery, 2=on AC). Re-run this probe unplugged to actually exercise the on-battery start setting - both the runner and the observer are now registered with AllowStartIfOnBatteries (see the J1 comment above)."
} else {
    $q4 = 'Q4 ANSWER: no battery found on this machine (desktop or VM) - on-battery start not testable here'
}
Write-Host $q4
Add-Content -Path $result -Value $q4 -Encoding Default

# Paths are baked into the generated scripts rather than passed as arguments:
# argument quoting through Task Scheduler is its own source of failures and
# is not what we are trying to measure.
#
# J4: -Encoding Default, not -Encoding ASCII. .NET's ASCII encoder REPLACES
# every byte above 0x7F with '?' at write time rather than rejecting it. On
# an account whose name carries diacritics, %TEMP% would get baked into this
# file as "C:\Users\H?a\...", the child would then append to a path that
# does not exist, fail non-terminatingly 180 times, heartbeat.txt would never
# be created, and the probe would report "the scheduled task never started
# its child" with a HEALTHY LastTaskResult - a confidently wrong diagnosis.
# PowerShell 5.1 reads a BOM-less .ps1 as the system ANSI code page, so
# -Encoding Default (which writes that same code page, BOM-less) is what
# actually round-trips. This does not apply to
# scripts/probe-windows-update.ps1 itself, which stays ASCII-only with a BOM
# - only the files IT WRITES need this.
$beatQ = PsQuote $beat
# Minor: 180 heartbeats (3 minutes), not 60. The prior 60s budget left only
# an accidental ~29s of margin against the observer's own worst-case timing;
# this costs nothing and removes that timing argument entirely.
Set-Content -Path $child -Encoding Default -Value (
    "1..180 | ForEach-Object { Add-Content -Path '$beatQ' -Value ('beat ' + `$_); Start-Sleep -Seconds 1 }"
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

# J3: Q3 asks whether registration succeeds WITHOUT administrator rights,
# but nothing recorded whether this shell was elevated - "registration
# succeeded" printed either way, which cannot answer the question as asked.
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$isAdminMsg = "Q3 context: this shell IsInRole(Administrator) = $isAdmin (Q3 below only answers 'does registration need admin rights' if this is False - re-run in a non-elevated window if it is True)"
Write-Host $isAdminMsg
Add-Content -Path $result -Value $isAdminMsg -Encoding Default

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
Add-Content -Path $result -Value $q3 -Encoding Default

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
Add-Content -Path $result -Value 'both throwaway tasks are registered with NO trigger and cannot fire on their own if left behind.' -Encoding Default
Add-Content -Path $result -Value "manual cleanup if interrupted: $recoverRunner" -Encoding Default
Add-Content -Path $result -Value "manual cleanup if interrupted: $recoverObserver" -Encoding Default

$runnerStarted = $false
if ($runnerRegistered) {
    try {
        Start-ScheduledTask -TaskName $taskName
        $runnerStarted = $true
    } catch {
        $msg = "Q3b ANSWER: Start-ScheduledTask for the runner FAILED: $($_.Exception.Message)"
        Write-Host $msg
        Add-Content -Path $result -Value $msg -Encoding Default
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    }
}

if (-not ($runnerRegistered -and $runnerStarted)) {
    $q2 = 'Q2 ANSWER: skipped, the runner task did not register and start - see Q3/Q3b above'
    Write-Host $q2
    Add-Content -Path $result -Value $q2 -Encoding Default
} else {
    Start-Sleep -Seconds 6
    $before = Read-HeartbeatCount $beat
    $beforeMsg = "heartbeat lines before any of this started (liveness check only, NOT the SURVIVES/DIES baseline): $before"
    Write-Host $beforeMsg
    Add-Content -Path $result -Value $beforeMsg -Encoding Default

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
        Add-Content -Path $result -Value $infoMsg -Encoding Default
        $q2 = 'Q2 INCONCLUSIVE: the scheduled task never started its child (or wrote nothing before the check) - see LastTaskResult above. Report this.'
        Write-Host $q2
        Add-Content -Path $result -Value $q2 -Encoding Default
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    } else {
        # The observer: a second one-shot task, independent of this process,
        # that does the kill, verifies it, and measures survive/die. It has
        # to do all three - once it kills $PID, THIS process is gone and
        # cannot write anything further (see the comment above this block).
        $resultQ = PsQuote $result
        $observerBody = @(
            "`$ErrorActionPreference = 'Stop'",
            # J5: every write to $result inside this generated script goes
            # through Write-Result, which retries on a sharing violation
            # instead of letting it become a terminating error under Stop.
            # The main window polls Get-Content on the same file every
            # second (see the surviving-window loop below), so a collision
            # is not rare here - without a retry, the observer could crash
            # mid-measurement and leave both tasks registered with no
            # explanation.
            "function Write-Result(`$line) {",
            "    for (`$k = 0; `$k -lt 5; `$k++) {",
            "        try {",
            "            Add-Content -Path '$resultQ' -Value `$line -Encoding Default -ErrorAction Stop",
            "            return",
            "        } catch {",
            "            Start-Sleep -Milliseconds 200",
            "        }",
            "    }",
            "}",
            # H4: this is the observer's FIRST action, unconditionally, so
            # "never launched", "launched and crashed immediately", and
            # "killed the window then failed before writing anything" are
            # distinguishable in the result file instead of all looking like
            # silence.
            "Write-Result 'observer started, about to kill $PID'",
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
            "Write-Result ('heartbeat lines immediately before the kill (mid): ' + `$mid)",
            # J5 (Minor): taskkill wrapped in try/catch. Under Stop, 5.1 can
            # promote a native command's stderr into a terminating
            # NativeCommandError, which would kill the observer BEFORE the
            # exit code is even read - losing exactly the evidence H2/J2
            # exist to capture.
            "try {",
            "    & taskkill /pid $PID /T /F *> `$null",
            "    `$killExit = `$LASTEXITCODE",
            "} catch {",
            # $LASTEXITCODE is set by the native command BEFORE PowerShell
            # promotes its stderr into a NativeCommandError, so it still holds
            # taskkill's real code here. A hardcoded -1 would conflate "taskkill
            # failed with output" with "taskkill was not found" - and this
            # branch is the exact path H2 exists to record.
            "    `$killExit = `$LASTEXITCODE",
            "}",
            # H2: confirm the target actually died instead of trusting the
            # exit code alone - retry briefly, since TerminateProcess is
            # asynchronous and the process may take a moment to fully exit.
            "`$stillAlive = `$true",
            "for (`$j = 0; `$j -lt 5; `$j++) {",
            "    Start-Sleep -Milliseconds 500",
            "    `$stillAlive = [bool](Get-Process -Id $PID -ErrorAction SilentlyContinue)",
            "    if (-not `$stillAlive) { break }",
            "}",
            "Write-Result ('taskkill exit code: ' + `$killExit + ', target still running: ' + `$stillAlive)",
            "if (`$stillAlive) {",
            # H2: refuse to print SURVIVES when the kill did not even take -
            # continuing heartbeats prove nothing if the process that was
            # supposed to die never did.
            "    Write-Result ('Q2 INCONCLUSIVE: the kill did not take (exit code ' + `$killExit + ', target still running)')",
            "} else {",
            # H1: the verdict compares two samples taken AFTER a CONFIRMED
            # kill, never against $before. Growth strictly after the kill is
            # the only evidence that means anything.
            "    Start-Sleep -Seconds 5",
            "    `$after1 = Read-BeatCount",
            "    Start-Sleep -Seconds 5",
            "    `$after2 = Read-BeatCount",
            "    Write-Result ('heartbeat lines ~5s after the kill (after1): ' + `$after1)",
            "    Write-Result ('heartbeat lines ~10s after the kill (after2): ' + `$after2)",
            "    if (`$after2 -gt `$after1) {",
            "        Write-Result 'Q2 ANSWER: the task-launched runner SURVIVES a taskkill /T on its launcher'",
            "    } else {",
            "        Write-Result 'Q2 ANSWER: it DIES - the handover still does not work on Windows'",
            "    }",
            "}",
            "Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false -ErrorAction SilentlyContinue",
            "Unregister-ScheduledTask -TaskName '$observerTask' -Confirm:`$false -ErrorAction SilentlyContinue"
        )
        Set-Content -Path $observer -Encoding Default -Value $observerBody

        $observerRegistered = $false
        try {
            $oa = New-ScheduledTaskAction -Execute 'powershell' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $observer + '"') -WorkingDirectory $probe
            $op = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
            # J1: -Settings $s - the SAME settings object the runner used
            # above. Without this, Task Scheduler's own defaults
            # (DisallowStartIfOnBatteries / StopIfGoingOnBatteries) would
            # apply to the OBSERVER, and it would simply never launch on
            # battery power - see the J1 comment earlier in this block.
            Register-ScheduledTask -TaskName $observerTask -Action $oa -Settings $s -Principal $op -Force | Out-Null
            $observerRegistered = $true
        } catch {
            $msg = "Q2 ANSWER: could not register the observer task, so no verified kill happened: $($_.Exception.Message)"
            Write-Host $msg
            Add-Content -Path $result -Value $msg -Encoding Default
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        }

        if ($observerRegistered) {
            try {
                Start-ScheduledTask -TaskName $observerTask
            } catch {
                $msg = "Q2 ANSWER: observer task registered but failed to start, so no verified kill happened: $($_.Exception.Message)"
                Write-Host $msg
                Add-Content -Path $result -Value $msg -Encoding Default
                Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
                Unregister-ScheduledTask -TaskName $observerTask -Confirm:$false -ErrorAction SilentlyContinue
                $observerRegistered = $false
            }
        }

        if ($observerRegistered) {
            Write-Host "observer task started; it will kill this window's process tree (pid $PID) in ~2 seconds, the way Stop-CcTask kills the bridge"
            # The timing belongs in the FILE too: a reader who opens it the
            # moment this window vanishes finds no Q2 line yet, and without
            # this would reasonably report the probe as having failed.
            Add-Content -Path $result -Value "killing pid $PID (this window) via taskkill /T /F in ~2s, as Stop-CcTask does to the bridge. The Q2 ANSWER lands here about 20-25 seconds later - re-read this file after that." -Encoding Default
            Write-Host 'this window is likely to die now. The final Q2 ANSWER lands in the result file in about 20-25 more seconds.'
            Write-Host 'Open a NEW PowerShell window and run:'
            Write-Host "    Get-Content '$result'"

            # If this window is NOT actually killed (for example, this
            # account cannot taskkill its own process), wait for the
            # observer anyway and surface its answer here too, instead of
            # this window just hanging with no explanation. Matches 'Q2 *',
            # not just 'Q2 ANSWER*' (Minor): a legitimate
            # "Q2 INCONCLUSIVE: the kill did not take" line would otherwise
            # never satisfy the old pattern and this loop would run the
            # full 35s and then falsely claim the observer never reported.
            $deadline = (Get-Date).AddSeconds(35)
            $seen = $null
            while ((Get-Date) -lt $deadline) {
                Start-Sleep -Seconds 1
                $seen = Get-Content $result -ErrorAction SilentlyContinue | Where-Object { $_ -like 'Q2 *' }
                if ($seen) { break }
            }
            if ($seen) {
                Write-Host "this window survived long enough to see it: $seen"
            } else {
                # J2: this is the one path where the main script outlives a
                # failed observer and could actually diagnose it - the old
                # code only printed this to a console the user has been told
                # to ignore. Now it also lands in $result, alongside the
                # observer task's own LastRunTime/LastTaskResult/State, the
                # same diagnostic the runner already gets in the before-eq-0
                # branch above. Without this, J1, "observer crashed", and
                # "Task Scheduler silently ignored the start" are
                # indistinguishable from the result file alone.
                $timeoutMsg = 'this window survived 35s, but the observer never wrote a Q2 answer - dumping observer task diagnostics below.'
                Write-Host $timeoutMsg
                Add-Content -Path $result -Value $timeoutMsg -Encoding Default
                $oinfo = Get-ScheduledTaskInfo -TaskName $observerTask -ErrorAction SilentlyContinue
                if ($oinfo) {
                    $ostate = (Get-ScheduledTask -TaskName $observerTask -ErrorAction SilentlyContinue).State
                    $oinfoMsg = "observer task LastRunTime=$($oinfo.LastRunTime) LastTaskResult=$($oinfo.LastTaskResult) State=$ostate"
                } else {
                    $oinfoMsg = 'observer task: Get-ScheduledTaskInfo returned nothing (task may already be gone)'
                }
                Write-Host $oinfoMsg
                Add-Content -Path $result -Value $oinfoMsg -Encoding Default
                # This is the one path that leaves both tasks registered, and
                # the recovery lines are ~200 lines earlier in the file. Repeat
                # them where they actually become relevant.
                Write-Host "    $recoverRunner"
                Write-Host "    $recoverObserver"
                Add-Content -Path $result -Value "both tasks are still registered - run these two lines to clean up:" -Encoding Default
                Add-Content -Path $result -Value "    $recoverRunner" -Encoding Default
                Add-Content -Path $result -Value "    $recoverObserver" -Encoding Default
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
