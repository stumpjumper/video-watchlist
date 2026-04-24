import { DatabaseSync } from 'node:sqlite';
import path from 'path';

const db = new DatabaseSync(path.join(__dirname, '..', 'watchlist.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS videos (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    url          TEXT    NOT NULL,
    title        TEXT    NOT NULL,
    channel_name TEXT    NOT NULL DEFAULT '',
    emoji        TEXT    NOT NULL DEFAULT '📺',
    added_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    started_at   TEXT,
    status       TEXT    NOT NULL DEFAULT 'new'
  )
`);

// migrate any legacy records from old status values
db.exec(`UPDATE videos SET status = 'new'     WHERE status = 'unplayed'`);
db.exec(`UPDATE videos SET status = 'started' WHERE status = 'played'`);

export interface Video {
  id: number;
  url: string;
  title: string;
  channel_name: string;
  emoji: string;
  added_at: string;
  started_at: string | null;
  status: string;
}

export function getVideos(): Video[] {
  return db.prepare(
    "SELECT * FROM videos ORDER BY CASE WHEN status='new' THEN 0 ELSE 1 END, added_at DESC"
  ).all() as Video[];
}

export function addVideo(url: string, title: string, channel_name: string, emoji: string): Video {
  const info = db.prepare(
    'INSERT INTO videos (url, title, channel_name, emoji) VALUES (?, ?, ?, ?)'
  ).run(url, title, channel_name, emoji);
  return db.prepare('SELECT * FROM videos WHERE id = ?').get(info.lastInsertRowid) as Video;
}

export function removeVideo(id: number): boolean {
  return (db.prepare('DELETE FROM videos WHERE id = ?').run(id).changes as number) > 0;
}

export function markStarted(id: number): boolean {
  return (db.prepare(
    "UPDATE videos SET status = 'started', started_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?"
  ).run(id).changes as number) > 0;
}
