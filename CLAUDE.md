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
| `src/audio.ts` | Article audio generation (Trafilatura → say → afconvert) |
| `src/reader.ts` | HTML5 reader/player page builder |
| `public/index.html` | Entire frontend (single file) |
| `skill.md` | API reference for NanoClaw agents |

## Architecture notes

- SQLite DB: `watchlist.db` (gitignored). Schema version tracked via `PRAGMA user_version`.
- Labels are many-to-many. Every video has ≥1 label always. Inbox=1, Trash=2 are reserved.
- `content_type`: `'video'` (YouTube) or `'article'`. Source examples: `'youtube'`, `'ars_technica'`.
- Audio files: `audio/` dir (gitignored), ~1MB per article M4A.

## Article audio pipeline

1. User taps "Generate Audio" on `/reader/:id`
2. Server calls `trafilatura -u <url>` (full path: `/Users/nano/.local/bin/trafilatura`) to fetch clean text
3. `say -v "Ava (Premium)"` writes AIFF to /tmp
4. `afconvert` converts to M4A (64kbps AAC) → `audio/<id>.m4a`
5. Player page reloads; HTML5 `<audio>` element takes over

Generation is async — client polls `/api/videos/:id/audio/status`. Failures surface as `{status:'failed'}`, not stuck generating.

**NanoClaw**: send `url`, `title`, `channel_name`, `emoji`, `content_type: 'article'`, `source: 'ars_technica'`. Do NOT include article body text — Trafilatura fetches it on demand.

## iOS quirks

- `navigator.clipboard.writeText` fails over HTTP — use `execCommand('copy')` with a readonly textarea
- `window.open()` must be called synchronously before any `await` — iOS Safari kills it after async gaps
- `speechSynthesis.pause()` is broken on iOS — was worked around before audio generation was added (now irrelevant)

## Environment variables (in launchd plist)

- `OPENROUTER_API_KEY` — for YouTube video summaries
- `SAY_VOICE` — override TTS voice (default: `Ava (Premium)`)
- `TRAFILATURA_BIN` — override Trafilatura path (default: `/Users/nano/.local/bin/trafilatura`)
- `CERT_DIR`, `HTTPS_PORT` — TLS config
