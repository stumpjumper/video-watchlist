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
| `src/feed.ts` | Podcast RSS feed builder (Overcast integration) |

## Architecture notes

- SQLite DB: `watchlist.db` (gitignored). Schema version tracked via `PRAGMA user_version` (currently **5**).
- Labels are many-to-many. Every video has ≥1 label always. Inbox=1, Trash=2 are reserved.
- `content_type`: `'video'` (YouTube) or `'article'`. Source examples: `'youtube'`, `'ars_technica'`, `'web'`.
- `status`: `'new'` | `'started'` | `'finished'`
- `published_at`: creation date (ISO 8601) — article publication date or YouTube upload date. Populated during audio generation for both types (`fetchAndCacheText` for articles; `yt-dlp --print` during `downloadYouTubeAudio` for videos). Null until first audio is generated, or when the source page exposes no date. The podcast feed's `<pubDate>` is `published_at ?? added_at` — Overcast sorts by it, so episodes sort by creation date, falling back to added date.
- `audio_status`: `'none'` | `'pending'` | `'generating'` | `'ready'` | `'failed'` | `'deleted'`
- Audio files: `audio/` dir (gitignored), ~1MB per article M4A.
- Text cache: `text/` dir (gitignored), plain text per item — extracted article text, or YouTube transcript (`saveYouTubeTranscript()` in `audio.ts`: yt-dlp `-J` metadata → prefer creator subs over auto-captions → json3 track fetched and formatted with `[m:ss]` markers every 2.5 min + paragraph breaks on speech gaps). Text follows the same 30-day retention as audio (lifecycle cron deletes both). `GET /api/videos/:id/text` returns JSON; `?download=1` returns `text/plain` with Content-Disposition attachment. Reader shows article text inline, transcripts behind a Show Transcript toggle; both get Copy/Download toolbar. YouTube's caption endpoint 429s on burst fetches (IP-level, temporal) — `saveYouTubeTranscript` returns `'ratelimited'` distinctly; `sweepMissingTranscripts()` paces 3s/item, aborts on 429, and runs at startup + on the daily lifecycle timer, so gaps self-heal without restarts.
- New tables (V3): `settings` (key/value globals), `playlists` (saved filter configs), `sources` (per-source default_speed)
- `audio_added_at` / `audio_expires_at`: stamped by `markAudioReady()`; lifecycle cron deletes files older than 30 days on startup + every 24h
- `audio_fetched_at` (V5): stamped once, the first time `/audio/<id>.m4a` is actually requested (almost always by Overcast) — via a small middleware ahead of the `express.static` audio route (`markAudioFetched()`, idempotent: `WHERE audio_fetched_at IS NULL`, so repeat range requests from streaming don't matter). Distinct from `audio_added_at` (generation finished) — this tracks whether a listening device has actually pulled the file, surfaced in the UI as a 🦴 badge next to the status badge on cards and in the reader view. It's a "was fetched" signal, not "was listened to" — Overcast auto-fetches the newest episode per feed regardless of whether you've chosen to listen.
- `audio_voice` / `audio_duration_seconds` (V4): see Podcast feed section below.
- **Add flow (`public/app.js`)**: `autoDetectCategory(url)` regex-matches the pasted URL to a `source` (`youtube`/`ars_technica`/`web`) and defaults the per-item `emoji` accordingly (📺/🚀/📰) unless the user has already hand-edited the emoji field. Title/channel auto-fill (`fetchPreview()` → `GET /api/preview`) now works for any URL, not just YouTube — non-YouTube URLs are scraped server-side for `og:title`/`<title>` and `og:site_name` (`scrapeArticleMeta()` in `server.ts`), falling back to the matched source's `sources.display_name` or the URL's hostname.

## SPA architecture (V6, built on branch `v6-podcast-player`; current branch is `overcast-feed`, layered on top — see Podcast feed section)

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

## Podcast feed (Overcast)

Branch `overcast-feed` (off `v6-podcast-player`) adds a parallel consumption
path: a personal RSS feed that Overcast (iOS podcast app) subscribes to
directly, instead of using the in-app mini-player. Purely additive — the
mini-player still works and remains the fallback during the trial period;
nothing has been removed.

- `GET /feed/:token/:sourceKey.xml` (`server.ts`, near the `/audio` static
  route) — token-gated (`FEED_TOKEN` env var, compared against `:token`;
  wrong/missing token → `404`, not `403`, so the route's existence isn't
  confirmed to scanners). `sourceKey` is validated against `getSources()`
  (`db.ts`) — one feed per row in the `sources` table (`youtube`/
  `ars_technica`/`web` today), **not** per `content_type`: Ars Technica and
  generic web articles used to share one "Articles" feed, but that lumped
  together two sources that already have independent `default_speed`
  settings. Adding a future source needs only a new `sources` row + a
  matching `public/feed-icons/<source_key>.png` — no route changes.
- `src/feed.ts` — `buildFeedXml(sourceKey, channelTitle, iconFile)` hand-rolls
  RSS 2.0 + iTunes-namespace XML from `getReadyAudioVideos(source)` (`db.ts`,
  filters `audio_status='ready'` + excludes Trash-labeled videos).
  `channelTitle` comes from `sources.display_name`, not hardcoded, so
  renaming a source's display name renames its podcast title too. Per item:
  `<itunes:author>`/`<itunes:subtitle>` = `channel_name` (Overcast's episode
  list otherwise only shows the title), `<itunes:duration>` from
  `audio_duration_seconds` when known, and a CDATA-wrapped `<description>`
  with channel/published-date/added-date/audio-method/file-size/duration
  plus the existing AI summary HTML. **The summary HTML must stay
  CDATA-wrapped, not `escapeXml()`'d** — it's real HTML (OpenRouter's prompt
  asks for `<h3>/<p>/<ul>/<li>/<strong>`, and `app.js` already renders it via
  `innerHTML`); escaping it shows literal tags in the feed.
- `audio_voice` / `audio_duration_seconds` columns (V4, `db.ts`) — voice is
  recorded at generation time for articles only (`SAY_VOICE` at the moment
  `generateAudio()` succeeds, in `drainQueue()`); duration is probed via
  `/usr/bin/afinfo` (`probeAudioDuration()` in `audio.ts`, built into macOS,
  no ffprobe/ImageMagick-style dependency needed) for both content types.
  Both are backfilled for pre-existing ready rows in the startup IIFE —
  voice backfill assumes the *current* `SAY_VOICE` was always used, since
  there's no historical record if it was ever changed.
- **Artwork:** `public/feed-icons/{youtube,ars_technica,web}.{svg,png}`
  (1400×1400, SVG source + rasterized PNG — rasterized via `qlmanage -t -s
  1400`, no ImageMagick/Pillow installed). Shared "claw-mark" visual theme
  (nods to both NanoClaw and Turbo, the cat this Mac's hostname is named
  after): flat bold vector glyph, a distinct saturated background color per
  source, three diagonal cream claw-scratch marks in the same corner on
  every icon, thin warm-orange inner rim. Served unguarded at `/feed/icons/*`
  (not sensitive, but kept under `/feed` so it's covered by the same Funnel
  path scope). Referenced via `<itunes:image>` + the plain RSS `<image>`
  block.
- **Two separate public-base env vars — do not conflate them:**
  `PUBLIC_AUDIO_BASE_URL` (`turbo`'s Tailscale host, port 4443) for
  `<enclosure>` URLs only — audio is fetched directly by the device over the
  tailnet, proven to work even off home Wi-Fi. `PUBLIC_FEED_BASE_URL`
  (`condor`'s Tailscale host, no port) for `<link>` and artwork URLs, since
  those are fetched by Overcast's server-side crawler infrastructure rather
  than the device, and that crawler needs a genuinely public host.
- **Exposure model — public ingress lives on `condor`, NOT `turbo`:**
  `condor` (a separate Linux node on the tailnet) runs
  `tailscale funnel --set-path=/feed` → local `systemd-socket-proxyd`
  (`turbo-feed-proxy.socket`/`.service` on condor) → `100.104.14.6:4443`
  (turbo's own HTTPS listener, over the tailnet). The local hop on condor is
  required because `tailscaled` can't dial tailnet IPs directly
  (loop-prevention fwmark) — serve backends must be localhost. **`turbo` has
  no serve/funnel config at all and must not get one** — Funnel being
  enabled directly on `turbo` previously made Tailscale publish public DNS
  records for `turbo.taild6cb04.ts.net`, which broke the app for any iPhone
  browser using iCloud Private Relay (Private Relay bypasses MagicDNS,
  landing on the public Funnel ingress instead of the real Tailscale IP —
  that ingress only answers on 443, so the app's `:4443` silently
  blackholed). Audio enclosures are unaffected either way — only the feed
  XML/artwork need public reach, and that's `condor`'s job now.
  Gotcha if condor's Funnel config is ever touched: `tailscale funnel --bg
  443` (bare port, no `--set-path`) silently adds a second mapping of `/` to
  local port 443 alongside any path-scoped one — always use the same
  `--set-path=/feed <target>` form.

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

## Environment variables (in `.env`, loaded via `dotenv/config` — not the launchd plist, which only sets `PATH`)

- `OPENROUTER_API_KEY` — for YouTube video summaries
- `SAY_VOICE` — override TTS voice (default: `Ava (Premium)`)
- `CERT_DIR`, `HTTPS_PORT` — TLS config
- `FEED_TOKEN` — required for the Overcast podcast feed routes; generate with `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
- `PUBLIC_AUDIO_BASE_URL` — base URL prepended to audio enclosure links (default: the Tailscale HTTPS endpoint above, i.e. `turbo`)
- `PUBLIC_FEED_BASE_URL` — base URL for `<link>`/artwork (currently `https://condor.taild6cb04.ts.net` — see Podcast feed section)

## NanoClaw

Send `url`, `title`, `channel_name`, `emoji`, `content_type: 'article'`, `source: 'ars_technica'`. Do NOT include article body text — server fetches it on demand.
