# Skill: AI Update feed

Turn one finished script into an episode on the watchlist's AI Update podcast. You already have the script and where it came from. Post those. The server speaks the script and files the episode. It does not open the origin page.

Run the POST from a shell on turbo. The route is `http://127.0.0.1:4000/api/episodes`. A request to the tailnet HTTPS port is ignored (404). Do not use `POST /api/videos` for this. That route is for links, and it will try to read the page.

## When to post

Post when you have a script meant to be heard, plus the page it is about.

One episode is one origin. Use that page's own URL, the creator's name, and the page's creation date. Use today's date only when the source was created today. Use your own name as the creator only when you wrote the source.

## Request

`POST http://127.0.0.1:4000/api/episodes`

`Content-Type: application/json`

| Field | Required | What to send |
|---|---|---|
| `text` | yes | The words to speak. Plain text, not HTML. Up to 200,000 characters. |
| `title` | yes | Episode title. |
| `url` | yes | Origin `http` or `https` URL. This is the identity of the episode. |
| `channel_name` | yes | Creator's name, as shown on the source. |
| `published_at` | yes | Source creation date, `YYYY-MM-DD`. |
| `voice` | no | Omit it, or send `say`. Send `ara`, `eve`, `rex`, `sal`, or `leo` only when the task names that voice. |
| `summary` | no | Short HTML note for the episode description. It is not spoken. |

`text` is the only thing spoken, after a spoken title and date. Do not put the script in `summary`.

```bash
python3 - <<'PY'
import json, urllib.request
body = {
  "text": "Plain spoken script.",
  "title": "Episode title",
  "url": "https://example.com/the-source",
  "channel_name": "Creator Name",
  "published_at": "2026-10-28",
}
req = urllib.request.Request(
    "http://127.0.0.1:4000/api/episodes",
    data=json.dumps(body).encode(),
    headers={"Content-Type": "application/json"},
)
with urllib.request.urlopen(req) as res:
    print(res.status)
    print(res.read().decode())
PY
```

## How to read the response

- **201** — new episode. The body is the record. Remember `id`. Audio has been queued. Say that it was added.
- **200** — this origin is already on the list, including when it is in Trash. The body is the existing record. The script you just sent was not saved. Say that it was already on the list. Do not post it again with a different URL to force a second copy.
- **400** — the body was rejected. The error string says why. Nothing was saved. A missing xAI key means that voice is unavailable. Report it. Do not switch voices unless the task allows `say`.
- **Connection refused, 404, or 5xx** — the watchlist is unavailable, or the POST did not run on turbo. Report that. Do not keep retrying.

## When to poll

After a 201, poll until the episode is ready or failed:

```bash
curl -s "http://127.0.0.1:4000/api/videos/$ID/audio/status"
```

`ready` means the episode is in the AI Update feed. `failed` means the error field is the reason. Report it. Do not post the same origin again.

A 200 does not need a poll. Audio was not started again.
