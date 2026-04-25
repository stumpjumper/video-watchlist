# Skill: video-watchlist

Add videos to a self-hosted video watchlist server. The server stores videos with title, channel, status, and an optional summary. It exposes a simple HTTP API.

## Configuration

The server URL must be defined in your group's config. Typically `http://localhost:4000` when the agent and server run on the same machine, or a LAN/VPN address (e.g. Tailscale) when they don't.

Reference it in your group config as `watchlist_url`, for example:

```json
{ "watchlist_url": "http://localhost:4000" }
```

## When to add a video

Add a video to the watchlist when:
- The channel config has `watchlist: true`
- The video passed all filters (shorts check, minimum duration, etc.)

Do not add skipped or filtered-out videos.

## API: add a video

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
| `channel_name` | no | Channel display name. If omitted alongside `title`, the server fills it from oEmbed. If you supply `title` but not `channel_name`, it defaults to empty. |
| `emoji` | no | Emoji for the channel (defaults to 📺) |
| `summary` | no | Plain-text summary; include if you already generated one |

**Tip:** if your agent already has the title and channel from an RSS feed, pass them — it saves the server a round-trip to YouTube. If you only have the URL, omit `title` and the server will fetch it.

Success: HTTP 201 with the new video record as JSON.

Errors:
- HTTP 400 — missing `url`, or `title` was not provided and could not be fetched from YouTube
- Connection refused / HTTP 5xx — server is unavailable; treat as a soft failure

## Handling the response

On HTTP 201: note `(added to watchlist)` in your report for this video.

On any non-201: note `(watchlist unavailable)` and continue without stopping the check. Do not retry.

## Reporting example

```
🔭 Scott Manley: NEW — "Apollo at 50" — https://youtu.be/abc123 (added to watchlist)
⚡ Tesla: NEW — "Cybertruck Update" — https://youtu.be/xyz789 (watchlist unavailable)
```

## Other available endpoints

These are informational — you generally won't need them during a check, but they're available if you need to query or manage the list.

```
GET  /api/videos              → list active videos (new + started)
GET  /api/videos/removed      → list removed videos
GET  /api/preview?url=        → fetch title + channel_name from YouTube oEmbed (without adding)
POST /api/videos/:id/started  → mark a video as started
POST /api/videos/:id/removed  → soft-delete (move to removed)
POST /api/videos/:id/restore  → restore from removed
POST /api/videos/:id/reset-clock → reset 90-day purge window
DELETE /api/videos/:id        → hard delete
DELETE /api/videos/purge      → hard-delete all purge-ready items (90+ days old)
```
