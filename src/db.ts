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
    removed_at   TEXT,
    status       TEXT    NOT NULL DEFAULT 'new'
  )
`);

// add columns that didn't exist in earlier schema versions
try { db.exec('ALTER TABLE videos ADD COLUMN started_at TEXT'); } catch {}
try { db.exec('ALTER TABLE videos ADD COLUMN removed_at TEXT'); } catch {}
// copy played_at → started_at for records created before the rename
db.exec('UPDATE videos SET started_at = played_at WHERE played_at IS NOT NULL AND started_at IS NULL');

// migrate legacy status values
db.exec(`UPDATE videos SET status = 'new'     WHERE status = 'unplayed'`);
db.exec(`UPDATE videos SET status = 'started' WHERE status = 'played'`);

// auto-purge removed items older than 90 days
db.exec(`DELETE FROM videos WHERE status = 'removed' AND removed_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-90 days')`);

export interface Video {
  id: number;
  url: string;
  title: string;
  channel_name: string;
  emoji: string;
  added_at: string;
  started_at: string | null;
  removed_at: string | null;
  status: string;
}

export function getVideos(): Video[] {
  return db.prepare(
    "SELECT * FROM videos WHERE status IN ('new','started') ORDER BY CASE WHEN status='new' THEN 0 ELSE 1 END, added_at DESC"
  ).all() as Video[];
}

export function getRemoved(): Video[] {
  return db.prepare(
    "SELECT * FROM videos WHERE status = 'removed' ORDER BY removed_at DESC"
  ).all() as Video[];
}

export function addVideo(url: string, title: string, channel_name: string, emoji: string): Video {
  const info = db.prepare(
    'INSERT INTO videos (url, title, channel_name, emoji) VALUES (?, ?, ?, ?)'
  ).run(url, title, channel_name, emoji);
  return db.prepare('SELECT * FROM videos WHERE id = ?').get(info.lastInsertRowid) as Video;
}

export function hardDelete(id: number): boolean {
  return (db.prepare('DELETE FROM videos WHERE id = ?').run(id).changes as number) > 0;
}

export function markStarted(id: number): boolean {
  return (db.prepare(
    "UPDATE videos SET status = 'started', started_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?"
  ).run(id).changes as number) > 0;
}

export function markRemoved(id: number): boolean {
  return (db.prepare(
    "UPDATE videos SET status = 'removed', removed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?"
  ).run(id).changes as number) > 0;
}

export function restoreVideo(id: number): boolean {
  return (db.prepare(
    "UPDATE videos SET status = 'new', removed_at = NULL WHERE id = ?"
  ).run(id).changes as number) > 0;
}
