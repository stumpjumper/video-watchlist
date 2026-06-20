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
| `src/reader.ts` | HTML5 reader/player page builder |
| `scripts/extract_article.py` | Article text extractor (site-specific + trafilatura fallback) |
| `public/index.html` | Main frontend (single file) |
| `public/shared.css` | Design tokens + shared components (both pages link this) |
| `skill.md` | API reference for NanoClaw agents |

## Architecture notes

- SQLite DB: `watchlist.db` (gitignored). Schema version tracked via `PRAGMA user_version` (currently 2).
- Labels are many-to-many. Every video has ≥1 label always. Inbox=1, Trash=2 are reserved.
- `content_type`: `'video'` (YouTube) or `'article'`. Source examples: `'youtube'`, `'ars_technica'`.
- `status`: `'new'` | `'started'` | `'finished'`
- `published_at`: article publication date (ISO 8601), lazy-populated on first text fetch. Separate from `added_at`.
- Audio files: `audio/` dir (gitignored), ~1MB per article M4A.
- Text cache: `text/` dir (gitignored), plain text per article.

## Article audio pipeline

1. User taps "Generate Audio" on `/reader/:id`
2. Server runs `scripts/extract_article.py <url>` — outputs JSON `{"text":"...","published_at":"..."|null}`. Site-specific parsing for known sites (Ars Technica: `post-content` div), trafilatura fallback. Parses `published_at` from Open Graph meta + JSON-LD. Text cached to `text/<id>.txt`; `published_at` saved to DB.
3. `say -v "Ava (Premium)"` writes AIFF to /tmp
4. `afconvert` converts to M4A (64kbps AAC) → `audio/<id>.m4a`
5. Client polls `/api/videos/:id/audio/status`; on ready, navigates via `location.replace` (not reload)

Generation is async. Failures surface as `{status:'failed'}`, not stuck generating. Poll bails after 30 attempts.

## Viewer model

All content types (YouTube videos, articles) are treated uniformly in the list UI — same card, same action modal. The modal's primary CTA opens the appropriate viewer:
- **YouTube**: opens YouTube URL in new tab (no status feedback)
- **Article**: navigates to `/reader/:id` (our reader auto-tracks status)

## Reader page features

- Speed dropdown (0.75×–2×)
- Playback position saved to `localStorage` (per article ID); restored on reload; saved on pause + visibilitychange. Clamped to `duration - 2s` to prevent immediate-ended bug.
- Autoplay toggle (localStorage-persisted): on `ended`, fetches next article in current filtered list, generates audio if needed, navigates. Clears saved position of target article before navigating (always starts fresh).
- Mark as finished: `POST /api/videos/:id/finished` called automatically on audio end
- Article text displayed below player — lazy-fetched from `/api/videos/:id/text`, cached to `text/<id>.txt`
- Labels button + status badge in top bar — manage labels without returning to the list
- MediaSession: `previoustrack` + `nexttrack` both rewind 10s (AirPods left double-tap → rewind)

## iOS quirks

- `navigator.clipboard.writeText` fails over HTTP — use `execCommand('copy')` with a readonly textarea
- `window.open()` must be called synchronously before any `await` — iOS Safari kills it after async gaps
- Audio autoplay on page load is blocked by iOS — user must tap play on each new reader page
- `location.reload()` in async callbacks can behave oddly with audio on iOS — use `location.replace(url)` instead

## Environment variables (in launchd plist)

- `OPENROUTER_API_KEY` — for YouTube video summaries
- `SAY_VOICE` — override TTS voice (default: `Ava (Premium)`)
- `CERT_DIR`, `HTTPS_PORT` — TLS config

## NanoClaw

Send `url`, `title`, `channel_name`, `emoji`, `content_type: 'article'`, `source: 'ars_technica'`. Do NOT include article body text — server fetches it on demand.
