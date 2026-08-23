# video_watchlist

Personal video and article watchlist. The web app is a continuous-playback player (Overcast-style) for iPhone listening; Overcast itself also subscribes to per-source RSS feeds of the same audio.

**Stack:** Node + TypeScript via `tsx` (no build step), Express, SQLite (`node:sqlite`), plain HTML/CSS/JS SPA.

**Keep this file current.** When a feature lands — ingest, audio, feed, UI, routes, schema, env vars — update `README.md` in the same change. `AGENTS.md` is agent/ops rules; this file is the human product and ops doc. Do not leave it as a historical snapshot.

---

## Running

Managed by launchd as `aal`: `gui/502/com.video-watchlist`. Do **not** start a second server.

```bash
# Restart after code changes
launchctl kickstart -k gui/502/com.video-watchlist

# Logs
tail -f logs/server.log

# Tests
npm test   # src/ingest/*.test.ts + src/feed.test.ts + src/lifecycle.test.ts + src/audio.test.ts

# Dev (hot reload, same port — stop launchd first)
npm run dev
```

| Client | URL |
|--------|-----|
| Mac | http://localhost:4000 |
| iPhone / Overcast audio | https://turbo.taild6cb04.ts.net:4443 |
| Overcast feed XML / artwork | https://condor.taild6cb04.ts.net/feed/… |

HTTPS is on **4443** so the process does not need root for 443. Certs in `certs/` (gitignored) are Tailscale Let’s Encrypt for `turbo.taild6cb04.ts.net` (90-day lifetime). Renew: `~/bin/renew_tailscale_https_cert` (`scripts/renew_tailscale_https_cert`), weekly via `com.tailscale-cert-renew` (Sunday 4am).

**yt-dlp** is a Homebrew formula (`/opt/homebrew/bin/yt-dlp`). YouTube (and X native video) audio is a media-URL download; a stale extractor 403s even when the video still exists. Daily upgrade: `com.ytdlp-upgrade` at **5:00** (`scripts/upgrade_ytdlp`, plist `scripts/com.ytdlp-upgrade.plist` installed to `~/Library/LaunchAgents/`). Emails only when the version actually changes or `brew upgrade` fails — same OneCLI agent as cert renew. The server execs the binary per job, so an upgrade does not need a kickstart.

**Do not enable Tailscale Funnel or serve on turbo.** Funnel for `/feed` lives on **condor**. Putting Funnel on turbo publishes public DNS for turbo and breaks iPhone browsers that use iCloud Private Relay (they hit Funnel on 443; the app only answers on 4443).

---

## File map

| Path | Role |
|------|------|
| `src/server.ts` | Express routes, audio queue, lifecycle, feed route |
| `src/db.ts` | SQLite + migrations (`PRAGMA user_version` = **9**) |
| `src/lifecycle.ts` | Inbox/Trash clocks (queries + stamps); `lifecycle.test.ts` |
| `src/audio.ts` | Article TTS + yt-dlp native-audio download, transcripts, duration |
| `src/feed.ts` | Overcast RSS 2.0 + iTunes namespace |
| `src/ingest/` | Classify / preview / extract (YouTube, X, Ars/web) |
| `src/reader.ts` | Legacy server-rendered reader — still wired, not the primary path |
| `public/index.html` | SPA shell + mini-player CSS |
| `public/app.js` | Router + list / reader / settings / playlists |
| `public/player.js` | AudioEngine (`window.Player`) |
| `public/sw.js` | Service worker — bump `CACHE` on static changes (currently `v6-audio-v15`) |
| `public/feed-icons/` | 1400×1400 podcast artwork per source |
| `skill.md` | HTTP API notes for NanoClaw agents |
| `scripts/renew_tailscale_https_cert` | Cert renew |
| `scripts/notify_cert_status.mjs` | Email cert renew success/failure via nano’s OneCLI |
| `scripts/upgrade_ytdlp` | Daily `brew upgrade yt-dlp` |
| `scripts/notify_ytdlp_status.mjs` | Email yt-dlp upgrade / failure via nano’s OneCLI |
| `scripts/com.ytdlp-upgrade.plist` | launchd job (copy to `~/Library/LaunchAgents/`) |

Gitignored runtime: `.env`, `certs/`, `watchlist.db`, `audio/`, `text/`, `logs/`, `node_modules/`.

---

## What gets ingested

Server-side classify in `src/ingest` overwrites the client’s source hint for known hosts.

| Source | URLs | Audio |
|--------|------|--------|
| `youtube` | YouTube / youtu.be | yt-dlp → m4a; optional captions → `text/<id>.txt` |
| `x` | `x.com` / `twitter.com` status URLs | **Attached native video** → yt-dlp m4a. **X Articles** and long Premium posts → TTS. Regular tweets, and replies that only *display* someone else’s video, are refused (`not_article`). `/status/{id}/video/N` is the same post as `/status/{id}`. |
| `ars_technica` | arstechnica.com | TTS (prefers `post-content`, then JSON-LD / Readability / trafilatura) |
| `web` | everything else | TTS (one fetch: JSON-LD + Readability + trafilatura). JS-only shells fail `parse_failed` — no Playwright. |

`content_type` is `video` (YouTube, or X with attached video) or `article`. Native X video stays `source=x` and lands in the **x** Overcast feed, not YouTube’s.

Do not buy the X API, add Playwright, or stitch X threads unless asked.

---

## Database

**File:** `watchlist.db` (gitignored). Schema via `PRAGMA user_version` (currently **9**).

### `videos`

| Column | Notes |
|--------|--------|
| `url`, `title`, `channel_name`, `emoji` | |
| `added_at` | ISO 8601 UTC |
| `started_at` | Last time the in-app reader was opened |
| `finished_at` | First in-app `audio` ended (does not move on repeat) |
| `status` | `new` \| `started` \| `finished` |
| `source` | `youtube` \| `ars_technica` \| `x` \| `web` (or a custom slug) |
| `content_type` | `video` \| `article` |
| `published_at` | Creation date. Filled during audio production (`yt-dlp` upload date, or extractor date). Feed `<pubDate>` is `published_at ?? added_at`. |
| `summary` | AI HTML summary (YouTube, OpenRouter) |
| `audio_status` | `none` \| `pending` \| `generating` \| `ready` \| `failed` \| `deleted` |
| `audio_error` | Set on `failed` |
| `audio_added_at` / `audio_expires_at` | Ready stamp. `audio_expires_at` is leftover; media now dies on Trash, not on a generation TTL |
| `audio_retry_count` | Background queue |
| `audio_voice` | TTS voice used (articles only) |
| `audio_duration_seconds` | From macOS `afinfo` |
| `audio_fetched_at` | First time `/audio/<id>.m4a` was requested (almost always Overcast). Idempotent. UI 🦴 badge. |

Labels are many-to-many (`video_labels`). Every item has ≥1 label. Inbox = 1, Trash = 2 (reserved).

**`settings`:** `autoplay` (default true), `audio_on_add` (default true in V3 seed), `tts_voice`, `pre_cache_count`, plus lifecycle (below). `0` on a lifecycle key disables that rule.

**`playlists`:** named snapshots of the current filter (not a frozen ID list).

**`sources`:** per-source `default_speed` and `display_name` (podcast title). Seeded: youtube, ars_technica, web, x.

### Migrations

- **V1:** labels + Inbox/Trash
- **V2:** `published_at`
- **V3:** settings, playlists, sources, audio lifecycle columns
- **V4:** `audio_voice`, `audio_duration_seconds`
- **V5:** `audio_fetched_at`
- **V6:** `x` source row
- **V7:** `finished_at`; lifecycle settings (`lifecycle_trash_after_finished_hours=24`, `lifecycle_inbox_inactive_days=30`, `lifecycle_purge_trash_days=30`)
- **V8:** backfill `started_at = now` where null, so the inactivity clock does not treat the whole historic Inbox as already stale
- **V9:** `lifecycle_strip_audio_after_trash_seconds` (default 60)

---

## SPA

`index.html` loads once. `app.js` swaps `#view`. Mini-player is always in the DOM. Hash routes: `#list`, `#reader/:id`, `#settings`, `#playlists`.

`window.navigate(hash)` is global so `player.js` can autoplay-advance. List filters/sort/scroll persist in `localStorage` (`watchlist-state`).

**Every content type taps through to `#reader/:id`** (YouTube is not a new-tab skip). Reader loads the item into the player.

### List (`#list`)

Filters: search (title/channel; × clears the field), source, labels (AND/OR), date range. Sort: added, posted, status, channel, title.

Cards: emoji + channel, title, status, published (✎) / added (↓), labels, 🦴 if Overcast fetched audio. `···` action sheet. 🗑 trash.

Audio spinner / fail icon shows for `content_type` article or video (generating / failed).

**Action sheet:** Open original · Play / Download audio (native video) · Summary (**YouTube only**) · File Info… · Labels.

### Reader (`#reader/:id`)

Loads `/api/videos/:id` and `/api/videos/:id/text` in parallel, then `Player.load()`.

- **Articles:** Generate Audio (TTS). Cached text shown as `<pre>` when present; Copy / Download are Blob-based (no navigation to `Content-Disposition`).
- **Native audio** (`content_type=video`): Download Audio (yt-dlp). YouTube transcripts sit behind Show Transcript when `text/<id>.txt` exists; otherwise “Audio ready.”

Green reader button is the generate/download entry point. Mini-player does not start generation.

Text downloads must stay client-side Blobs — a real navigation to an attachment response can strand an iOS PWA outside the SPA.

### Settings / playlists

Autoplay, audio-on-add, TTS voice, per-source speed, Inbox/Trash lifecycle (toggles + durations; off is a toggle, not `0` in the number box), audio dir size. Playlists re-run the saved filter live (`confirmTap` for destructive overwrite/delete).

---

## Mini-player and AudioEngine

Fixed frosted bar: scrub + `1:23 / 5:45`, ↺10s / ▶⏸ / ↻30s, speed badge (0.75×–2×), info (tap → reader). iOS does not draw the range thumb when `background` is an inline style — do not depend on it.

`window.Player` owns one `<audio>` element (never destroyed — iOS autoplay continuity). `Player.load(meta)`, `Player.setQueue(videos)`, `Player.triggerGenerate(id)`. Speed from `/api/sources`. MediaSession for lock screen / headphones.

**Autoplay** on `ended`: mark finished; if next in queue has `audio_status=ready`, start that m4a **synchronously** (iOS allows play inside an audio event) then navigate; otherwise just navigate. Article TTS already ends with a spoken closer, so the player does not play a transition beep. Pre-cache message covers the next few **articles** that are already ready (not native video files).

Position: `localStorage` `pos-<id>`, every 5s and on pause.

---

## Audio production

Two entry points, same `produceAudio(video)` in `server.ts`:

- Reader / Player: `POST /api/videos/:id/audio`
- Add: `queueAudioGen(id)` when `settings.audio_on_add=true`

Dispatch on **`content_type`**:

| `content_type` | Path |
|----------------|------|
| `article` | `extractDocument(url)` → `text/<id>.txt` → `say` (body) → 2s silence → `say` closer in `SAY_CLOSER_VOICE` (“Article audio complete.”) → 2s silence → `afconvert` → `audio/<id>.m4a`. Records `audio_voice` (body). Closer is audio-only, not stored in the text cache. Existing m4a are unchanged until regenerated. |
| `video` | `yt-dlp -x --audio-format m4a` → `audio/<id>.m4a`. YouTube also tries captions (`saveYouTubeTranscript`); X video skips that. |

Duration via `/usr/bin/afinfo`. Status: `pending` → `generating` → `ready` (or `failed`). Queue is sequential, 5-minute retry, max 5 attempts, re-queued on startup.

Supported: any `article` or `video` (YouTube **and** X native video). Wrong/missing token on the feed route is **404**, not 403.

Lifecycle (startup + every hour) in `runAudioLifecycle()`:

| Rule | Default | Scope |
|------|---------|--------|
| Inbox, full listen in-app | 24 hours after first `finished_at` | Then Trash. Podcast RSS activity has no impact. Filing off Inbox cancels it. |
| Inbox, last activity | 30 days | Activity = adding, opening the reader, partial listen (`started_at` on play), or full listen (`finished_at`). **Not** RSS/Overcast fetch. |
| Audio files | after N seconds in Trash (default 60) | Manual 🗑 and auto-trash. Restore before then keeps the file. Toggle off = keep audio until the row is permanently deleted. Text is always kept on Trash. |
| Hard-delete Trash | 30 days after Trash `labeled_at` | Row + leftover audio **and** text. |

Settings `#settings` Inbox / Trash sections. `0` stored value = that rule is off (the toggle is unchecked; the number box still shows the last/default duration). Remaining on-disk m4a are marked `ready` after the job (crash recovery). Daily sweep still backfills missing YouTube transcripts only (`source=youtube`); aborts on caption 429.

First run after deploy strips **audio** from everything already in Trash and hard-deletes Trash older than 30 days. V8 stamps `started_at` on rows that never had one, so the Inbox backlog is not auto-trashed on day one.

---

## Podcast feed (Overcast)

`GET /feed/:token/:sourceKey.xml` — one feed per `sources` row (`youtube`, `ars_technica`, `web`, `x`). Token is `FEED_TOKEN`. Items are `audio_status=ready` and not Trash.

- Episode `<title>` is `channel · title` (Overcast playlists ignore `itunes:author`). DB title unchanged.
- `<itunes:author>` / subtitle = `channel_name`.
- `<description>` is CDATA HTML (keep summaries unescaped).
- `<enclosure>` uses **`PUBLIC_AUDIO_BASE_URL`** (turbo:4443) — the phone fetches audio on the tailnet.
- `<link>` and artwork use **`PUBLIC_FEED_BASE_URL`** (condor, no port) — Overcast’s crawler is not on the tailnet.

Artwork: `public/feed-icons/<source_key>.png`, served at `/feed/icons/`.

Condor: `tailscale funnel --set-path=/feed` → local proxy → turbo:4443. Bare `tailscale funnel --bg 443` (no `--set-path`) silently maps `/` as well — don’t do that.

Do not rotate `FEED_TOKEN` or change those public URLs without resubscribing Overcast.

---

## Caching

| Layer | Where | What | Lifetime |
|-------|--------|------|----------|
| Text | `text/<id>.txt` | Article extract or YouTube transcript | Until the row is permanently deleted (not on Trash) |
| Audio | `audio/<id>.m4a` | TTS or yt-dlp | Until Trash (filed library: until manual trash) |
| Browser | SW cache `v6-audio-v15` | Precached full m4a + static assets | Until `CACHE` bump |

SW **must not** intercept audio **range** requests (iOS streaming; caching 206 corrupts playback). API is network-only.

---

## API

Preview: `GET /api/preview?url=` — YouTube oEmbed, X Relay parse, or web title. Failures `{ error, code, retryable }`. Regular X posts return 200 with `warning.code = not_article`; `POST /api/videos` then 400s those.

Add: `POST /api/videos` — server classifies. For `source=x` it always previews (even if title is filled), stamps `content_type` from that, normalizes `/video/N` off the URL.

| Method | Path | Notes |
|--------|------|--------|
| `GET/POST` | `/api/videos` | List / add |
| `GET` | `/api/videos/:id` | |
| `GET` | `/api/videos/:id/text` | JSON; `?download=1` exists but the UI must not navigate to it |
| `GET` | `/api/videos/:id/fileinfo` | Size/dates for audio + text files |
| `POST` | `/api/videos/:id/audio` | Generate or return ready |
| `GET` | `/api/videos/:id/audio/status` | |
| `POST` | `/api/videos/:id/summary` | YouTube only |
| `GET` | `/feed/:token/:sourceKey.xml` | RSS |
| `GET` | `/audio/:id.m4a` | Stamps `audio_fetched_at` once |

Labels, trash, settings, sources, playlists, categories match the routes in `src/server.ts`.

---

## NanoClaw

`POST /api/videos` with `url`, `title`, `channel_name`, `emoji`, `content_type`, `source`. Do **not** send body text. See `skill.md`. Server still classifies youtube / x / ars from the URL.

---

## iOS

- Clipboard over HTTP: `execCommand('copy')`, not `navigator.clipboard`.
- `window.open()` must run before any `await`.
- `audio.play()` only in a user gesture or audio event (never after `await`).
- Never TypeScript inside HTML template-string JS.
- `closeActionModal()` clears `current` — copy `id` / `url` first.
- Blob downloads, not attachment navigations.

---

## Environment (`.env`, via `dotenv/config` — launchd only sets `PATH`)

| Variable | Purpose |
|----------|---------|
| `OPENROUTER_API_KEY` | YouTube summaries |
| `SAY_VOICE` | TTS body voice (default `Ava (Premium)`) |
| `SAY_CLOSER_VOICE` | Spoken end-marker after article TTS (default `Daniel`) |
| `CERT_DIR`, `HTTPS_PORT` | TLS (`4443` here) |
| `FEED_TOKEN` | Feed path; wrong token → 404 |
| `PUBLIC_AUDIO_BASE_URL` | Enclosure base (turbo:4443) |
| `PUBLIC_FEED_BASE_URL` | Feed link + artwork (condor) |
| `TRAFILATURA` | Optional path; default `/Users/aal/.local/bin/trafilatura` |

Template: `.env.example`. Do not commit `.env`. Do not rotate feed token/URLs casually.

---

## Docs map

| File | Role |
|------|------|
| **`README.md`** | This file — product + ops, kept in lockstep with features |
| **`AGENTS.md`** | Agent rules (runtime user, ports, ingest constraints) |
| **`CLAUDE.md`** | Historical notes; prefer README + AGENTS for current truth |
| **`skill.md`** | NanoClaw HTTP add API |
