# video_watchlist

Personal video/article watchlist server. Node 25 + TypeScript (tsx, no build step), Express, SQLite via `node:sqlite`, plain HTML/CSS/JS frontend.

## Running

Managed by launchd — do **not** start manually in most cases.

```bash
# Restart after code changes
launchctl kickstart -k gui/511/com.video-watchlist

# View logs
tail -f logs/server.log

# Dev mode (hot reload, runs on same port — stop launchd first)
npm run dev
```

- HTTP: http://localhost:4000
- HTTPS (iPhone via Tailscale): https://turbo.taild6cb04.ts.net:4443
- Certs in `certs/` (gitignored); renew with `~/bin/renew_tailscale_https_cert`

## Key files

| File | Purpose |
|------|---------|
| `src/server.ts` | All Express routes |
| `src/db.ts` | SQLite queries, schema migrations |
| `src/audio.ts` | Audio pipeline — TTS for articles, yt-dlp download for YouTube |
| `src/reader.ts` | Legacy reader page — injects `window.READER_DATA` only; not yet retired |
| `scripts/extract_article.py` | Article text extractor (site-specific + trafilatura fallback) |
| `public/index.html` | SPA shell — loads app.js + player.js; contains all mini-player CSS |
| `public/app.js` | SPA router + list / reader / settings / playlists views |
| `public/player.js` | AudioEngine — single `<audio>` element, mini-player, speed picker, SW registration |
| `public/sw.js` | Service Worker — cache-first audio offline, PRECACHE_AUDIO pre-fetch |
| `public/reader.js` | Legacy reader page JS — not yet retired |
| `public/shared.css` | Design tokens + shared components (both pages link this) |
| `public/beep.wav` | Short tone played before autoplay navigation |
| `skill.md` | API reference for NanoClaw agents |

## Architecture notes

- SQLite DB: `watchlist.db` (gitignored). Schema version tracked via `PRAGMA user_version` (currently **3**).
- Labels are many-to-many. Every video has ≥1 label always. Inbox=1, Trash=2 are reserved.
- `content_type`: `'video'` (YouTube) or `'article'`. Source examples: `'youtube'`, `'ars_technica'`, `'web'`.
- `status`: `'new'` | `'started'` | `'finished'`
- `published_at`: article publication date (ISO 8601), populated during audio generation (`fetchAndCacheText`). Null until first audio is generated.
- `audio_status`: `'none'` | `'pending'` | `'generating'` | `'ready'` | `'failed'` | `'deleted'`
- Audio files: `audio/` dir (gitignored), ~1MB per article M4A.
- Text cache: `text/` dir (gitignored), plain text per article.
- New tables (V3): `settings` (key/value globals), `playlists` (saved filter configs), `sources` (per-source default_speed)
- `audio_added_at` / `audio_expires_at`: stamped by `markAudioReady()`; lifecycle cron deletes files older than 30 days on startup + every 24h

## SPA architecture (V6 — current branch: v6-podcast-player)

The frontend is a Single Page Application — `index.html` loads once, `app.js` swaps `<div id=view>` content, mini-player bar is always visible. Hash-based routing: `#list`, `#reader/:id`, `#settings`, `#playlists`.

- **`public/app.js`**: Router + list / reader / settings / playlists views. `window.navigate(hash)` exposed for player.js. `confirmTap(btn, fn)` helper for double-tap confirmation pattern.
- **`public/player.js`**: AudioEngine singleton (`window.Player`). Single `<audio>` element never destroyed. `Player.load(meta)`, `Player.setQueue(videos)`, `Player.triggerGenerate(id)`. Per-source speed from `/api/sources`. Speed picker popup (0.75×–2×). MediaSession wired. Autoplay-next on `ended`: if next item has `audio_status='ready'`, starts audio synchronously (iOS audio-event context allows it) then navigates; otherwise plays beep.wav then navigates.
- **Mini-player**: frosted-glass bar fixed at bottom. Progress row (`<input type="range" id="mp-scrub">` tap-to-seek + `1:23 / 5:45` time) at top. ↺10s / ▶⏸ / ↻30s controls. Speed badge (always shown when loaded, tappable to open picker). Info area taps to open reader. Drag-to-seek not supported — iOS WebKit doesn't render the thumb when `background` is set as inline style on the range input.

## Audio pipeline

Two entry points — both run the same logic via `produceAudio(video)` in server.ts:
- **User-triggered**: `POST /api/videos/:id/audio` from reader view / Player
- **Background queue**: `queueAudioGen(id)` called from `POST /api/videos` when `settings.audio_on_add=true`

`produceAudio` dispatches by content type:
- **Articles** (`content_type='article'`): `generateAudio()` — `scripts/extract_article.py <url>` → text cached to `text/<id>.txt`; `buildAudioHeader()` prepends title + date; `say -v "Ava (Premium)"` → AIFF → `afconvert` → M4A
- **YouTube** (`content_type='video'`, `source='youtube'`): `downloadYouTubeAudio()` — `yt-dlp -x --audio-format m4a` → `audio/<id>.m4a` directly

Both produce `audio/<id>.m4a`. `audio_status`: `pending` → `generating` → `ready` (or `failed`); `audio_added_at` and `audio_expires_at` (now+30d) stamped on ready.

Startup: lifecycle cron deletes expired files, then existing `.m4a` files are marked `ready`; pending DB items re-queued.

Background queue: sequential, 5-minute retry delay, max 5 attempts, survives restarts.

## Viewer model

All content types (YouTube, article, web) tap → `#reader/:id`. The reader loads the item into the player. Mini-player shows `…` (disabled) until audio is ready, then `▶`. Reader body shows a green "Generate Audio" (article) or "Download Audio" (YouTube) button when `audio_status='none'`/`'failed'`; "Generating/Downloading audio…" during generation; nothing (article text shown) or "Audio ready." (YouTube) when done. The green reader button is the single entry point for audio generation — mini-player has no generate tap.

`···` on card or reader → slim sheet: Open original / Play audio (if ready) or Download/Generate audio (navigates to reader) / Summary (YouTube) / Labels.

## iOS quirks

- `navigator.clipboard.writeText` fails over HTTP — use `execCommand('copy')` with a readonly textarea
- `window.open()` must be called synchronously before any `await` — iOS Safari kills it after async gaps
- Audio autoplay on page load is blocked by iOS — `audio.play()` must be called in a synchronous user gesture handler or audio event handler (never after `await`)
- `location.reload()` in async callbacks can behave oddly with audio on iOS — use `location.replace(url)` instead
- `new AudioContext()` created inside async callbacks (after `await`) is suspended on iOS — use an existing `<audio>` element that already has permission instead
- **Never embed TypeScript syntax inside HTML template string JS blocks** — causes SyntaxError that silently kills the entire script block. All client JS lives in `.js` static files.
- `closeActionModal()` sets `current = null` — capture any needed values (`id`, `url`) into local variables BEFORE calling it.
- Service Worker must NOT intercept audio range requests — iOS uses range requests for streaming and caching partial (206) responses corrupts playback. In `sw.js`: `if (e.request.headers.get('range')) return;` before any audio cache logic.
- `<input type="range">` thumb (`-webkit-slider-thumb`) does not render on iOS when the input's `background` is set via inline style — do not rely on a visible thumb for interaction.

## Environment variables (in launchd plist)

- `OPENROUTER_API_KEY` — for YouTube video summaries
- `SAY_VOICE` — override TTS voice (default: `Ava (Premium)`)
- `CERT_DIR`, `HTTPS_PORT` — TLS config

## NanoClaw

Send `url`, `title`, `channel_name`, `emoji`, `content_type: 'article'`, `source: 'ars_technica'`. Do NOT include article body text — server fetches it on demand.
