# AudioShelf

A self-hosted audiobook server with an installable, offline-capable PWA player —
your own Audible, running on your own box, reading your own files.

Point it at a folder of audiobooks. It reads the tags, builds a shelf, and serves
a player that remembers your position across every device you sign in on.

![The shelf](docs/screenshot-shelf.png)

| Now playing | On a phone |
| --- | --- |
| ![player](docs/screenshot-player.png) | ![mobile](docs/screenshot-mobile.png) |

## What it does

**Library**
- Scans a folder tree of `.m4b`, `.mp3`, `.m4a`, `.flac`, `.opus`, `.ogg`, `.aac`, `.wav`
- Reads title, author, narrator, series, year, genre, description and cover art from tags
- Chapters from embedded `m4b` chapter markers, or one chapter per file for multi-file books
- Incremental re-scans: unchanged books are fingerprinted and skipped
- Search and filter by title/author/narrator/series, in progress, finished, unstarted

**Player**
- Resumes to the second, per user, across devices — position is stored server-side
- Chapter list with jump-to, ±15s/30s skips, 0.5×–3× speed (remembered per book)
- Sleep timer (fixed minutes or end-of-chapter) with a 15-second fade-out
- Bookmarks with notes
- Lock-screen / car-stereo controls through the Media Session API
- Keyboard: <kbd>space</kbd> play/pause, <kbd>←</kbd>/<kbd>→</kbd> skip

**Offline**
- Installable PWA (iOS, Android, desktop)
- Download a book to the device; the service worker serves it from Cache Storage,
  including byte-range requests, so seeking works with the network off
- Listening position is queued while offline and synced when you reconnect

**Multi-user**
- First account created is the administrator; admins add listeners and trigger scans
- Each listener gets their own progress, bookmarks and finished shelf
- scrypt password hashing, HttpOnly session cookies, no third-party services

## Quick start

Requires **Node 22.5+** (it uses the built-in `node:sqlite`, so there is nothing to compile).

```bash
git clone https://github.com/mcroney531-ctrl/Audio-shelf.git
cd Audio-shelf
npm install

# Optional: a demo library of silent, tagged files to click around in
npm run seed:demo

AUDIOSHELF_LIBRARY=/path/to/audiobooks npm start
```

Open <http://localhost:8080> and create the first account — that one is the admin.

### Docker

```bash
# edit the library path in docker-compose.yml first
docker compose up -d
```

### Install it on your phone

Open the server's URL in the phone's browser, then *Add to Home Screen*. It runs
full-screen, keeps playing with the screen off, and shows up on the lock screen.
For iOS the site must be served over HTTPS (or `localhost`) for the service worker
and downloads to work — put it behind a reverse proxy with a certificate.

## How the library should look

One folder per book is the rule. Everything else is a fallback.

```
audiobooks/
├── Idris Farrow/
│   ├── The Cartographer of Small Hours/
│   │   ├── 01 - Prologue.mp3
│   │   ├── 02 - The Ink Ledger.mp3
│   │   └── cover.jpg
│   └── A Field Guide to Vanishing/
│       └── field-guide.m4b            ← single-file book with embedded chapters
└── Salt Roads.m4b                     ← loose files at the root are their own books
```

Tags win over filenames. AudioShelf reads:

| Field | Tag |
| --- | --- |
| Title | `ALBUM` (falls back to the folder name) |
| Author | `ALBUMARTIST`, then `ARTIST`, then the parent folder name |
| Narrator | `COMPOSER` — the convention audiobook taggers use |
| Series | `MOVEMENTNAME`, `GROUPING`, or `TXXX:SERIES` |
| Series index | `MOVEMENT` or `TXXX:SERIES-PART` |
| Description | `DESCRIPTION` or `COMMENT` |
| Cover | Embedded art, else `cover.jpg` / `folder.jpg` / `front.jpg` in the folder |

Multi-file books are ordered by disc/track number, then by natural filename order.

## Configuration

Every setting is an environment variable (see `.env.example`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `AUDIOSHELF_LIBRARY` | `./library` | Folder to scan |
| `AUDIOSHELF_DATA` | `./data` | Database, covers, instance secret |
| `AUDIOSHELF_HOST` / `AUDIOSHELF_PORT` | `0.0.0.0` / `8080` | Listen address |
| `AUDIOSHELF_SCAN_ON_START` | `1` | Scan when the server boots |
| `AUDIOSHELF_SCAN_INTERVAL_MIN` | `0` | Re-scan every N minutes (0 = never) |
| `AUDIOSHELF_SESSION_DAYS` | `30` | Session lifetime |
| `AUDIOSHELF_TRUST_PROXY` | `0` | Read `X-Forwarded-Proto` for the Secure cookie flag |
| `AUDIOSHELF_SECRET` | generated | Session signing key; kept in `data/secret` if unset |

## Command line

```bash
npm run cli -- scan [--force]                                  # rescan the library
npm run cli -- user:add --username=sam --password=... [--admin]
npm run cli -- user:password --username=sam --password=...
npm run cli -- user:list
npm run cli -- stats
npm test                                                       # integration tests
npm run icons                                                  # regenerate PWA icons
```

## Behind a reverse proxy

Audio is streamed with byte ranges, so disable response buffering:

```nginx
location / {
    proxy_pass         http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header   Host $host;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_buffering    off;        # keep seeking snappy
    client_max_body_size 0;
}
```

Then set `AUDIOSHELF_TRUST_PROXY=1` so session cookies are marked `Secure`.

## How it is built

No frontend framework, no bundler, one runtime dependency.

```
server/     node:http + node:sqlite. config, db, auth, scanner, api, static/range file serving
web/        the PWA: ES modules, hand-rolled hyperscript, service worker, self-hosted fonts
scripts/    icon generator, demo library seeder (both dependency-free)
tests/      integration tests against a real server on a temp library
```

- `music-metadata` is the only dependency — it parses the tags.
- Audio is served as-is: no transcoding, no ffmpeg. Whatever your browser plays, plays.
- The database is a single SQLite file in `AUDIOSHELF_DATA`; back that up and you have
  everything except the audio.

## Deliberate limits

- **No transcoding.** A file your browser cannot decode will not play. Convert it once
  with ffmpeg instead of paying for it on every stream.
- **No Audible/AAX import.** AudioShelf plays files you already own in an open format.
- **One library root.** Symlink extra folders into it if you keep books on several disks.
- **No metadata providers.** Titles come from your tags; fix them with a tagger and re-scan.

## Licence

MIT.
