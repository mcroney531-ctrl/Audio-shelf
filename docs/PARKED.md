# Parked work

Where things stand, so nothing is forgotten between sessions. Last updated 2026-11-15.

## Done

- **Audible migration: complete.** 27 library entries: 25 converted, verified and on the shelf;
  2 excluded on purpose (*Doing Time Like a Spy* - no longer downloadable; *Art as Experience* -
  not wanted, listed in `excluded.txt`). The shelf held 30 books after it (31 with *Chain of Command*). Originals deleted after
  verification. Re-check any time with `npm run cli -- import:reconcile --library=library.json
  --exclude=excluded.txt`.
- **Backup: done 2026-11-12** to a 64 GB USB stick as `D:\AudioShelf-backup` - 187 files,
  12.9 GB, none failed. To refresh it after adding books (copies only what changed), from the
  AudioShelf folder:
  ```powershell
  Stop-ScheduledTask -TaskName AudioShelf
  .\scripts\stop.ps1                      # wait for "Port 8080 is free."
  robocopy "C:\Users\Trevor Newsome\Documents\AudioShelf" "D:\AudioShelf-backup" /E /XD node_modules .git /R:2 /W:5
  Start-ScheduledTask -TaskName AudioShelf
  Start-Sleep -Seconds 30                 # startup takes longer than 5 seconds
  Test-NetConnection 127.0.0.1 -Port 8080 | Select-Object TcpTestSucceeded   # must say True
  ```
  The first time, the server never came back up after the copy, and the phone showed HTTP 502
  (Tailscale reached the PC, nothing answered on 8080). Task result `267014` = stopped by user;
  `267009` = running. If the check says False, wait and re-run it rather than starting a second copy.
  Keep the stick private: it holds the account database and the server's session secret.
- **Audiobooks.com migration: done 2026-11-15.** 18 of the 22 owned titles are on the shelf and
  logged in `audiobooks-com.txt`; the other 4 (*Prequel*, *The Assault on Intelligence*,
  *Betrayal*, *Tired of Winning*) were left off on purpose. 6 files came with no tags at all;
  they were matched to the checklist by length, confirmed by ear from the narrator's opening,
  and filed with `-Files -Author -Title`. The checklist is not reliable: it had *Power Wars* as
  11:00 (the file is a genuine 27:40) and the wrong author for *Intelligence Matters*.
  Backup refreshed 2026-11-15: 38 MP3s, 7.2 GB, matching the library.
- **Tidy-up 2026-11-15:** demo books and the LibriVox sample removed from the library; Tailscale
  set to **Run unattended** (`tailscale debug prefs` shows `"ForceDaemon": true`). AudioShelf
  itself still starts only when Trevor Newsome logs in.
- **Phone check passed 2026-11-12:** middle and late chapter seeks land correctly on converted
  books, and a downloaded book plays in airplane mode after a full app restart. Migration wrapped up.
- **GitHub access checked 2026-11-12:** `git fetch` and `git pull` on the PC work without a
  prompt, so the key revocations did not affect this project.

## Next, in order

1. **Decide the permanent URL** - no rush, but before downloading many books for offline
   listening on the phone. Progress, bookmarks and the account live on the server and survive a
   change; the installed app, sign-in and offline downloads would need redoing. Keeping the
   current `ts.net` address is a fine answer. Alternatives: Tailscale Services (needs the PC to
   become a *tagged* device, which changes how it appears for SSH and file sharing), renaming
   the machine or tailnet, Tailscale Funnel (public), Cloudflare Tunnel with a domain.

## Exploring

- **Audiobooks.com, if more are bought later** - the browser-player route: DevTools -> Network ->
  Media -> open in new tab -> Download gives one complete MP3 named by ISBN, no chapter marks or
  cover art. Their terms prohibit this, so the risk is to the account: purchased titles only, at
  a normal pace, no bulk downloader, no third-party tools holding login cookies. Then
  `.\scripts\file-audiobooks.ps1 -DryRun`, and the same without `-DryRun`. Untagged files need
  `-Files <path> -Author <name> -Title <title>`; listen to the opening to confirm which book it is.
- **Text to speech** - the Generate tab is built but has never made a real call.
  - *Google Cloud TTS (built):* needs the API enabled, a billing card on the project (the free
    tier still applies), and a key pasted into Generate. Test with one short paragraph; expect a
    small fix on the first real call.
  - *VoiceStudio (local, free):* needs about 5-10 GB of disk. Check the graphics card first
    (`Get-CimInstance Win32_VideoController | Select-Object Name`) - without NVIDIA it runs on
    the CPU, several times slower. Try it standalone on a short text before any integration;
    it has a local API on port 3900 that Generate could use later. AudioShelf stays stock
    voices only - no cloning.

## Small things

- Optional: delete the 25 leftover `.voucher` files in the library folder.
- Optional: review AudioShelf API tokens in Settings and revoke any you don't recognise.
- Audible activation bytes are still blocked (CloudFront 403). Not needed: every book came as
  AAXC with its own voucher.

## Ideas for later

- **Cable-TV-style channels** over a video library: a scheduler that writes an M3U playlist and
  an XMLTV guide for Jellyfin's Live TV. Tunarr and ErsatzTV already do this - try one first.
- **The Plex question:** the real blocker was the PC having to stay on and a flaky external
  drive, not the software. An always-on mini PC was the suggestion.
