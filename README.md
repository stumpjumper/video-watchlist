# 📺 Video Watchlist

A lightweight, self-hosted YouTube watchlist. Add videos you want to watch later, track what you've started, and let the server clean up old entries automatically. Includes on-demand AI summaries and an agent integration skill.

## Features

- **Mobile-first UI** — tappable cards, bottom-sheet modals, works great on iPhone over Tailscale
- **Add videos** — paste a URL; title and channel auto-fill from YouTube oEmbed
- **Status tracking** — New → Started → Removed lifecycle with restore support
- **AI summaries** — on-demand per video via yt-dlp transcript + OpenRouter (Gemini)
- **Purge management** — removed items accumulate; a banner prompts cleanup after 90 days
- **Sort** — by date added, status, channel, or title with asc/desc toggle
- **Agent skill** — `skill.md` lets AI agents add videos directly via the API

## Stack

- **Node.js 25** + TypeScript, run via `tsx` (no build step)
- **Express** on port 4000, binds `0.0.0.0`
- **SQLite** via built-in `node:sqlite` (no native addons)
- **Plain HTML/CSS/JS** — single file, no framework

## Setup

### Prerequisites

- Node.js 25+
- npm
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) at `/opt/homebrew/bin/yt-dlp` (for AI summaries)
- An [OpenRouter](https://openrouter.ai) API key (for AI summaries)

### Install

```bash
git clone https://github.com/stumpjumper/video-watchlist
cd video-watchlist
npm install
cp .env.example .env
# edit .env and add your OPENROUTER_API_KEY
```

### Run

```bash
# development (auto-restarts on file changes)
npm run dev

# production
npm start
```

Open [http://localhost:4000](http://localhost:4000).

The SQLite database is created automatically at `watchlist.db`.

### Run as a macOS service (launchd)

A sample plist is not included, but the pattern is:

```xml
<key>ProgramArguments</key>
<array>
  <string>/usr/local/bin/node</string>
  <string>/path/to/video_watchlist/node_modules/.bin/tsx</string>
  <string>/path/to/video_watchlist/src/server.ts</string>
</array>
<key>EnvironmentVariables</key>
<dict>
  <key>OPENROUTER_API_KEY</key>
  <string>sk-or-...</string>
</dict>
```

Restart after code changes: `launchctl kickstart -k gui/$(id -u)/com.video-watchlist`

## API

### Add a video

```
POST /api/videos
```

```json
{
  "url":          "https://www.youtube.com/watch?v=...",
  "title":        "Optional — fetched from YouTube if omitted",
  "channel_name": "Optional",
  "emoji":        "Optional, defaults to 📺",
  "summary":      "Optional plain-text or HTML summary"
}
```

If `title` is not provided, the server calls YouTube oEmbed to fill it in. Returns `400` only if the title cannot be determined.

**Response:** `201` with the created video record.

### Other endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/videos` | Active videos (new + started). Includes `purge_ready_count`. |
| `GET` | `/api/videos/removed` | Removed videos with `purge_ready` flag per item. |
| `GET` | `/api/preview?url=` | Fetch title + channel_name from YouTube oEmbed without adding. |
| `POST` | `/api/videos/:id/started` | Mark as started. |
| `POST` | `/api/videos/:id/removed` | Soft-delete (move to removed). |
| `POST` | `/api/videos/:id/restore` | Restore from removed → new. |
| `POST` | `/api/videos/:id/reset-clock` | Reset the 90-day purge window. |
| `POST` | `/api/videos/:id/summary` | Generate (or return cached) AI summary. |
| `DELETE` | `/api/videos/:id` | Hard delete. |
| `DELETE` | `/api/videos/purge` | Hard-delete all purge-ready items (removed 90+ days ago). |

### Quick example

```bash
# URL only — server fills in title and channel
curl -X POST http://localhost:4000/api/videos \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'

# With full metadata
curl -X POST http://localhost:4000/api/videos \
  -H "Content-Type: application/json" \
  -d '{"url":"https://youtu.be/abc123","title":"My Video","channel_name":"Some Channel","emoji":"🚀"}'
```

## AI Summaries

Tapping **Summary** in the action modal generates a summary on demand:

1. `yt-dlp` fetches the VTT subtitle transcript from YouTube
2. The transcript is sent to OpenRouter (`google/gemini-2.0-flash-001`)
3. The result (structured HTML) is stored in the database and cached for future views

The summary overlay includes copy buttons for plain text, HTML, and Markdown.

Requires `OPENROUTER_API_KEY` in the environment and `yt-dlp` installed.

## Agent integration

`skill.md` in the project root is a ready-to-use skill for AI agents (e.g. [nanoclaw](https://github.com/stumpjumper/nanoclaw)). It documents how to add videos via the API, including how to handle success/failure responses without stopping an ongoing check.

## Data model

| Column | Type | Notes |
|---|---|---|
| `id` | integer | Primary key |
| `url` | text | |
| `title` | text | |
| `channel_name` | text | |
| `emoji` | text | Defaults to 📺 |
| `added_at` | text | ISO timestamp, set on insert |
| `started_at` | text\|null | Set when marked started |
| `removed_at` | text\|null | Set when soft-deleted; reset by reset-clock |
| `status` | text | `new`, `started`, or `removed` |
| `summary` | text\|null | Cached HTML summary |

Items with `status = removed` and `removed_at` older than 90 days are considered purge-ready.

## License

MIT — see [LICENSE](LICENSE).
