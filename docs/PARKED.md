# Parked work

Where things stand, so nothing is forgotten between sessions. Last updated 2026-11-09.

## Done

- **Audible migration: complete.** 27 library entries: 25 converted, verified and on the shelf;
  2 excluded on purpose (*Doing Time Like a Spy* - no longer downloadable; *Art as Experience* -
  not wanted, listed in `excluded.txt`). The shelf holds 30 books. Originals deleted after
  verification. Re-check any time with `npm run cli -- import:reconcile --library=library.json
  --exclude=excluded.txt`.

## Next, in order

1. **Back up** - blocked until a drive is available (the external one is misbehaving; a USB stick
   of 16 GB or more also works). The converted books may now be the only dependable copies:
   Audible can withdraw titles. Find the drive's letter with `Get-Volume`, then from the
   AudioShelf folder:
   ```powershell
   Stop-ScheduledTask -TaskName AudioShelf
   .\scripts\stop.ps1                      # wait for "Port 8080 is free."
   robocopy "C:\Users\Trevor Newsome\Documents\AudioShelf" "<letter>:\AudioShelf-backup" /E /XD node_modules .git /R:2 /W:5
   Start-ScheduledTask -TaskName AudioShelf
   ```
2. **Check the PC can still pull from GitHub** after the key revocations: `git fetch` in the
   AudioShelf folder. A login prompt or an authentication error means a revoked token was stored
   there. (The repository history was scanned: no secrets were ever committed.)
3. **Decide the permanent URL** before downloading books for offline listening on the phone -
   offline downloads belong to the address and would need redoing after a change. Keeping the
   current `ts.net` address is a fine answer. Alternatives: Tailscale Services (needs the PC to
   become a *tagged* device, which changes how it appears for SSH and file sharing), renaming
   the machine or tailnet, Tailscale Funnel (public), Cloudflare Tunnel with a domain.
4. **Final phone check** - the app was reinstalled 2026-10-30. Still to confirm: a middle and a
   late chapter seek to the right place, and one offline download plays with the network off.

## Exploring

- **Audiobooks.com** - no official export. One-book test only: save a purchased title's audio
  from the browser player. Passes if its length matches the listed runtime and it plays end to
  end; then tag it with ffmpeg and file it as `library/<Author>/<Title>/<Title>.mp3`. If it
  fails, stop there. No bulk downloader, no VIP titles, no third-party tools holding cookies.
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
- Optional: review AudioShelf API tokens in Settings and revoke any you don't recognise.
- Audible activation bytes are still blocked (CloudFront 403). Not needed: every book came as
  AAXC with its own voucher.

## Ideas for later

- **Cable-TV-style channels** over a video library: a scheduler that writes an M3U playlist and
  an XMLTV guide for Jellyfin's Live TV. Tunarr and ErsatzTV already do this - try one first.
- **The Plex question:** the real blocker was the PC having to stay on and a flaky external
  drive, not the software. An always-on mini PC was the suggestion.
