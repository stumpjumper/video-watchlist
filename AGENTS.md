# Video Watchlist

Personal video/article watchlist server. Adopted from Claude on 2026-08-15 (former path: `/Users/nano/projects/video_watchlist`). Historical project notes remain in `CLAUDE.md`.

**Runtime is aal on turbo** (cut over 2026-08-16 from `/Users/nano/projects/video_watchlist`). NanoClaw and Docker stay on nano — do not touch them.

## Stack

- Node + TypeScript via `tsx` (no build step): `npm start` / `npm run dev` / `npm test` (`tsx --test src/ingest/*.test.ts`)
- Express, SQLite (`watchlist.db`, schema `PRAGMA user_version` = 6), plain HTML/CSS/JS SPA
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
| `src/ingest/` | URL classify / preview / extract (YouTube, X, web) |
| `public/app.js` | SPA router + views |
| `public/player.js` | AudioEngine |
| `public/sw.js` | Service worker — bump `CACHE` on static changes |
| `skill.md` | NanoClaw HTTP API (agents consume over the network) |

## Ingest

`src/ingest/` is the URL pipeline: classify → preview → extract → quality gate. Adapters: YouTube (oEmbed + yt-dlp), **X** (Relay `ArticleEntity` / `note_tweet`), Ars/web (still `scripts/extract_article.py`). Failures are `IngestError` with a human sentence + `retryable`; permanent codes (`not_article`, `http_404`, `login_wall`, `unsupported`) must not be retried.

X status URLs are not “web articles.” Regular short posts are refused. X has its own Overcast feed (`/feed/<token>/x.xml`). Do not buy the X API or add Playwright.

**Next (not started):** harden the **generic web** adapter (Readability + trafilatura + JSON-LD) behind this same interface. Do not rewrite the app. Do not add X threads / native X video unless asked.

## Conventions

- Client JS is `.js` files only — never embed TypeScript in HTML/template strings.
- Bind `::`, not `0.0.0.0`.
- iOS: no real navigation to `Content-Disposition` attachments (Blob download); do not intercept audio range requests in the SW.
- Do not commit secrets, `certs/`, or the DB.
- Bump `public/sw.js` `CACHE` on static changes (currently `v6-audio-v9`).

## Leftovers (not urgent)

Nano launchd leftover cleanup is scheduled 2026-08-23 (do not delete `/Users/nano/projects/video_watchlist` until then). Optional: NanoClaw cert dead-man’s-switch. Sources: `youtube`, `ars_technica`, `x`, `web` (one Overcast feed each).
