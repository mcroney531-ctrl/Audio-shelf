# AudioShelf — notes for Claude

A self-hosted audiobook server with an offline-capable PWA player. Node on the
back, hand-written ES modules on the front, one npm dependency.

## Commands

```bash
npm start                    # serve (reads .env, then env vars)
npm test                     # integration tests: real server, temp library
npm run cli -- scan          # rescan the library
npm run cli -- user:list | user:add | user:password | stats
npm run cli -- import:list | import --all | import:activation --set=1a2b3c4d
npm run seed:demo            # silent, tagged MP3s to click around in
npm run icons                # regenerate the PWA icon set
```

Windows has its own launchers: `start.ps1` (also `-Library`, `-Port`,
`-TrustProxy`), `install.ps1` (one-shot setup), `scripts/stop.ps1` (find the
server by port when its window is gone), `scripts/install-task.ps1` (run at
logon), `scripts/create-shortcut.ps1`.

## Shape of it

```
server/     node:http + node:sqlite, no framework
  config.js   env + .env, Node version guard. Loaded first, so guards live here
  db.js       schema and migrations; migrate() runs on import
  scanner.js  walks library roots, groups files into books, reads tags
  watcher.js  fs.watch over the library, debounced rescan
  files.js    static serving and byte-range streaming
  upload.js   raw-body uploads, path sanitising
  audible.js  ffmpeg wrapper for .aax/.aaxc conversion
  api.js      the JSON routes; index.js owns streaming and upload routes
web/        no build step. ES modules, custom CSS, self-hosted fonts
  sw.js       app shell, API fallback, media cache with synthesised 206s
tests/      node:test against a spawned server on a throwaway library
```

## Conventions that matter

- **No build step, no framework.** `web/` is served as-is. Keep it that way:
  editing a file and reloading is the whole dev loop.
- **One dependency** (`music-metadata`). Think hard before adding a second.
  SQLite, env parsing and the HTTP server are all built into Node.
- **Node 22.5+** for `node:sqlite`. `config.js` fails with a readable message
  below that, and it must stay the first import so the check runs early.
- Audio is **never transcoded**. Files are streamed as they are.
- Tests spawn a real server over a temp library. They are integration tests by
  choice — the interesting bugs here are in wiring, not in units.

## Things that bit us, so they don't again

**A running server serves new static files but old routes.** `web/` is read
from disk per request, so a stale process shows the new UI with the old API and
produces confusing 404s. Restart the server after pulling.

**PowerShell scripts cannot be properly tested from a Linux sandbox.** They can
be parsed (`[Parser]::ParseFile`) and pwsh can run the Linux-safe parts, but
`Get-NetIPAddress`, `Get-NetTCPConnection`, scheduled-task cmdlets and COM
objects only exist on Windows. Every one of those has shipped broken at least
once. Guard them with `Get-Command … -ErrorAction SilentlyContinue`, and say
plainly when something is unverified rather than implying it was tested.

Specific PowerShell traps already paid for:
- `$pid` is a **read-only automatic variable** — naming a loop variable that
  throws at runtime while parsing fine.
- `Set-Content -Encoding UTF8` writes a **BOM** on Windows PowerShell 5.1,
  which corrupts the first key of a `.env`. Use
  `[System.IO.File]::WriteAllLines`.
- `-ErrorAction SilentlyContinue` does **not** swallow a missing cmdlet.
- PowerShell has no `VAR=value command` syntax. Use `.env` or `$env:NAME =`.
- After a `winget install`, PATH is stale in the open session. Refresh it from
  the registry (`[Environment]::GetEnvironmentVariable('PATH','Machine')`)
  rather than telling anyone to reopen their terminal.

**Windows profiles can disagree.** On the machine this was built for, the shell
opens as one user while files live under another, so `$HOME`, `~` and
`$env:APPDATA` point somewhere unexpected and `Stop-Process` on another
profile's process is denied. Prefer explicit full paths; suggest an elevated
shell when a process cannot be stopped.

**A `100.64.0.0/10` address is not proof of anything.** It is carrier-grade NAT,
and also what WireGuard-based VPNs (Norton VPN, Tailscale) hand out. Read the
adapter name before drawing a conclusion — `start.ps1` prints them for exactly
this reason.

**"Connects but hangs" on that machine usually means a VPN or antivirus.** A
local VPN broke a Tailscale sign-in, made a tunnel's DNS time out, and dropped
QUIC streams. Antivirus can also block inbound connections to `node.exe`.

**`tailscale serve` cannot be sanity-checked from the machine serving it** —
connecting to your own tailnet address loops oddly and fails even when
everything is correct. Test from another device.

**Static hosts cannot run this.** It needs a process and a disk. Netlify,
Vercel and Pages are dead ends; `fly.toml`, `render.yaml` and the Dockerfile
are the supported routes, plus plain Node behind a tunnel.

## Deliberate limits

- **No transcoding.** Convert once with ffmpeg instead of paying per stream.
- **No key recovery for Audible files.** Imports decrypt with keys the user
  supplies from their own account. Never add key cracking or lookup.
- **One library root** (plus the imports folder the scanner also walks).
- **Uploads are admin-only**, extension allow-listed, size capped, and written
  to `.part` first so the watcher never scans a half-copied file. Keep all four.
