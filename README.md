# 📺 Video Watchlist

A lightweight, self-hosted YouTube watchlist. Add videos you want to watch later, track what you've started, and organize them with labels. Includes on-demand AI summaries and an agent integration skill.

## Features

- **Mobile-first UI** — tappable cards, bottom-sheet modals, works great on iPhone over Tailscale
- **Add videos** — paste a URL; title and channel auto-fill from YouTube oEmbed
- **Status tracking** — New / Started lifecycle (read/unread, like email)
- **Labels** — create custom labels, apply multiple per video, filter by label with AND/OR mode
- **Search & filter** — text search with debounce, date range filter, label filter
- **Trash mode** — move videos to Trash; bulk-select, restore, or hard-delete
- **AI summaries** — on-demand per video via yt-dlp transcript + OpenRouter (Gemini)
- **Sort** — by date added, status, channel, or title with asc/desc toggle
- **HTTPS access** — served over Tailscale TLS so you can reach it from iPhone
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

### HTTPS via Tailscale

To access over HTTPS from your iPhone, provision a Tailscale cert and set `CERT_DIR` and `HTTPS_PORT` in `.env`. The server will listen on the HTTPS port in addition to port 4000.

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

### Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/videos` | Active videos (Inbox). Supports `q`, `after`, `before`, `labels` (comma-sep IDs), `label_mode=and\|or`. |
| `GET` | `/api/trash` | Trash-labeled videos. |
| `GET` | `/api/preview?url=` | Fetch title + channel_name from YouTube oEmbed without adding. |
| `POST` | `/api/videos/:id/started` | Mark as started. |
| `POST` | `/api/videos/:id/trash` | Move to Trash (adds Trash label, removes Inbox). |
| `POST` | `/api/videos/:id/restore` | Remove Trash label; restore Inbox if no other labels. |
| `PUT` | `/api/videos/:id/labels` | Set exact label set `{ labelIds: [...] }`; auto-restores Inbox if empty. |
| `POST` | `/api/videos/:id/labels/:labelId` | Add a label. |
| `DELETE` | `/api/videos/:id/labels/:labelId` | Remove a label (auto-restores Inbox if last). |
| `POST` | `/api/videos/:id/summary` | Generate (or return cached) AI summary. |
| `DELETE` | `/api/videos/:id` | Hard delete. |
| `DELETE` | `/api/videos/purge` | Hard-delete all Trash-labeled videos. |
| `GET` | `/api/labels` | List all labels. |
| `POST` | `/api/labels` | Create a label `{ name }`. |
| `DELETE` | `/api/labels/:id` | Delete a label (blocked if in use; Inbox and Trash are protected). |

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

### `videos`

| Column | Type | Notes |
|---|---|---|
| `id` | integer | Primary key |
| `url` | text | |
| `title` | text | |
| `channel_name` | text | |
| `emoji` | text | Defaults to 📺 |
| `added_at` | text | ISO timestamp, set on insert |
| `status` | text | `new` or `started` |
| `summary` | text\|null | Cached HTML summary |
| `source` | text | Defaults to `youtube` |
| `content_type` | text | Defaults to `video` |
| `external_id` | text\|null | |
| `source_metadata` | text\|null | JSON blob |

### `labels`

| Column | Type | Notes |
|---|---|---|
| `id` | integer | Primary key |
| `name` | text | Unique |
| `created_at` | text | |

Pre-seeded: **Inbox** (id=1), **Trash** (id=2). These are protected and cannot be deleted.

### `video_labels`

| Column | Type | Notes |
|---|---|---|
| `video_id` | integer | FK → videos, CASCADE delete |
| `label_id` | integer | FK → labels |
| `labeled_at` | text | When the label was applied |

Every video always has at least one label. New videos are automatically given the Inbox label.

## License

MIT — see [LICENSE](LICENSE).
