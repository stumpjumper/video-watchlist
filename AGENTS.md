# Video Watchlist

Personal video/article watchlist server. Adopted from Claude on 2026-08-15 (former path: `/Users/nano/projects/video_watchlist`). Historical project notes remain in `CLAUDE.md`.

**Runtime is aal on turbo** (cut over 2026-08-16 from `/Users/nano/projects/video_watchlist`). NanoClaw and Docker stay on nano — do not touch them.

## Stack

- Node + TypeScript via `tsx` (no build step): `npm start` / `npm run dev` / `npm test` (`tsx --test src/ingest/*.test.ts src/feed.test.ts src/lifecycle.test.ts src/audio.test.ts`)
- Express, SQLite (`watchlist.db`, schema `PRAGMA user_version` = 9), plain HTML/CSS/JS SPA
- Live branch: **`main`**.

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

yt-dlp: Homebrew `/opt/homebrew/bin/yt-dlp`. Daily upgrade `com.ytdlp-upgrade` at 5:00 (`scripts/upgrade_ytdlp`). Plist lives at `scripts/com.ytdlp-upgrade.plist` — copy to `~/Library/LaunchAgents/`. Emails on version change or brew failure, not when already current. Hardcoded path in `src/audio.ts`; no server restart after upgrade.

Cert / yt-dlp email uses **nano’s existing OneCLI** (`/Users/nano/.local/bin/onecli`, agent `videowatchlist`, gateway on localhost:10254). Do not install a second OneCLI. aal only has `~/.onecli/config.json` pointing at that API. If nano’s OneCLI/Docker/gateway stops, notify stops.

Web extract uses `/Users/aal/.local/bin/trafilatura` (pipx; `TRAFILATURA` override). `scripts/extract_article.py` is leftover, not the live path.

## Layout

| Path | Role |
|---|---|
| `src/server.ts` | Express routes |
| `src/db.ts` | SQLite + migrations |
| `src/lifecycle.ts` | Inbox/Trash clocks (`lifecycle.test.ts`) |
| `src/audio.ts` | TTS / yt-dlp audio |
| `src/feed.ts` | Overcast RSS |
| `src/ingest/` | URL classify / preview / extract (YouTube, X, web) |
| `public/app.js` | SPA router + views |
| `public/player.js` | AudioEngine |
| `public/sw.js` | Service worker — bump `CACHE` on static changes |
| `skill.md` | NanoClaw HTTP API (agents consume over the network) |
| `README.md` | Human product/ops doc — update with each feature |

## Ingest

`src/ingest/` is the URL pipeline: classify → preview → extract → quality gate. Adapters: YouTube (oEmbed + yt-dlp), **X** (Relay `ArticleEntity` / `note_tweet` / attached native video), Ars/web (JSON-LD + Mozilla Readability + trafilatura on one fetch; Ars still prefers the `post-content` container). Failures are `IngestError` with a human sentence + `retryable`; permanent codes (`not_article`, `http_404`, `login_wall`, `unsupported`, `paywall`, `too_short`, `parse_failed`) must not be retried.

X status URLs are not “web articles.” Attached native video (`kind=native_video`, `content_type=video`, yt-dlp) and Articles / long Premium posts are in; regular short posts are refused (`not_article`). A reply that only *displays* someone else’s video is still `not_article` — detection is scoped to the opened status’s Relay id, not any `VideoInfo` on the page. `/status/{id}/video/N` is the same post as `/status/{id}` (`normalizeUrl` strips the suffix). Audio lands in the existing **x** Overcast feed (`/feed/<token>/x.xml`). Relay `firstJsStringField` keys must be whole identifiers (`__typename:"__Root"` contains `name:"__Root"`). Prefer `authorName`. `fetchPage` retries HTTP 5xx. Do not buy the X API or add Playwright.

JS-only shells (no article in the HTML) fail `parse_failed` — do not reach for Playwright. Do not add X threads unless asked.

`produceAudio` dispatches on `content_type === 'video'` (yt-dlp) vs article (TTS). Article TTS (`renderArticleAudio`) appends 2s silence + Daniel “Article audio complete.” + 2s silence; not stored in the text cache; existing m4a until regen. Native video is unchanged. X native video is stamped `content_type=video` at add time; do not re-`extractDocument` just to read `nativeAudio`. Transcript sweep is youtube-only. The mini-player does not play `beep.wav` on `ended`.

Lifecycle replaces the old 30-day generation TTL. Inbox auto-trash / audio-on-trash delay / Trash hard-delete are settings (`0` = that rule off, never “immediate”). Audio strips after the Trash delay; text is kept until the row is permanently deleted. Filed items are a library. Details in `README.md`.

## Conventions

- Client JS is `.js` files only — never embed TypeScript in HTML/template strings.
- Bind `::`, not `0.0.0.0`.
- iOS: no real navigation to `Content-Disposition` attachments (Blob download); do not intercept audio range requests in the SW.
- Do not commit secrets, `certs/`, or the DB.
- Bump `public/sw.js` `CACHE` on static changes (currently `v6-audio-v15`).
- **When a feature is complete, update `README.md` in the same change** (ingest, audio, feed, UI, routes, schema, env vars). `README.md` is the human product/ops doc; this file is agent rules. Do not leave README as a historical snapshot. Do not revive `README_local.md` — machine facts that must be shared live here or in README.

## Leftovers (not urgent)

Nano leftover cleanup reminder was **2026-08-23** (ask first; do not auto-delete `/Users/nano/projects/video_watchlist`). Optional: NanoClaw cert dead-man’s-switch. Sources: `youtube`, `ars_technica`, `x`, `web` (one Overcast feed each).
