# Shared by install.ps1 and uninstall.ps1. Dot-sourced, never run directly:
# both need the same task name and paths, and two copies of that knowledge is
# the surest way to have them disagree. This is the Windows counterpart of
# scripts/service-unit.sh — keep the two in step.
#
# The service model is deliberately the same on all three platforms: a
# per-user background job that starts when the user logs in (LaunchAgent on
# macOS, systemd --user on Linux, a scheduled task here). It is NOT a Windows
# Service, and that is a decision, not an omission: a service runs in session 0
# with no user profile, so the side panel's spawned `claude` would have no
# logged-in account to work with, and installing one needs administrator
# rights. Nothing in this file requires elevation.

function Get-CcTaskName { 'ccchrome-bridge' }

function Get-CcLogHint {
    param([Parameter(Mandatory)][string]$InstallDir)
    Join-Path $InstallDir 'logs\bridge.err.log'
}

# node.exe is resolved once, now, and baked in as an absolute path: a scheduled
# task does not inherit an interactive shell's PATH, so a bare `node` would
# fail at logon with an error nobody sees until they wonder why the bridge is
# down. Same tradeoff as the unix side — if that node is later removed (nvm
# version pruned, switched to fnm/volta), the task fails until the installer is
# re-run, which regenerates this against whatever `node` resolves to then.
function Write-CcLauncher {
    param(
        [Parameter(Mandatory)][string]$InstallDir,
        [Parameter(Mandatory)][int]$Port
    )
    $node = (Get-Command node -ErrorAction Stop).Source
    # `claude` gets the same treatment as `node`, for the same reason and one
    # step later: the side panel spawns it once per chat turn, and a scheduled
    # task does not inherit the PATH an interactive shell has. Measured on
    # macOS, where the equivalent gap made every panel turn fail with "spawn
    # claude ENOENT". Left unset when claude is not installed yet —
    # server/agent.js falls back to the bare name and its error message tells
    # the user to install the CLI and re-run this installer.
    $claude = (Get-Command claude -ErrorAction SilentlyContinue)
    $claudeLine = if ($claude) { "set CC_CHROME_CLAUDE_BIN=$($claude.Source)" } else { '' }
    $logs = Join-Path $InstallDir 'logs'
    New-Item -ItemType Directory -Force -Path $logs | Out-Null

    # bridge.cmd carries the environment and the log redirection. Task
    # Scheduler can do neither, and putting them in the .vbs below would mean
    # quoting the same paths twice, through two different quoting rules.
    $cmd = @"
@echo off
set CC_CHROME_HOST=127.0.0.1
set CC_CHROME_PORT=$Port
set CC_CHROME_TOKENS_FILE=$InstallDir\tokens.json
$claudeLine
"$node" "$InstallDir\server\index.js" --http >> "$logs\bridge.log" 2>> "$logs\bridge.err.log"
"@
    Set-Content -Path (Join-Path $InstallDir 'bridge.cmd') -Value $cmd -Encoding ASCII

    # Why a .vbs at all: Task Scheduler running node.exe (or cmd.exe) leaves a
    # console window on screen for the whole session. WScript.Shell.Run with
    # window style 0 is the one way to start it with no window at all and no
    # extra binary in the release.
    #
    # Run(..., 0, True) — the True is load-bearing, not incidental. With False
    # wscript returns immediately, Task Scheduler marks the task finished while
    # node is still running, and both MultipleInstances=IgnoreNew (the
    # "already up?" check) and restart-on-failure stop meaning anything.
    $vbs = @"
CreateObject("WScript.Shell").Run """$InstallDir\bridge.cmd""", 0, True
"@
    Set-Content -Path (Join-Path $InstallDir 'bridge-launcher.vbs') -Value $vbs -Encoding ASCII
}

function Register-CcTask {
    param([Parameter(Mandatory)][string]$InstallDir)
    $vbs = Join-Path $InstallDir 'bridge-launcher.vbs'
    $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`""

    # Two triggers on purpose. At-logon is the LaunchAgent equivalent. The
    # repeating one is the KeepAlive / Restart=always equivalent: paired with
    # MultipleInstances=IgnoreNew it is a no-op while the bridge is up, and
    # brings it back within five minutes when it is not.
    $atLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) `
        -RepetitionInterval (New-TimeSpan -Minutes 5)

    # ExecutionTimeLimit 0 = no limit. The default is three days, after which
    # Task Scheduler would kill a perfectly healthy bridge.
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -Hidden `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -MultipleInstances IgnoreNew

    # LogonType Interactive and RunLevel Limited: the task stays inside the
    # user's own logon session. That is what lets the side panel spawn `claude`
    # with this user's profile and credentials, and what makes registration
    # possible without administrator rights.
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
        -LogonType Interactive -RunLevel Limited

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
