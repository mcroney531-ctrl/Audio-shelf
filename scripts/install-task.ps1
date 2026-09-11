# Registers AudioShelf as a Windows scheduled task so it starts at logon and
# runs with no visible terminal window. After this you never open PowerShell
# for day-to-day use: add books in Explorer, open the app in a browser.
#
# Verified on Windows 10/11 with Windows PowerShell 5.1.
#
#   .\scripts\install-task.ps1            # install and start it now
#   .\scripts\install-task.ps1 -Remove    # unregister it again
[CmdletBinding()]
param(
  [string]$TaskName = 'AudioShelf',
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)) {
  Write-Host 'Scheduled tasks are a Windows feature; this script only runs there.' -ForegroundColor Red
  return
}

$root = Split-Path -Parent $PSScriptRoot
$starter = Join-Path $root 'start.ps1'

if ($Remove) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed the '$TaskName' task. AudioShelf will not start at logon any more." -ForegroundColor Yellow
  } else {
    Write-Host "No '$TaskName' task is registered." -ForegroundColor DarkGray
  }
  return
}

if (-not (Test-Path $starter)) {
  Write-Host "Cannot find start.ps1 next to this script (looked in $root)." -ForegroundColor Red
  return
}

$envFile = Join-Path $root '.env'
if (-not (Test-Path $envFile)) {
  Write-Host 'Run .\start.ps1 once first, so your library folder gets saved to .env.' -ForegroundColor Red
  return
}

$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$starter`" -SkipInstall" `
  -WorkingDirectory $root

$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"

# Keep serving on battery, restart if it ever falls over, and never time out:
# an audiobook server is meant to sit there for months.
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description 'AudioShelf self-hosted audiobook server' `
  -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName

$port = '8080'
foreach ($line in Get-Content $envFile) {
  if ($line -match '^\s*AUDIOSHELF_PORT\s*=\s*(.+)$') { $port = $Matches[1].Trim().Trim('"') }
}

Write-Host "`nAudioShelf now starts automatically when you log in." -ForegroundColor Green
Write-Host "  http://localhost:$port" -ForegroundColor Yellow
Write-Host '  Stop or start it any time in Task Scheduler, or with:' -ForegroundColor DarkGray
Write-Host "    Stop-ScheduledTask -TaskName $TaskName" -ForegroundColor DarkGray
Write-Host "    Start-ScheduledTask -TaskName $TaskName" -ForegroundColor DarkGray
Write-Host "  Remove it with:  .\scripts\install-task.ps1 -Remove`n" -ForegroundColor DarkGray
