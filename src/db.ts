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
    status       TEXT    NOT NULL DEFAULT 'new',
    summary      TEXT
  )
`);

// add columns that didn't exist in earlier schema versions
try { db.exec('ALTER TABLE videos ADD COLUMN started_at TEXT'); } catch {}
try { db.exec('ALTER TABLE videos ADD COLUMN removed_at TEXT'); } catch {}
try { db.exec('ALTER TABLE videos ADD COLUMN summary TEXT'); } catch {}

// migrate legacy status values (handles old DBs with 'unplayed'/'played' defaults)
db.exec(`UPDATE videos SET status = 'new'     WHERE status = 'unplayed'`);
db.exec(`UPDATE videos SET status = 'started' WHERE status = 'played'`);
db.exec('UPDATE videos SET started_at = played_at WHERE played_at IS NOT NULL AND started_at IS NULL');

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
  summary: string | null;
  purge_ready?: boolean;
}

export function getVideos(): Video[] {
  return db.prepare(
    "SELECT * FROM videos WHERE status IN ('new','started') ORDER BY CASE WHEN status='new' THEN 0 ELSE 1 END, added_at DESC"
  ).all() as Video[];
}

export function getRemoved(): { videos: Video[]; purge_ready_count: number } {
  const videos = (db.prepare(
    "SELECT *, (removed_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-90 days')) AS purge_ready FROM videos WHERE status = 'removed' ORDER BY removed_at DESC"
  ).all() as (Video & { purge_ready: number })[]).map(v => ({
    ...v,
    purge_ready: !!v.purge_ready,
  }));
  const purge_ready_count = videos.filter(v => v.purge_ready).length;
  return { videos, purge_ready_count };
}

export function getPurgeReadyCount(): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM videos WHERE status = 'removed' AND removed_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-90 days')"
  ).get() as { n: number };
  return row.n;
}

export function addVideo(url: string, title: string, channel_name: string, emoji: string, summary?: string): Video {
  const info = db.prepare(
    "INSERT INTO videos (url, title, channel_name, emoji, status, summary) VALUES (?, ?, ?, ?, 'new', ?)"
  ).run(url, title, channel_name, emoji, summary ?? null);
  return db.prepare('SELECT * FROM videos WHERE id = ?').get(info.lastInsertRowid) as Video;
}

export function hardDelete(id: number): boolean {
  return (db.prepare('DELETE FROM videos WHERE id = ?').run(id).changes as number) > 0;
}

export function purgeReady(): number {
  return (db.prepare(
    "DELETE FROM videos WHERE status = 'removed' AND removed_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-90 days')"
  ).run().changes as number);
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

export function resetClock(id: number): boolean {
  return (db.prepare(
    "UPDATE videos SET removed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ? AND status = 'removed'"
  ).run(id).changes as number) > 0;
}

export function getVideoById(id: number): Video | null {
  return (db.prepare('SELECT * FROM videos WHERE id = ?').get(id) as Video) ?? null;
}

export function saveSummary(id: number, summary: string): boolean {
  return (db.prepare('UPDATE videos SET summary = ? WHERE id = ?').run(summary, id).changes as number) > 0;
}
