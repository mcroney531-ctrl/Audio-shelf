# AudioShelf launcher for Windows.
#
#   Right-click this file -> "Run with PowerShell", or from a PowerShell window:
#     .\start.ps1
#     .\start.ps1 -Library "D:\Audiobooks" -Port 8080
#
# On the first run it checks Node, installs dependencies, asks where your
# audiobooks live and writes that to .env so later runs need no arguments.
[CmdletBinding()]
param(
  [string]$Library,
  [int]$Port = 0,
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Write-Step($message) { Write-Host "`n$message" -ForegroundColor Cyan }
function Write-Note($message) { Write-Host "  $message" -ForegroundColor DarkGray }

# --- Node -------------------------------------------------------------------
Write-Step 'Checking Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host 'Node.js is not installed.' -ForegroundColor Red
  Write-Note 'Install it with:  winget install OpenJS.NodeJS.LTS'
  Write-Note 'or download from https://nodejs.org, then re-run this script.'
  Read-Host 'Press Enter to close'
  exit 1
}

$version = (& node -e 'process.stdout.write(process.versions.node)')
$parts = $version.Split('.')
if ([int]$parts[0] -lt 22 -or ([int]$parts[0] -eq 22 -and [int]$parts[1] -lt 5)) {
  Write-Host "Node $version is too old - AudioShelf needs 22.5 or newer." -ForegroundColor Red
  Write-Note 'Upgrade with:  winget upgrade OpenJS.NodeJS.LTS'
  Read-Host 'Press Enter to close'
  exit 1
}
Write-Note "Node $version"

# --- dependencies -----------------------------------------------------------
if (-not $SkipInstall -and -not (Test-Path 'node_modules')) {
  Write-Step 'Installing dependencies (once)'
  & npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'npm install failed.' -ForegroundColor Red
    Read-Host 'Press Enter to close'
    exit 1
  }
}

# --- settings ---------------------------------------------------------------
$envFile = Join-Path $PSScriptRoot '.env'
$settings = [ordered]@{}
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') { $settings[$Matches[1]] = $Matches[2].Trim('"') }
  }
}

if ($Library) { $settings['AUDIOSHELF_LIBRARY'] = $Library }
if ($Port -gt 0) { $settings['AUDIOSHELF_PORT'] = "$Port" }

if (-not $settings['AUDIOSHELF_LIBRARY']) {
  Write-Step 'Where do your audiobooks live?'
  Write-Note 'One folder per book, e.g. D:\Audiobooks\Author Name\Book Title\'
  Write-Note 'Leave blank to use the demo library that ships with the project.'
  $answer = Read-Host 'Library folder'
  if ($answer) {
    $settings['AUDIOSHELF_LIBRARY'] = $answer.Trim('"')
  } else {
    & node --disable-warning=ExperimentalWarning scripts/seed-demo.js
    $settings['AUDIOSHELF_LIBRARY'] = (Join-Path $PSScriptRoot 'library')
  }
}

if (-not (Test-Path $settings['AUDIOSHELF_LIBRARY'])) {
  Write-Host "That folder does not exist: $($settings['AUDIOSHELF_LIBRARY'])" -ForegroundColor Red
  Write-Note 'Fix the path in .env and run this script again.'
  Read-Host 'Press Enter to close'
  exit 1
}

if (-not $settings['AUDIOSHELF_PORT']) { $settings['AUDIOSHELF_PORT'] = '8080' }

$lines = foreach ($key in $settings.Keys) { "$key=$($settings[$key])" }
# WriteAllLines gives UTF-8 without a BOM on both Windows PowerShell 5.1 and 7+;
# Set-Content -Encoding UTF8 would prefix a BOM and corrupt the first key.
[System.IO.File]::WriteAllLines($envFile, [string[]]$lines)

# --- go ---------------------------------------------------------------------
$port = $settings['AUDIOSHELF_PORT']
$lan = $null
if (Get-Command Get-NetIPAddress -ErrorAction SilentlyContinue) {
  $lan = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object -First 1 -ExpandProperty IPAddress)
}

Write-Step 'Starting AudioShelf'
Write-Note "library : $($settings['AUDIOSHELF_LIBRARY'])"
Write-Host "`n  On this PC : http://localhost:$port" -ForegroundColor Yellow
if ($lan) { Write-Host "  On the LAN : http://${lan}:$port" -ForegroundColor Yellow }
Write-Note 'The first account you create is the administrator.'
Write-Note 'Installing to a phone home screen needs HTTPS - see the README.'
Write-Host "`n  Ctrl+C to stop.`n" -ForegroundColor DarkGray

& node --disable-warning=ExperimentalWarning server/index.js
