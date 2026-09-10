# Stops whatever is serving AudioShelf, by port rather than by window.
#
# Closing a terminal with the X leaves the server running with no window
# attached, which makes "press Ctrl+C in the right window" impossible advice.
#
#   .\scripts\stop.ps1            # show it and stop it
#   .\scripts\stop.ps1 -WhatIf    # just show what is listening
[CmdletBinding()]
param(
  [int]$Port = 0,
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) {
  Write-Host 'This script needs Windows (Get-NetTCPConnection).' -ForegroundColor Red
  return
}

# Default to whatever port start.ps1 recorded.
if ($Port -le 0) {
  $Port = 8080
  $envFile = Join-Path (Split-Path -Parent $PSScriptRoot) '.env'
  if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
      if ($line -match '^\s*AUDIOSHELF_PORT\s*=\s*(\d+)') { $Port = [int]$Matches[1] }
    }
  }
}

$listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
if (-not $listeners) {
  Write-Host "Nothing is listening on port $Port." -ForegroundColor DarkGray
  return
}

foreach ($processId in ($listeners.OwningProcess | Sort-Object -Unique)) {
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if (-not $process) { continue }

  $started = try { $process.StartTime } catch { $null }
  Write-Host ("port {0} -> {1} (pid {2}){3}" -f $Port, $process.ProcessName, $processId,
    $(if ($started) { ", started $started" } else { '' })) -ForegroundColor Yellow

  if ($WhatIf) { continue }

  try {
    Stop-Process -Id $processId -ErrorAction Stop
    Write-Host "  stopped" -ForegroundColor Green
  } catch {
    Write-Host "  could not stop it: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  If it says access denied, the process belongs to another Windows" -ForegroundColor DarkGray
    Write-Host "  profile - reopen PowerShell as Administrator and run this again." -ForegroundColor DarkGray
  }
}

if (-not $WhatIf) {
  Start-Sleep -Milliseconds 400
  if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    Write-Host "Something is still on port $Port." -ForegroundColor Red
  } else {
    Write-Host "Port $Port is free." -ForegroundColor Green
  }
}
