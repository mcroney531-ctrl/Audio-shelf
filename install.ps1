# AudioShelf one-shot installer for Windows.
#
#   irm https://raw.githubusercontent.com/mcroney531-ctrl/Audio-shelf/claude/self-hosted-audible-pwa-dhhhoi/install.ps1 | iex
#
# or, from a downloaded copy:
#   .\install.ps1 -Path "D:\Apps"
#
# It picks a folder you can actually write to, installs Node if it is missing
# (and fixes PATH in this session, so no reopening the terminal), downloads the
# project without needing git, and hands over to start.ps1.
[CmdletBinding()]
param(
  [string]$Path,
  [string]$Branch = 'claude/self-hosted-audible-pwa-dhhhoi',
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$Repo = 'mcroney531-ctrl/Audio-shelf'
$IsWin = $env:OS -eq 'Windows_NT'

try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

function Write-Step($message) { Write-Host "`n$message" -ForegroundColor Cyan }
function Write-Note($message) { Write-Host "  $message" -ForegroundColor DarkGray }
function Write-Bad($message) { Write-Host $message -ForegroundColor Red }

function Test-Writable([string]$dir) {
  try {
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force -ErrorAction Stop | Out-Null }
    $probe = Join-Path $dir ('.audioshelf-write-test-' + [guid]::NewGuid().ToString('N'))
    [System.IO.File]::WriteAllText($probe, 'ok')
    Remove-Item $probe -Force
    return $true
  } catch {
    return $false
  }
}

# --- where to put it --------------------------------------------------------
# The user profile root is often not writable (Controlled Folder Access, or a
# managed profile), so try the usual suspects and use the first that works.
Write-Step 'Choosing an install folder'
$candidates = @()
if ($Path) { $candidates += $Path }
$candidates += @(
  (Join-Path $HOME 'Documents'),
  $env:LOCALAPPDATA,
  $HOME,
  $env:TEMP
) | Where-Object { $_ }

$parent = $null
foreach ($candidate in $candidates) {
  if (Test-Writable $candidate) { $parent = $candidate; break }
  Write-Note "not writable: $candidate"
}
if (-not $parent) {
  Write-Bad 'Could not find a writable folder.'
  Write-Note 'Re-run with an explicit path, e.g.  .\install.ps1 -Path "D:\Apps"'
  return
}

$target = if ($Path -and $parent -eq $Path -and (Split-Path $Path -Leaf) -eq 'AudioShelf') { $Path }
          else { Join-Path $parent 'AudioShelf' }
Write-Note $target

# --- Node -------------------------------------------------------------------
function Sync-PathFromRegistry {
  if (-not $IsWin) { return }
  $machine = [Environment]::GetEnvironmentVariable('PATH', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('PATH', 'User')
  $env:PATH = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

function Get-NodeVersion {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { return $null }
  try { return (& node -e 'process.stdout.write(process.versions.node)') } catch { return $null }
}

function Test-NodeNewEnough([string]$version) {
  if (-not $version) { return $false }
  $parts = $version.Split('.')
  return -not ([int]$parts[0] -lt 22 -or ([int]$parts[0] -eq 22 -and [int]$parts[1] -lt 5))
}

Write-Step 'Checking Node.js'
$nodeVersion = Get-NodeVersion
if (-not (Test-NodeNewEnough $nodeVersion)) {
  if ($nodeVersion) { Write-Note "found Node $nodeVersion, which is older than the required 22.5" }
  else { Write-Note 'not installed' }

  if ($IsWin -and (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Note 'installing via winget (accept the prompt if one appears)'
    & winget install --id OpenJS.NodeJS.LTS --exact --silent `
      --accept-source-agreements --accept-package-agreements
    Sync-PathFromRegistry
    # winget does not touch PATH in an already-open session; add the default
    # install location too, in case the registry copy has not caught up.
    $default = Join-Path $env:ProgramFiles 'nodejs'
    if ((Test-Path $default) -and ($env:PATH -notlike "*$default*")) { $env:PATH = "$default;$env:PATH" }
    $nodeVersion = Get-NodeVersion
  }

  if (-not (Test-NodeNewEnough $nodeVersion)) {
    Write-Bad 'Node 22.5 or newer is required and could not be installed automatically.'
    Write-Note 'Install it from https://nodejs.org, then run this script again.'
    return
  }
}
Write-Note "Node $nodeVersion"

# --- get the code -----------------------------------------------------------
Write-Step 'Downloading AudioShelf'
$git = Get-Command git -ErrorAction SilentlyContinue

if (Test-Path (Join-Path $target '.git')) {
  Write-Note 'already cloned - pulling the latest'
  & git -C $target pull --ff-only
} elseif (Test-Path (Join-Path $target 'package.json')) {
  Write-Note 'already downloaded - keeping what is there'
} elseif ($git) {
  & git clone --branch $Branch --depth 1 "https://github.com/$Repo.git" $target
  if ($LASTEXITCODE -ne 0) { Write-Bad 'git clone failed.'; return }
} else {
  # No git? Take the zip instead.
  $zip = Join-Path ([System.IO.Path]::GetTempPath()) 'audioshelf.zip'
  $stage = Join-Path ([System.IO.Path]::GetTempPath()) ('audioshelf-' + [guid]::NewGuid().ToString('N'))
  Write-Note 'git is not installed - fetching the zip instead'
  Invoke-WebRequest -Uri "https://codeload.github.com/$Repo/zip/refs/heads/$Branch" -OutFile $zip -UseBasicParsing
  Expand-Archive -Path $zip -DestinationPath $stage -Force
  $inner = Get-ChildItem -Path $stage -Directory | Select-Object -First 1
  if (-not $inner) { Write-Bad 'The download looked empty.'; return }
  New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
  Move-Item -Path $inner.FullName -Destination $target
  Remove-Item $zip, $stage -Recurse -Force -ErrorAction SilentlyContinue
}

# --- hand over --------------------------------------------------------------
$starter = Join-Path $target 'start.ps1'
if (-not (Test-Path $starter)) {
  Write-Bad "start.ps1 is missing from $target - the download may be incomplete."
  return
}

# A shortcut, so starting it later never means remembering this path. Never let
# a cosmetic step abort the install.
$shortcut = Join-Path $target 'scripts\create-shortcut.ps1'
if (Test-Path $shortcut) {
  try { & $shortcut -Quiet } catch { Write-Note "could not create a shortcut ($($_.Exception.Message))" }
}

if ($NoStart) {
  Write-Step 'Done'
  Write-Note "cd `"$target`""
  Write-Note '.\start.ps1'
  Write-Note 'or double-click the AudioShelf shortcut on your Desktop'
  return
}

Write-Step 'Handing over to start.ps1'
& $starter
