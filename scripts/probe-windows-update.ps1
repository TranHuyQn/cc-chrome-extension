# Answers the two Windows questions the update design depends on. Run on a real
# Windows machine with the bridge already installed. Writes nothing outside
# $env:TEMP and never touches the installed bridge.
$ErrorActionPreference = 'Stop'
$probe = Join-Path $env:TEMP "cc-probe-$(Get-Random)"
New-Item -ItemType Directory -Path $probe | Out-Null
Write-Host "probe dir: $probe"

# --- Q2 first: does a detached child outlive its parent being killed? ---------
# The child writes a heartbeat line every second for 20s. We kill the PARENT
# (this shell's spawned intermediary) after 3s and see whether the file keeps
# growing — that is exactly the shape update-runner needs to survive.
$beat = Join-Path $probe 'heartbeat.txt'
$childScript = Join-Path $probe 'child.ps1'
@"
1..20 | ForEach-Object { Add-Content -Path '$beat' -Value "beat `$_"; Start-Sleep -Seconds 1 }
"@ | Set-Content $childScript

$parent = Start-Process -FilePath 'powershell' `
    -ArgumentList '-NoProfile','-WindowStyle','Hidden','-File',$childScript `
    -PassThru
Start-Sleep -Seconds 3
Stop-Process -Id $parent.Id -Force
Write-Host "killed pid $($parent.Id) after 3s"
$before = (Get-Content $beat -ErrorAction SilentlyContinue).Count
Start-Sleep -Seconds 6
$after = (Get-Content $beat -ErrorAction SilentlyContinue).Count
Write-Host "Q2 heartbeat lines: before=$before after=$after"
if ($after -gt $before) { Write-Host "Q2 ANSWER: detached child SURVIVES parent kill" }
else { Write-Host "Q2 ANSWER: detached child DIES with parent — design change needed" }

# --- Q1: does install.ps1 accept a reshaped CC_CHROME_SOURCE? ----------------
# Build the checkout layout the updater will build, from the installed copy
# (same file set a release tarball carries), then run install.ps1 -WhatIf-style
# by pointing HOME at a throwaway dir so nothing real is touched.
$src = Join-Path $probe 'source'
$installed = Join-Path $env:USERPROFILE '.cc-chrome-bridge'
New-Item -ItemType Directory -Path (Join-Path $src 'scripts') | Out-Null
New-Item -ItemType Directory -Path (Join-Path $src '.claude\commands') -Force | Out-Null
Copy-Item -Recurse (Join-Path $installed 'server')    (Join-Path $src 'server')
Copy-Item -Recurse (Join-Path $installed 'extension') (Join-Path $src 'extension')
Copy-Item (Join-Path $installed 'ccchrome.md')     (Join-Path $src '.claude\commands\ccchrome.md')
Copy-Item (Join-Path $installed 'uninstall.ps1')   (Join-Path $src 'scripts\uninstall.ps1')
Copy-Item (Join-Path $installed 'service-task.ps1') (Join-Path $src 'scripts\service-task.ps1')
Write-Host "Q1 reshaped source at: $src"
Write-Host "Q1 NEXT: run this by hand and report the full output:"
Write-Host "    `$env:CC_CHROME_SOURCE='$src'; powershell -File '$installed\..\<repo>\scripts\install.ps1'"
Write-Host "  (or from a checkout: `$env:CC_CHROME_SOURCE='$src'; .\scripts\install.ps1)"
