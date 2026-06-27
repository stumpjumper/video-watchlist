# video_watchlist

Personal video and article watchlist server. Reimagined in V6 as a continuous-playback podcast player (Overcast model) optimised for hands-free listening on an iPhone while cycling.

**Stack:** Node 25 + TypeScript (`tsx`, no build step), Express, SQLite via `node:sqlite`, plain HTML/CSS/JS SPA frontend.

---

## Running

The server is managed by launchd and starts automatically at login. **Do not start it manually** in normal use.

```bash
# Restart after code changes
launchctl kickstart -k gui/511/com.video-watchlist

# View live logs
tail -f logs/server.log

# Dev mode — hot reload, same port (stop launchd first)
npm run dev
```

**Endpoints**
- HTTP: `http://localhost:4000`
- HTTPS (iPhone via Tailscale): `https://turbo.taild6cb04.ts.net:4443`
- TLS certs live in `certs/` (gitignored); renew with `~/bin/renew_tailscale_https_cert`

---

## File map

| File | Purpose |
|------|---------|
| `src/server.ts` | All Express routes, audio queue, lifecycle cron |
| `src/db.ts` | SQLite schema, migrations, all query functions |
| `src/audio.ts` | Article text extraction + TTS pipeline |
| `src/reader.ts` | Legacy server-rendered reader — still wired but not the primary path |
| `public/index.html` | SPA shell — loads `app.js` + `player.js`; contains mini-player CSS |
| `public/app.js` | SPA router + list / reader / settings / playlists views |
| `public/player.js` | AudioEngine singleton (`window.Player`), Service Worker registration |
| `public/sw.js` | Service Worker — offline audio caching + pre-fetch |
| `public/shared.css` | Design tokens + shared components |
| `public/beep.wav` | Short tone played before autoplay navigation |
| `scripts/extract_article.py` | Article text extractor (site-specific parsers + trafilatura fallback) |

---

## Database

**File:** `watchlist.db` (gitignored). Schema version tracked via `PRAGMA user_version` (currently **3**).

### Tables

**`videos`** — one row per item

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | |
| `url` | TEXT | YouTube URL or article URL |
| `title` | TEXT | |
| `channel_name` | TEXT | Publisher / channel |
| `emoji` | TEXT | Display emoji (default `📺`) |
| `added_at` | TEXT | ISO 8601 UTC |
| `started_at` | TEXT | Set on first play/open |
| `status` | TEXT | `new` \| `started` \| `finished` |
| `summary` | TEXT | AI-generated HTML summary (YouTube only) |
| `source` | TEXT | `youtube` \| `ars_technica` \| `web` |
| `content_type` | TEXT | `video` \| `article` |
| `external_id` | TEXT | Reserved |
| `source_metadata` | TEXT | Reserved |
| `published_at` | TEXT | Article publication date; populated during audio generation |
| `audio_status` | TEXT | `none` \| `pending` \| `generating` \| `ready` \| `failed` \| `deleted` |
| `audio_error` | TEXT | Error message when `audio_status = 'failed'` |
| `audio_added_at` | TEXT | When audio was first generated |
| `audio_expires_at` | TEXT | `audio_added_at + 30 days`; reset on re-generation |
| `audio_retry_count` | INTEGER | Background queue retry counter |

**`labels`** — user-defined tags
- Reserved: id 1 = `Inbox`, id 2 = `Trash`
- Every video always has at least one label

**`video_labels`** — many-to-many join with `labeled_at` timestamp

**`settings`** — global key/value store

| Key | Default | Notes |
|-----|---------|-------|
| `autoplay` | `true` | Auto-advance to next item on track end |
| `audio_on_add` | `false` | Queue audio generation when an article is added |
| `tts_voice` | `Ava (Premium)` | macOS `say` voice name |
| `pre_cache_count` | `3` | How many upcoming items the SW pre-fetches (stored but not yet used to vary the window) |

**`playlists`** — saved filter configurations
- `name` (unique), `filter_json` (serialised filter: labels, label_mode, source, sort, q), `created_at`

**`sources`** — per-source default playback speed
- Seeded: `youtube` (1.0×), `ars_technica` (1.2×), `web` (1.0×)

### Migration history
- **V0→1:** Labels system, `video_labels` table, Inbox/Trash reserved labels
- **V1→2:** `published_at` column on videos
- **V2→3:** `settings`, `playlists`, `sources` tables; audio lifecycle columns on videos

---

## SPA architecture

`index.html` loads once. `app.js` swaps `<div id=view>` for each screen. The mini-player bar at the bottom is always in the DOM and never navigated away from. Hash-based routing:

| Hash | View |
|------|------|
| `#list` | Main watchlist |
| `#reader/:id` | Article reader |
| `#settings` | Settings page |
| `#playlists` | Playlist manager |

`window.navigate(hash)` is exposed globally so `player.js` can trigger navigation (e.g. autoplay advance).

List view state (filters, sort, scroll position) is persisted in `localStorage` under key `watchlist-state` and restored when navigating back.

---

## List view (`#list`)

### Header controls
- **Labels** — opens the label management modal (create, rename, delete)
- **Trash** — toggles trash mode; shows trashed items, enables bulk select/restore/delete
- **+ Add** — opens the add-item modal
- **Playlists** — navigates to `#playlists`
- **⚙** — navigates to `#settings`

### Filters
- **Search** — debounced 300 ms, matches title and channel name
- **Source selector** — filters to a single source (`youtube`, `ars_technica`, etc.)
- **Filter** button — opens label filter modal with optional date range (`after` / `before`) and AND/OR mode toggle (shown when ≥ 2 labels selected)

### Sort
- Fields: Date added, Date posted (`published_at`), Status, Channel, Title
- Direction toggle: ascending / descending

### Cards
Each card shows:
- Emoji + channel name
- Title
- Status badge (New / Started / Finished)
- Published date (✎) and added date (↓) — `fmtSmartDate`: month/day for items within the last year, month/day/'YY for older
- Label chips (non-system labels only) with `labeled_at` date
- **···** — opens action sheet
- 🗑 — single-tap to trash

For articles (non-trash):
- **⚙ spinning** — audio is `pending` or `generating` (background queue)
- **⚠** (amber, tappable) — audio generation `failed`; tap shows alert with error text

Tapping a card:
- **YouTube video** — opens YouTube URL in new tab, marks `started`
- **Article** — navigates to `#reader/:id`, marks `started`

### Action sheet (···)
- **Open original** — opens URL in new tab
- **Summary** (YouTube only) — generates or shows AI summary via OpenRouter (Gemini Flash)
- **Labels** — inline label picker; Apply writes `PUT /api/videos/:id/labels`
- **Copy** — copies URL (uses `execCommand('copy')` for iOS HTTP compatibility)

### Trash mode
- Entering trash shows trashed items with checkboxes
- Bulk bar: Select all / count / Restore / Delete (permanent)
- Both Restore and Delete require a two-tap confirmation (`confirmTap` helper)

---

## Reader view (`#reader/:id`)

Loads the article video record and its cached text in parallel. Passes the video into `Player.load()` so the mini-player reflects the current item.

**Header:** emoji + channel, non-system label chips, title, published date, added date, status badge.

**Text area:**
- If `text/<id>.txt` exists: renders as `<pre class="article-text">`
- If not: shows "Generate Audio" button which calls `Player.triggerGenerate(id)`

**Nav:**
- ← Back → `#list`
- ··· → action sheet (fetches fresh video on open to reflect any in-session label edits)

---

## Settings view (`#settings`)

Global toggles:
- **Autoplay next** — stored in DB (`settings.autoplay`) and mirrored to `localStorage('v6-autoplay')` for the player
- **Audio on add** — when enabled, articles added via `POST /api/videos` are automatically queued for audio generation

**TTS voice** — text input; any voice name accepted by `say -v` (e.g. `Ava (Premium)`)

**Playback speed per source** — one number input per row in `sources` table; writes `PUT /api/sources/:id`

**Labels** — opens the label management modal

**Audio storage** — shows current `audio/` directory size in MB

Save button writes `PUT /api/settings` and saves all source speeds.

---

## Playlists view (`#playlists`)

Playlists are named snapshots of the current filter state (labels, label_mode, source, sort field/direction, search text). They do **not** store a fixed set of video IDs — they re-run the filter live each time.

**Save current filter** — names the current filter and writes `POST /api/playlists`

**Playlist list:**
- Tap row → applies `filter_json` to list state, saves state, navigates to `#list`
- ✎ → inline rename (Enter to save, Escape to cancel); writes `PUT /api/playlists/:id`
- ↻ → overwrite with current filter (first tap shows "Sure?", second confirms)
- ✕ → delete (same double-tap confirmation pattern)

Confirmation pattern (`confirmTap`): first tap changes button text to "Sure?" for 2.5 s, second tap within that window executes the action.

---

## Mini-player (always visible)

Fixed at the bottom, frosted-glass style. Only meaningful when a video is loaded into the player.

**Layout (top to bottom):**
1. Progress row: seek track (tappable to scrub) + `1:23 / 5:45` time display
2. Controls: ↺10s / ▶⏸ / ↻30s
3. Speed badge (always shown when loaded) + info area (emoji title, channel)

**Speed picker** — tapping the speed badge opens a popup with presets: 0.75× 1× 1.25× 1.5× 1.75× 2×. Current speed is highlighted. Tapping outside closes it.

**Info area** — tapping navigates to `#reader/:id` for the currently loaded item.

**MediaSession** — wired so headphone/lock-screen controls work on iPhone:
- Play / Pause / Seek backward (10 s) / Seek forward (10 s)
- Next track → advance to next item in queue

---

## AudioEngine (`public/player.js`)

Singleton exposed as `window.Player`. Owns the single `<audio>` element (never destroyed or recreated — essential for iOS audio continuity).

### Key state
- `currentId` / `currentMeta` — currently loaded video
- `queue` — ordered array of full video objects from the last list load
- `sourceSpeeds` — map of `source_key → default_speed` fetched from `/api/sources` at init
- `cachedStatus` — last fetched audio status `{ status, url?, error? }`

### `Player.load(meta)`
Called by `showReaderView`. Fetches audio status from `/api/videos/:id/audio/status`:
- `ready` → enables play/pause button
- `generating` / `pending` → shows `…` icon, starts polling every 2 s
- `none` / `failed` / `deleted` → shows ⬇ icon (tap to generate)

### `Player.setQueue(videos)`
Called by `load()` in the list view after every fetch. Queue is the full sorted+filtered result.

### `Player.triggerGenerate(id)`
Posts to `POST /api/videos/:id/audio`, then polls until ready or failed. Failure triggers `speak()` with the error message.

### Autoplay
On `audio ended`:
1. Mark current item finished (`POST /api/videos/:id/finished`)
2. Clear saved position
3. If autoplay enabled and there is a next item in queue: play `beep.wav`, then on beep end navigate to `#reader/<nextId>`
4. If queue is exhausted: `speak('End of playlist.')`

### Position persistence
`localStorage` key `pos-<id>` stores current time, saved every 5 s and on pause. Restored when the same item is re-opened.

### Verbal errors (`speak`)
Uses `speechSynthesis` (cancels any pending utterance before speaking):
- Audio generation network error (in `triggerGenerate`)
- Audio generation failure reported by server (in polling loop)
- End of playlist

### Pre-caching
`preCacheNext()` is called on track end. It sends a `PRECACHE_AUDIO` message to the Service Worker with the IDs of the next 3 articles in the queue that already have `audio_status = 'ready'`.

---

## Caching overview

There are three caching layers, each at a different level:

| Layer | Location | What's cached | Lifetime |
|-------|----------|---------------|----------|
| **Text** | `text/<id>.txt` (server) | Extracted article text | Permanent — never deleted |
| **Audio** | `audio/<id>.m4a` (server) | Generated M4A audio | 30 days from generation; reset on re-generation |
| **Browser** | Service Worker cache | Audio files + static assets | Until SW cache is bumped or audio is evicted |

**Text cache** — when audio is generated for an article, `extract_article.py` runs once and the result is written to `text/<id>.txt`. Subsequent re-generations (e.g. after the audio expires) read from this file rather than re-fetching the site. The reader view also reads from this cache to display article text.

**Audio cache** — generated M4A files live in `audio/` and are served directly by Express. The 30-day lifecycle is managed server-side (see [Audio lifecycle](#audio-lifecycle)). The browser also receives a 7-day `max-age` cache header, so repeated plays don't re-request the file.

**Browser / Service Worker cache** — the SW caches audio files cache-first so they survive going offline mid-ride. Static assets (app.js, player.js, shared.css, beep.wav) are pre-cached on SW install. The player proactively pre-fetches the next few items in the queue so they're available before you reach them (see [Service Worker](#service-worker-publicswjs)).

---

## Article audio pipeline

1. User taps "Generate Audio" in the reader, **or** the background queue picks up the item (if `audio_on_add = true`).
2. `POST /api/videos/:id/audio` (user path) or `drainQueue()` (background path).
3. Server runs `scripts/extract_article.py <url>` — outputs JSON `{ text, published_at }`. Text cached to `text/<id>.txt`; `published_at` saved to DB.
4. `buildAudioHeader()` prepends `"<Title>. <Month Day, Year>"` to the text.
5. `say -v "Ava (Premium)" -f <tmpfile> -o <aiff>` → `afconvert` → `audio/<id>.m4a`.
6. `markAudioReady(id)` stamps `audio_added_at = now`, `audio_expires_at = now + 30 days`, sets `audio_status = 'ready'`.
7. Client polling detects `ready` and enables playback.

`scripts/extract_article.py` tries site-specific parsers first (Ars Technica, etc.), then falls back to `trafilatura`.

---

## Background audio generation queue

When `settings.audio_on_add = true`, articles added via `POST /api/videos` are immediately queued.

**Queue mechanics (server-side, in-memory + DB-backed):**
- `audioQueue: number[]` — FIFO list of video IDs
- `drainQueue()` — processes one item at a time (sequential, since TTS is CPU-bound)
- On enqueue: `setAudioPending(id)` writes `audio_status = 'pending'` to DB
- On processing: `setAudioGenerating(id)` writes `audio_status = 'generating'`
- On success: `markAudioReady(id)`
- On failure: `setAudioFailed(id, error)` writes `audio_status = 'failed'`, increments `audio_retry_count`
- Retry: after 5-minute delay, re-queues if `audio_retry_count < 5` (max 5 attempts total)
- **Survives restarts:** on startup, `getPendingAudioIds()` re-queues any items still marked `pending` in DB

User-triggered generation (`POST /api/videos/:id/audio`) runs independently (not via the queue) but also writes DB status, so the status endpoint is always consistent.

---

## Audio lifecycle

- **On startup** and **every 24 h**: `runAudioLifecycle()` deletes `audio/<id>.m4a` files where `audio_expires_at < now`, sets `audio_status = 'deleted'`.
- After the deletion scan, any `.m4a` files still on disk are marked `audio_status = 'ready'` (handles files from a previous run that weren't tracked in DB).
- When a `deleted` item is loaded into the player, tapping ⬇ re-generates it (same path as first generation, expiry resets to now + 30 days).

---

## Service Worker (`public/sw.js`)

Registered by `player.js` at init via `navigator.serviceWorker.register('/sw.js')`.

**Install:** pre-caches static assets (`/`, `/app.js`, `/player.js`, `/shared.css`, `/beep.wav`).

**Activate:** claims all clients, deletes old cache versions.

**Fetch interception:**
- `/audio/*` — cache-first; on miss fetches from network and stores in cache. Serves cached audio when offline.
- `/api/*` — network-only (never cache API responses).
- Everything else — cache-first (static assets).

**`PRECACHE_AUDIO` message:** player sends `{ type: 'PRECACHE_AUDIO', ids: number[] }` after advancing tracks. SW fetches and caches each `audio/<id>.m4a` that isn't already cached.

Cache name: `v6-audio-v1`. A version bump in `sw.js` triggers automatic old-cache eviction on activate.

---

## API reference

### Videos

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/videos` | List videos. Query: `q`, `labels`, `label_mode`, `source`, `after`, `before` |
| `POST` | `/api/videos` | Add video. Body: `url`, `title`, `channel_name`, `emoji`, `content_type`, `source`, `summary`, `source_metadata` |
| `GET` | `/api/videos/:id` | Get single video with labels |
| `DELETE` | `/api/videos/:id` | Hard delete |
| `POST` | `/api/videos/:id/started` | Mark started |
| `POST` | `/api/videos/:id/finished` | Mark finished |
| `POST` | `/api/videos/:id/trash` | Move to trash (adds Trash label) |
| `POST` | `/api/videos/:id/restore` | Restore from trash |
| `DELETE` | `/api/videos/purge` | Hard-delete all trashed videos |
| `PUT` | `/api/videos/:id/labels` | Replace all labels. Body: `{ labelIds: number[] }` |
| `POST` | `/api/videos/:id/labels/:labelId` | Add single label |
| `DELETE` | `/api/videos/:id/labels/:labelId` | Remove single label (last label auto-restores Inbox) |
| `POST` | `/api/videos/:id/summary` | Generate AI summary (YouTube only, via OpenRouter) |
| `GET` | `/api/videos/:id/text` | Get cached article text |
| `GET` | `/api/videos/:id/next` | Next video in filtered list. Same query params as `/api/videos` |

### Audio

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/videos/:id/audio` | Trigger audio generation (or return existing). Returns `{ status, url? }` |
| `GET` | `/api/videos/:id/audio/status` | Current status: `{ status, url?, error? }`. Checks in-memory → DB |
| `GET` | `/api/audio/stats` | `{ bytes, mb }` — total audio directory size |
| `GET` | `/audio/:id.m4a` | Serve generated audio file (7-day max-age cache header) |

### Labels

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/labels` | All labels |
| `POST` | `/api/labels` | Create label. Body: `{ name }` |
| `PUT` | `/api/labels/:id` | Rename label. Body: `{ name }` |
| `DELETE` | `/api/labels/:id` | Delete label (blocked if any video has it as its only non-system label) |

### Settings, Sources, Playlists

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/settings` | All settings as `{ key: value }` |
| `PUT` | `/api/settings` | Update one or many keys |
| `GET` | `/api/sources` | All sources with `default_speed` |
| `PUT` | `/api/sources/:id` | Update `default_speed`. Body: `{ default_speed: number }` |
| `GET` | `/api/playlists` | All playlists |
| `POST` | `/api/playlists` | Create. Body: `{ name, filter_json }` |
| `PUT` | `/api/playlists/:id` | Update. Body: `{ name, filter_json }` |
| `DELETE` | `/api/playlists/:id` | Delete |

### Other

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/categories` | Distinct sources with item counts |
| `GET` | `/api/preview` | Fetch YouTube title/channel via oEmbed. Query: `url` |
| `GET` | `/api/trash` | Videos with Trash label |
| `GET` | `/reader/:id` | Legacy server-rendered reader (deprecated, still functional) |

---

## NanoClaw integration

NanoClaw (the iOS Shortcut / agent) adds articles by posting to `POST /api/videos`. Send:

```json
{
  "url": "https://...",
  "title": "Article title",
  "channel_name": "Publication name",
  "emoji": "🚀",
  "content_type": "article",
  "source": "ars_technica"
}
```

Do **not** send article body text — the server fetches and caches it on demand during audio generation.

If `audio_on_add = true` is set in settings, audio generation begins automatically after the item is added.

---

## iOS / Safari quirks

- `navigator.clipboard.writeText` fails over HTTP — URL copy uses `execCommand('copy')` via a temporary `<textarea>`.
- `window.open()` must be called synchronously before any `await` — iOS Safari kills popups opened after async gaps.
- `audio.play()` must be called in a synchronous user-gesture handler — iOS blocks autoplay otherwise. The `<audio>` element is never destroyed for this reason.
- Autoplay-next works by listening to `audio.ended` (a trusted audio event), then playing `beep.wav` via `new Audio()`, then navigating on `beep.ended` — all within synchronous audio event handlers.
- Never embed TypeScript syntax inside HTML template-string JS blocks — causes a `SyntaxError` that silently kills the entire script.
- All client JS lives in static `.js` files, never inlined in HTML templates.
- `closeActionModal()` sets `current = null` — capture `id`, `url`, etc. into locals before calling it.

---

## Environment variables

Set in the launchd plist:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `4000` | HTTP port |
| `HTTPS_PORT` | `443` | HTTPS port |
| `CERT_DIR` | — | Path to TLS cert/key files |
| `OPENROUTER_API_KEY` | — | Required for YouTube AI summaries |
| `SAY_VOICE` | `Ava (Premium)` | Override TTS voice for `say` |
