# Skill: video-watchlist

Add videos and articles to a self-hosted watchlist server. The server stores items with title, channel/source, status, and optional metadata. It exposes a simple HTTP API.

## Configuration

The server URL must be defined in your group's config. Typically `http://localhost:4000` when the agent and server run on the same machine, or a LAN/VPN address (e.g. Tailscale) when they don't.

Reference it in your group config as `watchlist_url`, for example:

```json
{ "watchlist_url": "http://localhost:4000" }
```

## When to add an item

Add an item to the watchlist when:
- The channel/feed config has `watchlist: true`
- The item passed all filters (shorts check, minimum duration, keyword match, etc.)

Do not add skipped or filtered-out items.

## API: add a YouTube video

```bash
curl -s -w "\n%{http_code}" -X POST "$WATCHLIST_URL/api/videos" \
  -H "Content-Type: application/json" \
  -d "{
    \"url\":          \"$VIDEO_URL\",
    \"title\":        \"$VIDEO_TITLE\",
    \"channel_name\": \"$CHANNEL_NAME\",
    \"emoji\":        \"$CHANNEL_EMOJI\",
    \"summary\":      \"$SUMMARY\"
  }"
```

Fields:
| Field | Required | Description |
|---|---|---|
| `url` | yes | Full YouTube video URL |
| `title` | no | Video title. If omitted, the server fetches it from YouTube oEmbed automatically. |
| `channel_name` | no | Channel display name. If omitted alongside `title`, the server fills it from oEmbed. |
| `emoji` | no | Emoji for the channel (defaults to 📺) |
| `summary` | no | Plain-text summary; include if you already generated one |
| `source` | no | Source identifier (default: `youtube`) |
| `content_type` | no | `video` or `article` (default: `video`) |

**Tip:** pass `title` and `channel_name` when you already have them (e.g. from an RSS feed) — it saves the server a round-trip to YouTube.

## API: add an article

```bash
curl -s -w "\n%{http_code}" -X POST "$WATCHLIST_URL/api/videos" \
  -H "Content-Type: application/json" \
  -d "{
    \"url\":          \"$ARTICLE_URL\",
    \"title\":        \"$ARTICLE_TITLE\",
    \"channel_name\": \"$SOURCE_NAME\",
    \"emoji\":        \"$EMOJI\",
    \"content_type\": \"article\",
    \"source\":       \"ars_technica\"
  }"
```

For articles, `title` is always required (no auto-fetch). Do **not** include article body text — the server fetches and extracts it on demand via Trafilatura when the user requests audio.

Known source identifiers: `youtube`, `ars_technica`. For new sources, use a lowercase underscore slug (e.g. `the_verge`) — the UI will display it in Title Case automatically.

Success: HTTP 201 with the new item record as JSON.

Errors:
- HTTP 400 — missing `url`, or `title` was not provided (articles never auto-fetch)
- Connection refused / HTTP 5xx — server is unavailable; treat as a soft failure

## Handling the response

On HTTP 201: note `(added to watchlist)` in your report for this item.

On any non-201: note `(watchlist unavailable)` and continue without stopping the check. Do not retry.

## Reporting example

```
🔭 Scott Manley: NEW — "Apollo at 50" — https://youtu.be/abc123 (added to watchlist)
🛸 Ars Technica: NEW — "NASA's new rocket" — https://arstechnica.com/... (added to watchlist)
⚡ Tesla: NEW — "Cybertruck Update" — https://youtu.be/xyz789 (watchlist unavailable)
```

## On-demand summaries (videos only)

The server can generate an AI summary for any video on demand. When a user asks for a summary of a watchlist video, direct them to tap **Summary** in the app, or call:

```bash
curl -s -X POST "$WATCHLIST_URL/api/videos/$VIDEO_ID/summary"
```

The server fetches the YouTube transcript via yt-dlp, sends it to an LLM, and returns structured HTML. This requires `OPENROUTER_API_KEY` to be configured on the server.

## Other available endpoints

```
GET  /api/videos              → list active items (new + started); supports ?source=ars_technica filter
GET  /api/categories          → list sources with counts: [{source, count}]
GET  /reader/:id              → browser TTS reader page for articles
GET  /api/preview?url=        → fetch title + channel_name from YouTube oEmbed (without adding)
POST /api/videos/:id/started  → mark an item as started
POST /api/videos/:id/trash    → move to trash
POST /api/videos/:id/restore  → restore from trash
DELETE /api/videos/:id        → hard delete
DELETE /api/videos/purge      → hard-delete all trash items
```
