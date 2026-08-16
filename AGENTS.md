# Video Watchlist

Personal video/article watchlist server. Adopted from Claude on 2026-08-15 (former path: `/Users/nano/projects/video_watchlist`). Historical project notes remain in `CLAUDE.md`.

**Runtime is aal on turbo** (cut over 2026-08-16 from `/Users/nano/projects/video_watchlist`). NanoClaw and Docker stay on nano — do not touch them.

## Stack

- Node + TypeScript via `tsx` (no build step): `npm start` / `npm run dev`
- Express, SQLite (`watchlist.db`, schema `PRAGMA user_version` = 5), plain HTML/CSS/JS SPA
- Live branch: **`overcast-feed`**. Do not treat `main` as live.

## URLs / ports

- HTTP: http://localhost:4000
- HTTPS (iPhone / Overcast audio): https://turbo.taild6cb04.ts.net:4443
- Keep these ports. Do not put Tailscale Funnel/serve on turbo (Funnel for `/feed` stays on condor).

## Runtime data (gitignored — copy, do not regenerate)

`.env`, `certs/`, `watchlist.db`, `audio/` (Overcast enclosure `.m4a` files), `text/`, `logs/`, `node_modules/`.

Overcast subscriptions use `FEED_TOKEN` + `PUBLIC_AUDIO_BASE_URL` + `PUBLIC_FEED_BASE_URL` in `.env`. Do not rotate the token or change those URLs.

## Autostart

launchd as aal: `gui/502/com.video-watchlist`. Restart: `launchctl kickstart -k gui/502/com.video-watchlist`. Dev: stop launchd first, then `npm run dev`.

Cert renew: `scripts/renew_tailscale_https_cert` (aal cert/project paths), invoked via `~/bin/renew_tailscale_https_cert`. Agent `com.tailscale-cert-renew`, Sunday 4am. LaunchAgent PATH must include `/Users/aal/.local/bin`.

Cert email uses **nano’s existing OneCLI** (`/Users/nano/.local/bin/onecli`, agent `videowatchlist`, gateway on localhost:10254). Do not install a second OneCLI. aal only has `~/.onecli/config.json` pointing at that API. If nano’s OneCLI/Docker/gateway stops, notify stops.

`scripts/extract_article.py` uses `/Users/aal/.local/bin/trafilatura` (pipx).

## Layout

| Path | Role |
|---|---|
| `src/server.ts` | Express routes |
| `src/db.ts` | SQLite + migrations |
| `src/audio.ts` | TTS / yt-dlp audio |
| `src/feed.ts` | Overcast RSS |
| `public/app.js` | SPA router + views |
| `public/player.js` | AudioEngine |
| `public/sw.js` | Service worker — bump `CACHE` on static changes |
| `skill.md` | NanoClaw HTTP API (agents consume over the network) |

## Conventions

- Client JS is `.js` files only — never embed TypeScript in HTML/template strings.
- Bind `::`, not `0.0.0.0`.
- iOS: no real navigation to `Content-Disposition` attachments (Blob download); do not intercept audio range requests in the SW.
- Do not commit secrets, `certs/`, or the DB.

## Immediate next step

Runtime cutover is done. Do not delete nano’s tree until aal has been live for a while. Remaining ops: nano LaunchAgent leftovers (Prompt B); optional NanoClaw cert dead-man’s-switch.
