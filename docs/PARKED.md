# Parked work

Where things stand, so nothing is forgotten between sessions. Last updated 2026-11-12.

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
  ```
  Keep the stick private: it holds the account database and the server's session secret.
- **GitHub access checked 2026-11-12:** `git fetch` and `git pull` on the PC work without a
  prompt, so the key revocations did not affect this project.

## Next, in order

1. **Final phone check** - the app was reinstalled 2026-10-30. Still to confirm: a middle and a
   late chapter seek to the right place, and one offline download (a short book) plays with the
   network off.
2. **Decide the permanent URL** - no rush, but before downloading many books for offline
   listening on the phone. Progress, bookmarks and the account live on the server and survive a
   change; the installed app, sign-in and offline downloads would need redoing. Keeping the
   current `ts.net` address is a fine answer. Alternatives: Tailscale Services (needs the PC to
   become a *tagged* device, which changes how it appears for SSH and file sharing), renaming
   the machine or tailnet, Tailscale Funnel (public), Cloudflare Tunnel with a domain.

## Exploring

- **Audiobooks.com** - no official export, but the browser-player route works. Tested
  2026-11-12 on *Chain of Command* (purchased): the web player streams one complete MP3 named by
  ISBN; saved via DevTools -> Network -> Media -> open in new tab -> Download. 7:22:35 against a
  listed 7:22:40, played to the end, and it arrives already tagged (author and book title), so
  no ffmpeg step is needed. File it as `library/<Author>/<Title>/<Title>.mp3`; it has no chapter
  marks or cover art. Their terms prohibit this, so the risk is to the account: purchased titles
  only (VIP titles are rentals), at a normal pace, one at a time. No bulk downloader, and no
  third-party tools holding login cookies. Audible's reconcile does not cover these, so keep
  a simple list of what has been moved.
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

- Tailscale on the PC: switch on **Run unattended** (tray icon), so a restart doesn't drop it.
- Optional: delete the leftover `.voucher` files in the library folder.
- Optional: remove the four silent demo books from setup by deleting `library\Hollis Vance`,
  `library\Idris Farrow` and `library\Wren Okonkwo`. (`social_01_adams_64kb.mp3` is a real
  LibriVox recording.)
- Optional: review AudioShelf API tokens in Settings and revoke any you don't recognise.
- Audible activation bytes are still blocked (CloudFront 403). Not needed: every book came as
  AAXC with its own voucher.

## Ideas for later

- **Cable-TV-style channels** over a video library: a scheduler that writes an M3U playlist and
  an XMLTV guide for Jellyfin's Live TV. Tunarr and ErsatzTV already do this - try one first.
- **The Plex question:** the real blocker was the PC having to stay on and a flaky external
  drive, not the software. An always-on mini PC was the suggestion.
