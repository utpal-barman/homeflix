# HomeFlix architecture and API contract

This file is the contract between the three parts of HomeFlix. If code and
this file disagree, fix one of them in the same change.

## Parts

| part | folder | runs where |
|------|--------|-----------|
| Server | `server/`, `bin/` | Node 18+ on the Mac, zero npm dependencies |
| Control panel | `web/admin/` | desktop browser on the Mac, `http://localhost:7788` |
| TV app | `web/tv/` | Smart TV browser, `http://<mac-ip>:8080` |

Two HTTP listeners in one Node process:

- **Control server** — `127.0.0.1:7788` only. Always on while HomeFlix is
  running. Serves `web/admin/`, every admin endpoint, and also every media
  endpoint (so the control panel can show thumbnails and previews even while
  the TV server is off).
- **TV server** — `0.0.0.0:<port>` (default `8080`). Exists only while the
  toggle is ON. Serves `web/tv/` and the media endpoints. Refuses any client
  whose address is not loopback / RFC1918 private / link-local / IPv6 ULA
  with `403`. Has no write endpoints except playback progress.

If a port is busy the server tries the next 20 ports and reports the one it
got in `status.port`.

## Files on disk

- Settings: `~/Library/Application Support/HomeFlix/config.json`
- Cache (thumbnails, resized photos, index): `~/Library/Caches/HomeFlix/`
- Playback progress: `~/Library/Application Support/HomeFlix/progress.json`
- Default library folder: `~/Movies/HomeFlix` (created on first run)
- `HOMEFLIX_HOME=<dir>` overrides all of the above to `<dir>/{config.json,
  progress.json,cache/,library/}` — used by tests.

`config.json`:
```json
{ "name": "HomeFlix", "port": 8080, "libraryFolder": "/Users/x/Movies/HomeFlix",
  "extraFolders": [], "autoStart": false }
```
`libraryFolder` receives uploads. `extraFolders` are existing folders that are
scanned and streamed in place, never written to or deleted from.

## Library model

Folders are scanned recursively (hidden files and `.` folders skipped, symlinks
not followed outside the root). A file's **collection** is its first-level
subfolder name inside its root, or the root's own name when it sits at the top.

```ts
Item = {
  id: string,            // 12 hex chars, sha1 of absolute path. Opaque.
  kind: "video" | "photo",
  title: string,         // file name without extension, "_" and "." -> spaces
  file: string,          // file name with extension
  collection: string,
  ext: string,           // lowercase, no dot
  size: number,          // bytes
  mtime: number,         // ms epoch
  duration: number|null, // seconds, video only, null when unknown
  width: number|null, height: number|null,
  playable: "yes" | "maybe" | "no",   // on a typical TV browser, see Formats
  note: string|null,     // plain-language reason when playable != "yes"
  hasSubs: boolean,      // sidecar .srt/.vtt with the same base name exists
  writable: boolean,     // true when inside libraryFolder (may be deleted)
  src: string,           // "/media/<id>"
  thumb: string,         // "/thumb/<id>?v=<mtime>" (cache-busting; append "&w=960" etc. for a larger size)
  progress: { position: number, duration: number, updatedAt: number } | null
}
```

### Formats

| kind | extensions | playable |
|------|-----------|----------|
| video | `mp4`, `m4v` | `yes` (H.264 + AAC assumed; if ffprobe is present and reports another codec such as HEVC/AC3, `maybe` with a note) |
| video | `webm`, `mov` | `maybe` |
| video | `mkv`, `avi`, `wmv`, `flv`, `mpg`, `mpeg`, `ts`, `3gp` | `no` (offer Convert when ffmpeg exists) |
| photo | `jpg`, `jpeg`, `png`, `gif`, `webp` | `yes` |
| photo | `heic`, `heif`, `tif`, `tiff`, `bmp` | `yes` (always delivered to the TV as JPEG via `/photo`) |

Anything else is ignored by the scanner and rejected by upload with `415`.

Optional tools, detected at start-up, never required: `ffmpeg`/`ffprobe`
(video thumbnails, duration, codec check, conversion; looked up on `PATH` plus
`/opt/homebrew/bin` and `/usr/local/bin`), macOS `sips` (photo thumbnails and
resizing, HEIC to JPEG), `qlmanage` (video thumbnail fallback without ffmpeg).

## Media endpoints (both servers)

All JSON is `application/json; charset=utf-8`. Errors are
`{ "error": "<plain-language sentence>", "code": "<snake_case>" }` with a
fitting status. Static files and JSON are sent with `Cache-Control: no-cache`;
thumbnails and resized photos with `max-age=86400`.

| method | path | result |
|--------|------|--------|
| GET | `/api/ping` | `{ ok: true, name, version }` |
| GET | `/api/library` | `{ name, version, generatedAt, videos: Item[], photos: Item[], collections: [{ name, videos, photos }], continueWatching: Item[], recent: Item[] }` |
| GET | `/media/<id>` | the original file. `Accept-Ranges: bytes`, honours `Range` (206, 416), correct `Content-Type`, `HEAD` supported |
| GET | `/thumb/<id>?w=480` | JPEG, longest side `w` snapped to 480 (default), 960 or 1280; use 1280 for full-screen backdrops. `v` is ignored. JPEG ~480px wide by default (videos: frame at ~10% in; photos: resized). When it cannot be made: `200` SVG placeholder, never an error |
| GET | `/photo/<id>?w=1920` | JPEG no wider/taller than `w` (clamped 320–3840, default 1920), EXIF-rotated. Falls back to the original when `sips` is missing and the type is browser-native |
| GET | `/subs/<id>.vtt` | sidecar subtitles as WebVTT (`.srt` converted on the fly), `404` when none |
| PUT | `/api/progress/<id>` | body `{ position, duration }` seconds. `204`. Positions under 30s or within the last 5% clear the entry (treated as not started / finished) |
| DELETE | `/api/progress/<id>` | `204` |

`videos` and `photos` are sorted newest first. `continueWatching` is videos
with progress, most recently watched first, max 20. `recent` is the 20 newest
items of either kind.

`/api/library` is served from an in-memory index, rebuilt when a watched
folder changes (debounced) or on rescan. Thumbnails are generated lazily on
first request with at most 2 concurrent jobs and cached by `id + mtime`.

## Admin endpoints (control server only)

| method | path | body | result |
|--------|------|------|--------|
| GET | `/api/status` | | `Status` |
| POST | `/api/server/start` | | `Status`, or `409 { error, code: "port_in_use" }` |
| POST | `/api/server/stop` | | `Status` |
| PUT | `/api/config` | any subset of `{ name, port, libraryFolder, extraFolders, autoStart }` | `Status`. `400` when a folder does not exist or is not readable. Restarts the TV server if it was running and the port changed |
| POST | `/api/folders/choose` | | opens the native macOS folder picker (`osascript`). `{ path }` or `{ cancelled: true }` |
| POST | `/api/folders/reveal` | `{ path }` (must be a configured folder) or `{ id }` | opens Finder. `204` |
| POST | `/api/upload?name=<file name>&collection=<optional>` | the raw file bytes (no multipart) | `201 { item: Item }`. Streams to a temp file then renames. Name collisions get ` (2)`. `415 unsupported_type`, `507 disk_full`, `400 bad_name` |
| DELETE | `/api/items/<id>` | | moves the file to the macOS Trash (`osascript`/Finder). `204`. `403 read_only` for items in `extraFolders` |
| POST | `/api/items/<id>/convert` | | starts an ffmpeg job that writes `<title>.mp4` (H.264/AAC, `+faststart`) next to it in `libraryFolder`. `202 { job }`. `501 no_ffmpeg` |
| GET | `/api/jobs` | | `{ jobs: [{ id, itemId, title, state: "queued"\|"running"\|"done"\|"failed", percent, error }] }` |
| DELETE | `/api/jobs/<id>` | | cancels. `204` |
| POST | `/api/rescan` | | `Status` |

```ts
Status = {
  name: string, version: string,
  running: boolean,            // TV server listening
  port: number,                // actual port when running, configured otherwise
  address: string|null,        // best LAN IPv4, e.g. "192.168.0.106"; null when no network
  url: string|null,            // "http://192.168.0.106:8080"
  altUrls: string[],           // other interfaces + "http://<LocalHostName>.local:8080"
  wifiName: string|null,       // current SSID when it can be read
  qrSvg: string|null,          // inline <svg> QR code of `url`
  config: Config,
  counts: { videos: number, photos: number, bytes: number },
  tools: { ffmpeg: boolean, sips: boolean },
  scanning: boolean,
  clients: [{ address: string, lastSeen: number, userAgent: string }], // TVs seen in the last 2 min
  error: string|null,          // last problem turning the TV server on, plain language
  libraryError: string|null    // a library or extra folder is missing/unreadable; independent of on/off
}
```

## Running

- `npm start` or double-click `HomeFlix.command`: starts the control server and
  opens `http://localhost:7788` in the default browser. `--no-open` skips that,
  `--serve` also turns the TV server on immediately.
- `Ctrl+C` or closing the Terminal window stops everything.

## Design language (both UIs)

Shared so the Mac and the TV feel like one product. Not a copy of any streaming
brand: no red-on-black, no borrowed logos or layouts.

Concept: **a projector in a dark room** — warm light on deep ink.

```
--ink-0: #0b0a0f   page background (near-black, faint violet)
--ink-1: #15131c   raised surface
--ink-2: #211e2b   card / control
--ink-3: #322e40   hairline, disabled
--text:  #f4f1ea   warm white
--muted: #a39fb0
--beam:  #ffb454   accent: focus, primary action, progress (amber projector light)
--beam-2:#ff7a59   accent gradient end, used sparingly
--ok:    #5fd39a   --warn: #ffd166   --bad: #ff6b6b
```

- Wordmark: `HOME` in warm white + `FLIX` in `--beam`, heavy weight, wide
  letter-spacing. Text only; shared mark in `web/shared/logo.svg`.
- Type: system stack only (`-apple-system, "SF Pro Display", "Helvetica Neue",
  "Segoe UI", Roboto, Arial, sans-serif`). Big confident titles, tight
  line-height, uppercase micro-labels with letter-spacing.
- Artwork is the hero: large thumbnails, 16:9 for video, real aspect for photos,
  dark gradient scrims for text on images.
- Focus (TV) is unmistakable from 3 metres: scale ~1.06 plus a 4px `--beam`
  ring and soft amber glow. Never rely on colour alone.
- Motion: 150–250ms, ease-out, transform/opacity only. Honour
  `prefers-reduced-motion`.
- Radius 10–14px on cards, 999px on pills.

`web/shared/` is served by both servers at `/shared/`.

## TV app behaviour (`web/tv/`)

One page, hash-routed, ES5 only, no dependencies, under ~100KB total.
Also usable on a phone or tablet (people scan the QR code): layout adapts to
narrow and portrait screens and to touch.

- **Home**: hero banner for the featured item (first of Continue Watching,
  else newest video), then rows: Continue Watching, Recently Added, one row per
  collection, Photos. Rows scroll horizontally, page scrolls vertically, focus
  always kept in view.
- **Videos** / **Photos** tabs: full grids (photos grouped by collection).
- **Player**: native `<video>` full screen with a custom overlay — title,
  play/pause, ±10s (left/right), scrubber, elapsed/remaining, subtitles toggle
  when `hasSubs`, auto-hiding after 3s. Resumes from `progress` with a
  "Resume / Start over" choice. Saves progress every 10s and on pause/exit.
  Items with `playable: "no"` show an explanation instead of a broken player;
  `"maybe"` tries and explains on error.
- **Photo viewer**: full screen, left/right to move, Enter toggles slideshow
  (5s, cross-fade), up/down shows/hides the info strip. Loads `/photo/<id>?w=`
  sized to the screen and keeps only current + neighbours in memory.
- Keys: arrows, Enter/OK (13), Back (Backspace 8, Escape 27, 461 webOS,
  10009 Tizen), media keys Play 415, Pause 19, PlayPause 10252, Stop 413,
  FF 417, RW 412. Mouse/pointer (LG Magic Remote) and touch also work.
- Memory: images lazy-loaded only near the viewport, `src` removed when far
  away, grids render in chunks, no more than ~60 thumbnails decoded at once.
- States: loading skeleton, empty library (with instructions to add media on
  the Mac), server unreachable (auto-retry every 5s with a clear message),
  playback error with plain-language cause.
- Polls `/api/library` every 30s (and on returning to Home) so new uploads
  appear without a reload.

## Control panel behaviour (`web/admin/`)

Single page, modern JS, no dependencies.

- **Header**: wordmark, big ON/OFF switch, status pill (Off / Starting / On air
  / Problem).
- **Connect your TV** card (when on): the URL in very large type, QR code, copy
  button, Wi-Fi name, numbered steps, connected TVs list. When off: a friendly
  prompt to switch on. When no network: explain.
- **Library**: drag-and-drop / click-to-choose upload with per-file progress,
  cancel, and clear rejection of unsupported files; grid of items with
  thumbnails, size, duration, playable badge, Convert (when `playable: "no"`
  and ffmpeg exists), Show in Finder, Move to Trash (with confirm). Filter by
  Videos / Photos / collection, search by title.
- **Folders**: library folder with Change… (native picker) and Show in Finder;
  extra folders list with Add folder… / Remove.
- **Settings**: server name, port, start server when HomeFlix opens.
- **Help**: supported formats, TV browser limitations, troubleshooting.
- Polls `/api/status` every 2s; shows a banner if the control server itself
  goes away ("HomeFlix was closed. Open it again to continue.").

## Implementation notes

Behaviour settled while building, binding like the rest of this file:

- The control server also serves the TV app at `/tv/` for previewing, so
  `web/tv/` must reference its own assets with relative URLs.
- The control server refuses requests whose `Host` is not
  `localhost`/`127.0.0.1`/`[::1]`, and non-GET requests with a foreign
  `Origin` (`403 forbidden`), so no other website can drive it.
- If the control port is taken by something else, the next free port up to
  7808 is used and printed. A second HomeFlix launch detects the first.
- `status.url`, `altUrls` and `qrSvg` are filled whenever there is a network,
  also while `running` is false. `clients` excludes loopback.
- `PUT /api/config` with a new port that cannot be taken answers `200` with
  `running: false` and `error` set. Ports must be 1024–65535.
- Upload strips path parts from `name` instead of rejecting them. Empty
  files are `400 empty_file`.
- `DELETE /api/jobs/<id>` removes a job in any state (cancel or dismiss).
  Jobs run one at a time; converting an item twice returns the running job.
  Output for an item in an extra folder goes to `libraryFolder/<collection>/`.
- `/thumb/<unknown id>` is `404`; the placeholder applies to known items.
  Thumbnails are 480px on the longest side.
- `/photo` sends GIFs unchanged (keeps animation) and never enlarges.
- `width`/`height`/`duration` may be null until the first scan finishes
  (`status.scanning` false).
- Subtitles need the exact base name (`Movie.srt`, not `Movie.en.srt`).
- `wifiName` is usually null on recent macOS, which hides the SSID.
- With `HOMEFLIX_HOME` set, deletes go to `<home>/trash/`. Dev knobs:
  `HOMEFLIX_BIND=127.0.0.1`, `--verbose`, `--help`.
- Unknown non-file paths return the app's `index.html`; unknown `/api/*` is
  JSON `404`.
- `/photo` widths snap to 640, 1280, 1920, 2560 or 3840 so the cache stays
  bounded.
- The TV server only answers when `Host` is an IP literal, `localhost` or a
  `.local` name (blocks DNS rebinding). The control server only accepts
  writes whose `Origin`, when present, is its own origin.
- User-facing wording is "Turn on" / "Turn off", never "switch on".
