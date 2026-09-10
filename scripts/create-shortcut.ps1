# Puts an "AudioShelf" shortcut on the Desktop (and in the Start Menu) so
# starting the server does not mean remembering where the project lives.
#
#   .\scripts\create-shortcut.ps1
#   .\scripts\create-shortcut.ps1 -Remove
[CmdletBinding()]
param(
  [switch]$Remove,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$starter = Join-Path $root 'start.ps1'
# GetFolderPath returns an empty string off Windows, and Join-Path throws on it.
$desktop = [Environment]::GetFolderPath('Desktop')
$startMenu = [Environment]::GetFolderPath('StartMenu')
$targets = @()
if ($desktop) { $targets += (Join-Path $desktop 'AudioShelf.lnk') }
if ($startMenu) { $targets += (Join-Path $startMenu 'Programs\AudioShelf.lnk') }

function Say($message, $colour = 'DarkGray') {
  if (-not $Quiet) { Write-Host $message -ForegroundColor $colour }
}

if (-not $targets) {
  Say 'No Desktop or Start Menu folder on this system; nothing to do.' 'Yellow'
  return
}

if ($Remove) {
  foreach ($target in $targets) {
    if (Test-Path $target) { Remove-Item $target -Force; Say "removed $target" }
  }
  return
}

if (-not (Test-Path $starter)) {
  Write-Host "Cannot find start.ps1 (looked in $root)." -ForegroundColor Red
  return
}

try {
  $shell = New-Object -ComObject WScript.Shell
} catch {
  Say 'Shortcuts need Windows; skipping.' 'Yellow'
  return
}

foreach ($target in $targets) {
  $parent = Split-Path $target -Parent
  if (-not (Test-Path $parent)) { continue }
  try {
    $link = $shell.CreateShortcut($target)
    $link.TargetPath = (Get-Command powershell.exe).Source
    $link.Arguments = "-NoExit -NoProfile -ExecutionPolicy Bypass -File `"$starter`""
    $link.WorkingDirectory = $root
    $link.Description = 'Start the AudioShelf audiobook server'
    $icon = Join-Path $root 'web\icons\favicon-32.png'
    # .lnk files want an .ico or an exe; fall back to the PowerShell icon.
    $link.IconLocation = if (Test-Path ($icon -replace '\.png$', '.ico')) {
      ($icon -replace '\.png$', '.ico')
    } else {
      "$((Get-Command powershell.exe).Source),0"
    }
    $link.Save()
    Say "created $target"
  } catch {
    Say "could not create $target ($($_.Exception.Message))" 'Yellow'
  }
}

Say 'Double-click "AudioShelf" on your Desktop to start the server.' 'Green'
