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
| `src/audio.ts` | Article audio + text extraction pipeline |
| `src/reader.ts` | Legacy reader page — injects `window.READER_DATA` only; retiring in MVP 2 |
| `scripts/extract_article.py` | Article text extractor (site-specific + trafilatura fallback) |
| `public/index.html` | SPA shell — loads app.js + player.js |
| `public/app.js` | SPA router + list view + reader view |
| `public/player.js` | AudioEngine — single `<audio>` element, mini-player, speed picker |
| `public/reader.js` | Legacy reader page JS — retiring in MVP 2 |
| `public/shared.css` | Design tokens + shared components (both pages link this) |
| `public/beep.wav` | Short tone played before autoplay navigation |
| `skill.md` | API reference for NanoClaw agents |

## Architecture notes

- SQLite DB: `watchlist.db` (gitignored). Schema version tracked via `PRAGMA user_version` (currently **3**).
- Labels are many-to-many. Every video has ≥1 label always. Inbox=1, Trash=2 are reserved.
- `content_type`: `'video'` (YouTube) or `'article'`. Source examples: `'youtube'`, `'ars_technica'`.
- `status`: `'new'` | `'started'` | `'finished'`
- `published_at`: article publication date (ISO 8601), lazy-populated on first text fetch.
- `audio_status`: `'none'` | `'pending'` | `'generating'` | `'ready'` | `'failed'` | `'deleted'`
- Audio files: `audio/` dir (gitignored), ~1MB per article M4A.
- Text cache: `text/` dir (gitignored), plain text per article.
- New tables (V3): `settings` (key/value globals), `playlists` (saved filter configs), `sources` (per-source default_speed)

## SPA architecture (V6 — current branch: v6-podcast-player)

The frontend is a Single Page Application — `index.html` loads once, `app.js` swaps `<div id=view>` content, mini-player bar is always visible. Hash-based routing: `#list`, `#reader/:id`.

- **`public/app.js`**: Router + list view (ported from old index.html) + reader view. `window.navigate(hash)` exposed for player.js.
- **`public/player.js`**: AudioEngine singleton (`window.Player`). Single `<audio>` element never destroyed. `Player.load(meta)`, `Player.setQueue(videos)`, `Player.triggerGenerate(id)`. Per-source speed from `/api/sources`. Speed picker popup (0.75×–2×). MediaSession wired. Autoplay-next on `ended` (uses beep.wav signal then navigates).
- **Mini-player**: frosted-glass bar fixed at bottom. Progress strip at top. ↩10s / ▶⏸ / ⏭ controls. Speed badge (always shown when loaded, tappable to open picker). Info area taps to open reader.

## Article audio pipeline

1. User taps "Generate Audio" in reader view (SPA) or it triggers via Player
2. `POST /api/videos/:id/audio` → server runs `scripts/extract_article.py <url>` — outputs JSON. Text cached to `text/<id>.txt`; `published_at` saved to DB.
3. `say -v "Ava (Premium)"` writes AIFF to /tmp → `afconvert` → M4A → `audio/<id>.m4a`
4. `audio_status` in DB updated to `'ready'`; client polling detects this
5. Startup scan: on server boot, existing `.m4a` files are marked `audio_status='ready'`

## Viewer model

- **YouTube**: action modal → opens YouTube URL in new tab
- **Article**: action modal → "Open reader" → navigates to `#reader/:id` (SPA view, NOT the legacy `/reader/:id` server route)

## iOS quirks

- `navigator.clipboard.writeText` fails over HTTP — use `execCommand('copy')` with a readonly textarea
- `window.open()` must be called synchronously before any `await` — iOS Safari kills it after async gaps
- Audio autoplay on page load is blocked by iOS — `audio.play()` must be called in a synchronous user gesture handler or audio event handler (never after `await`)
- `location.reload()` in async callbacks can behave oddly with audio on iOS — use `location.replace(url)` instead
- `new AudioContext()` created inside async callbacks (after `await`) is suspended on iOS — use an existing `<audio>` element that already has permission instead
- **Never embed TypeScript syntax inside HTML template string JS blocks** — causes SyntaxError that silently kills the entire script block. All client JS lives in `.js` static files.
- After calling `closeActionModal()` which sets `current = null`, capture any needed values (`id`, `url`) into local variables BEFORE the call.

## Environment variables (in launchd plist)

- `OPENROUTER_API_KEY` — for YouTube video summaries
- `SAY_VOICE` — override TTS voice (default: `Ava (Premium)`)
- `CERT_DIR`, `HTTPS_PORT` — TLS config

## NanoClaw

Send `url`, `title`, `channel_name`, `emoji`, `content_type: 'article'`, `source: 'ars_technica'`. Do NOT include article body text — server fetches it on demand.
