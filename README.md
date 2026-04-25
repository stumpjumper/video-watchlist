# Video Watchlist

A lightweight, self-hosted YouTube watchlist service with a simple single-file UI and a tiny SQLite-backed API. Add videos you want to watch later, mark them started, remove items, and purge items removed for >90 days.

Built with TypeScript + Express and served static UI from public/index.html.

## Features

- Add YouTube videos (URL, title, channel, emoji)
- Fetch title/channel preview via YouTube oEmbed
- Mark a video as "started"
- Remove videos (keeps a removable “Removed” list)
- Permanently delete single items or purge items removed for more than 90 days
- Small, focused single-page UI (public/index.html)
- Automatic small migrations for older DBs

## Quick start

### Prerequisites:
- Node.js (recommended modern LTS — 18+)
- npm

### Install and run:

1. Install dependencies
   ```
   npm install
   ```

2. Start (production-ish)
   ```
   npm start
   ```

3. Start in dev/watch mode
   ```
   npm run dev
   ```

By default the server listens on port 4000. To change it:

```PORT=8080 npm start```

Open http://localhost:4000 in your browser to use the UI.

The SQLite database file will be created at watchlist.db in the project root.

## API

The server exposes a small REST API used by the UI and usable directly.

- **GET /api/videos**
  - Response: { videos: Video[], purge_ready_count: number }
  - Returns active videos (status `new` or `started`) ordered by status/added date.

- **GET /api/videos/removed**
  - Response: { videos: Video[], purge_ready_count: number }
  - Returns removed videos with a boolean `purge_ready` when removed_at is older than 90 days.

- **POST /api/videos**
  - Body: { url: string, title: string, channel_name?: string, emoji?: string }
  - Creates a new video entry. Returns the created Video (201).

- **GET /api/preview?url=<youtube-url>**
  - Calls YouTube oEmbed to fetch title + author_name (channel). Returns { title, channel_name }.

- **POST /api/videos/:id/started**
  - Marks the video as `started` and sets started_at to now.

- **POST /api/videos/:id/removed**
  - Marks the video as `removed` and sets removed_at to now.

- **POST /api/videos/:id/restore**
  - Restores a removed video to status `new` and clears removed_at.

- **POST /api/videos/:id/reset-clock**
  - If status is `removed`, sets removed_at to now (resets 90-day purge timer).

- **DELETE /api/videos/:id**
  - Permanently deletes a single video by id.

- **DELETE /api/videos/purge**
  - Permanently deletes all videos where status = `removed` and removed_at is older than 90 days. Returns { deleted: <count> }.

### Example: add a video via curl

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=XXXXX","title":"Example","channel_name":"Channel","emoji":"📺"}' \
  http://localhost:4000/api/videos
```

## Data model

Table: videos

### Fields:
- id: integer primary key
- url: text
- title: text
- channel_name: text
- emoji: text (defaults to 📺)
- added_at: ISO timestamp (set automatically)
- started_at: ISO timestamp | null
- removed_at: ISO timestamp | null
- status: text — one of `new`, `started`, `removed`

### Behavior:
- Removed items older than 90 days are considered "purge ready".
- The server automatically applies small schema migrations when needed (adds missing columns and migrates a couple of legacy status names from older versions).

## UI

The UI is a single HTML file served from the `public/` directory. It uses the API endpoints described above to show:
- Active watchlist (New / Started)
- Removed list (with restore / reset-clock / delete actions)
- Add modal with YouTube preview fetching

Serve the app and open the root URL using a browser.

## Development notes

- The server entrypoint is src/server.ts
- DB logic is in src/db.ts using a small synchronous SQLite wrapper (database file: watchlist.db)
- Scripts in package.json:
  - start — run using tsx (tsx src/server.ts)
  - dev — run with watch (tsx watch src/server.ts)
- Type definitions are included as devDependencies for local dev experience

## Tests

This project does not include tests yet. Suggested approach to add tests:

- Test runner: Vitest (TypeScript-friendly)
- HTTP integration: Supertest
- DB isolation: configure the app to read DB path from WATCHLIST_DB so tests can use ':memory:' or a temp file
- Make the Express app exportable without immediately calling listen so tests can import and run requests against the app

### Suggested package.json additions:
- devDependencies: vitest, supertest
- scripts: "test": "vitest", "test:watch": "vitest --watch"

### Example minimal integration test (tests/videos.test.ts):

```javascript
process.env.WATCHLIST_DB = ':memory:';
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { app } from '../src/server';

describe('API basic flows', () => {
  it('GET /api/videos returns JSON list', async () => {
    const res = await request(app).get('/api/videos');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('videos');
  });

  it('can add a video and then fetch it', async () => {
    const payload = {
      url: 'https://www.youtube.com/watch?v=abc123',
      title: 'Test video',
      channel_name: 'TestChannel',
      emoji: '📺'
    };
    const addRes = await request(app).post('/api/videos').send(payload);
    expect(addRes.status).toBe(201);
    const listRes = await request(app).get('/api/videos');
    expect(listRes.body.videos.some(v => v.title === 'Test video')).toBe(true);
  });
});
```

## CI

Add a simple GitHub Actions workflow to run tests on push/PR. Example (.github/workflows/ci.yml):

```yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    strategy: { matrix: { node: [18.x, 20.x] } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
      - run: npm ci
      - run: npm test
```