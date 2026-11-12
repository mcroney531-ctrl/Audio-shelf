# Files MP3 audiobooks saved from a browser player onto the AudioShelf shelf.
#
#   .\scripts\file-audiobooks.ps1 -DryRun          # show the plan, move nothing
#   .\scripts\file-audiobooks.ps1                  # show the plan, ask, then move
#   .\scripts\file-audiobooks.ps1 -From "C:\Users\Someone\Downloads"
#   .\scripts\file-audiobooks.ps1 -Files "D:\x\book.mp3" -Author "A. Writer" -Title "A Book"
#
# It looks for ISBN-named MP3s (9781234567890.mp3) in the Downloads folder, reads
# author, title and length from each file's own tags with ffprobe, checks the length
# against audiobooks-com-checklist.csv when that exists, then moves each book to
#   <library>\<Author>\<Title>\<Title>.mp3
# and adds a line to audiobooks-com.txt. It never downloads anything, never changes
# the audio, and moves nothing until you say yes.
#
# The checklist is optional: a CSV with the columns Title, Author, Runtime (and
# optionally Type). Runtime may be "7:22:40" or "7 hrs 22 mins".
[CmdletBinding()]
param(
  [string]$From,
  [string[]]$Files,
  [string]$Author,
  [string]$Title,
  [string]$Checklist,
  [switch]$DryRun,
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Write-Note($message) { Write-Host "  $message" -ForegroundColor DarkGray }
function Write-Warn($message) { Write-Host "  $message" -ForegroundColor Yellow }

function Format-Length([double]$seconds) {
  $t = [TimeSpan]::FromSeconds([math]::Round($seconds))
  return '{0}:{1:00}:{2:00}' -f [int][math]::Floor($t.TotalHours), $t.Minutes, $t.Seconds
}

# "7:22:40", "22:40", "7 hrs and 22 mins", "7h 22m 40s" -> seconds, or $null.
function ConvertTo-Seconds([string]$text) {
  if (-not $text) { return $null }
  $text = $text.Trim()
  if ($text -match '^(\d+):(\d{1,2}):(\d{1,2})$') { return [int]$Matches[1] * 3600 + [int]$Matches[2] * 60 + [int]$Matches[3] }
  if ($text -match '^(\d+):(\d{1,2})$') { return [int]$Matches[1] * 60 + [int]$Matches[2] }
  $total = 0; $found = $false
  foreach ($m in [regex]::Matches($text.ToLower(), '(\d+)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)\b')) {
    $n = [int]$m.Groups[1].Value; $found = $true
    switch -regex ($m.Groups[2].Value) {
      '^h' { $total += $n * 3600 }
      '^m' { $total += $n * 60 }
      '^s' { $total += $n }
    }
  }
  if ($found) { return $total }
  return $null
}

# A name Windows accepts as a folder or file: no \ / : * ? " < > |, no trailing
# dots or spaces, at most 80 characters, cut at a word where possible.
function ConvertTo-PathName([string]$name) {
  $name = $name -replace '\s*:\s*', ' - '
  $name = $name -replace '[\\/*?"<>|]', ''
  $name = ($name -replace '[\x00-\x1f]', '' -replace '\s+', ' ').Trim()
  if ($name.Length -gt 80) {
    $cut = $name.Substring(0, 80)
    $space = $cut.LastIndexOf(' ')
    if ($space -gt 40) { $cut = $cut.Substring(0, $space) }
    $name = $cut.TrimEnd(' ', ',', ';', '-')
  }
  $name = $name.TrimEnd('.', ' ')
  if ($name -in @('CON', 'PRN', 'AUX', 'NUL') -or $name -match '^(COM|LPT)\d$') { $name = "$name book" }
  return $name
}

# For matching a file's title against the checklist: letters and digits only,
# subtitle dropped, a leading "The"/"A"/"An" ignored.
function ConvertTo-MatchKey([string]$title) {
  $main = ($title -split '[:(\[]')[0].ToLower()
  $main = $main -replace '^\s*(the|a|an)\s+', ''
  return ($main -replace '[^a-z0-9]', '')
}

# --- settings ---------------------------------------------------------------
$settings = @{}
$envFile = Join-Path $root '.env'
if (Test-Path -LiteralPath $envFile) {
  foreach ($line in Get-Content -LiteralPath $envFile) {
    if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') { $settings[$Matches[1]] = $Matches[2].Trim().Trim('"') }
  }
}

$library = $settings['AUDIOSHELF_LIBRARY']
if (-not $library) { $library = 'library' }
if (-not [System.IO.Path]::IsPathRooted($library)) { $library = Join-Path $root $library }
if (-not (Test-Path -LiteralPath $library)) {
  Write-Host "The library folder does not exist: $library" -ForegroundColor Red
  exit 1
}

$ffprobe = $settings['AUDIOSHELF_FFPROBE']
if (-not $ffprobe) {
  $found = Get-Command ffprobe -ErrorAction SilentlyContinue
  if ($found) { $ffprobe = $found.Source }
}
if (-not $ffprobe -or -not (Get-Command $ffprobe -ErrorAction SilentlyContinue)) {
  Write-Host 'ffprobe was not found. It comes with ffmpeg: winget install Gyan.FFmpeg' -ForegroundColor Red
  Write-Note 'Or set AUDIOSHELF_FFPROBE in .env to its full path.'
  exit 1
}

$logFile = Join-Path $root 'audiobooks-com.txt'
if (-not $Checklist) { $Checklist = Join-Path $root 'audiobooks-com-checklist.csv' }

$expected = @{}
if (Test-Path -LiteralPath $Checklist) {
  foreach ($row in Import-Csv -LiteralPath $Checklist) {
    if (-not $row.Title) { continue }
    $seconds = ConvertTo-Seconds $row.Runtime
    $key = ConvertTo-MatchKey $row.Title
    if ($key) { $expected[$key] = [pscustomobject]@{ Title = $row.Title; Seconds = $seconds; Type = $row.Type } }
  }
  Write-Note "Checklist: $($expected.Count) titles from $(Split-Path -Leaf $Checklist)"
} else {
  Write-Note 'No checklist found, so lengths cannot be compared with the listed runtime.'
}

# --- which files ------------------------------------------------------------
if ($Files) {
  $sources = @(foreach ($f in $Files) { Get-Item -LiteralPath $f })
} else {
  if (-not $From) { $From = Join-Path $HOME 'Downloads' }
  Write-Note "Looking in $From"
  if (-not (Test-Path -LiteralPath $From)) {
    Write-Host "That folder does not exist. Pass the right one with -From." -ForegroundColor Red
    exit 1
  }
  $sources = @(Get-ChildItem -LiteralPath $From -File -Filter '*.mp3' |
    Where-Object { $_.Name -match '^(97[89])?\d{9}[\dXx]( \(\d+\))?\.mp3$' } |
    Sort-Object LastWriteTime)
}

if (-not $sources.Count) {
  Write-Host "`nNo ISBN-named MP3s found." -ForegroundColor Yellow
  Write-Note 'If the browser saves somewhere else (another Windows profile, say),'
  Write-Note 'pass that folder: .\scripts\file-audiobooks.ps1 -From "C:\Users\<name>\Downloads"'
  exit 0
}
if (($Author -or $Title) -and $sources.Count -ne 1) {
  Write-Host '-Author and -Title apply to one file at a time; pass it with -Files.' -ForegroundColor Red
  exit 1
}

# --- plan -------------------------------------------------------------------
$plan = @()
$claimed = @{}
foreach ($file in $sources) {
  # Windows PowerShell 5.1 turns a native tool's stderr into a terminating
  # error under 'Stop', so relax it for this one call.
  $ErrorActionPreference = 'Continue'
  $probe = & $ffprobe -v error -print_format json -show_entries 'format=duration:format_tags' $file.FullName 2>$null
  $ErrorActionPreference = 'Stop'
  if ($LASTEXITCODE -ne 0 -or -not $probe) {
    $plan += [pscustomobject]@{ File = $file; Problem = 'ffprobe cannot read it (incomplete download?)' }
    continue
  }
  $format = ($probe | Out-String | ConvertFrom-Json).format
  $tags = @{}
  if ($format.tags) { foreach ($p in $format.tags.PSObject.Properties) { $tags[$p.Name.ToLower()] = "$($p.Value)".Trim() } }

  $bookAuthor = $Author
  if (-not $bookAuthor) { $bookAuthor = $tags['album_artist'] }
  if (-not $bookAuthor) { $bookAuthor = $tags['artist'] }
  if (-not $bookAuthor) { $bookAuthor = $tags['composer'] }
  if ($bookAuthor) { $bookAuthor = ($bookAuthor -split '\s*[;/]\s*')[0] }

  $bookTitle = $Title
  if (-not $bookTitle) { $bookTitle = $tags['album'] }
  if (-not $bookTitle) { $bookTitle = $tags['title'] }

  $seconds = [double]$format.duration
  $entry = [pscustomobject]@{
    File = $file; Author = $bookAuthor; Title = $bookTitle; Seconds = $seconds
    Listed = $null; Destination = $null; Problem = $null; Warning = $null
  }

  if (-not $bookAuthor -or -not $bookTitle) {
    $entry.Problem = 'no author/title tags - re-run with -Files, -Author and -Title'
    $plan += $entry; continue
  }

  $match = $expected[(ConvertTo-MatchKey $bookTitle)]
  if ($match) {
    $entry.Listed = $match.Seconds
    if ($match.Type -and $match.Type -match 'vip|rent|borrow') {
      $entry.Problem = "the checklist marks it '$($match.Type)' - purchased titles only"
    } elseif ($match.Seconds) {
      $short = $match.Seconds - $seconds
      $allowed = [math]::Max(120, $match.Seconds * 0.02)
      if ($short -gt $allowed) {
        $entry.Problem = "$(Format-Length $short) shorter than listed - likely a cut-off download"
      } elseif (-$short -gt $allowed) {
        $entry.Warning = "$(Format-Length (-$short)) longer than listed - check it is the right book"
      }
    }
  } elseif ($expected.Count) {
    $entry.Warning = 'not in the checklist - compare the length by hand'
  }

  $authorDir = ConvertTo-PathName $bookAuthor
  $titleName = ConvertTo-PathName $bookTitle
  $folder = Join-Path (Join-Path $library $authorDir) $titleName
  $entry.Destination = Join-Path $folder "$titleName.mp3"
  if (-not $entry.Problem) {
    if (Test-Path -LiteralPath $entry.Destination) {
      $entry.Problem = 'already on the shelf (duplicate download?)'
    } elseif ($claimed.ContainsKey($entry.Destination.ToLower())) {
      $entry.Problem = "same book as $($claimed[$entry.Destination.ToLower()]) - a duplicate download"
    } elseif ((Test-Path -LiteralPath $folder) -and (Get-ChildItem -LiteralPath $folder -File | Where-Object { $_.Extension -match '^\.(mp3|m4a|m4b|aac|ogg|opus|flac|wav)$' })) {
      # A second audio file in a book's folder would make it a two-part book.
      $entry.Problem = "its folder already holds other audio: $folder"
    } else {
      $claimed[$entry.Destination.ToLower()] = $file.Name
    }
  }
  $plan += $entry
}

Write-Host ''
$ready = @($plan | Where-Object { -not $_.Problem })
foreach ($entry in $plan) {
  if ($entry.Problem) {
    Write-Host "SKIP  $($entry.File.Name)" -ForegroundColor Yellow
    if ($entry.Title) { Write-Note "$($entry.Author) - $($entry.Title)  [$(Format-Length $entry.Seconds)]" }
    Write-Warn $entry.Problem
  } else {
    $listed = ''
    if ($entry.Listed) { $listed = "  (listed $(Format-Length $entry.Listed))" }
    Write-Host "FILE  $($entry.File.Name)" -ForegroundColor Green
    Write-Note "$($entry.Author) - $($entry.Title)  [$(Format-Length $entry.Seconds)]$listed"
    Write-Note "-> $($entry.Destination.Substring($library.Length).TrimStart('\', '/'))"
    if ($entry.Warning) { Write-Warn $entry.Warning }
  }
}

if (-not $ready.Count) { Write-Host "`nNothing to file." -ForegroundColor Yellow; exit 0 }
if ($DryRun) { Write-Host "`nDry run: nothing was moved." -ForegroundColor Cyan; exit 0 }
if (-not $Yes) {
  $answer = Read-Host "`nFile $($ready.Count) book(s) into $library ? [y/N]"
  if ($answer -notmatch '^(y|yes)$') { Write-Host 'Nothing was moved.'; exit 0 }
}

# --- move -------------------------------------------------------------------
$done = 0
foreach ($entry in $ready) {
  try {
    $folder = Split-Path -Parent $entry.Destination
    New-Item -ItemType Directory -Force -Path $folder | Out-Null
    # Through a .part name first: the server's watcher ignores those, so it never
    # scans a file that is still being copied (Downloads on another drive).
    $part = "$($entry.Destination).part"
    Move-Item -LiteralPath $entry.File.FullName -Destination $part
    Move-Item -LiteralPath $part -Destination $entry.Destination
    $line = "{0:yyyy-MM-dd}`t{1}`t{2}`t{3}`t{4}" -f (Get-Date), $entry.File.Name, $entry.Author, $entry.Title, (Format-Length $entry.Seconds)
    [System.IO.File]::AppendAllLines($logFile, [string[]]@($line))
    $done++
  } catch {
    Write-Host "Could not file $($entry.File.Name): $($_.Exception.Message)" -ForegroundColor Red
  }
}

Write-Host "`nFiled $done of $($ready.Count). The server adds them to the shelf within a few seconds." -ForegroundColor Green
Write-Note "Recorded in $(Split-Path -Leaf $logFile)."
