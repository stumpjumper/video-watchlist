import type { DatabaseSync } from 'node:sqlite';

const INBOX = 1;
const TRASH = 2;

/** 0 or negative → off. Non-numeric → fallback. */
export function parseLifecycleInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function isoCutoff(db: DatabaseSync, modifier: string): string {
  const row = db.prepare(
    `SELECT strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now', ?)) AS t`
  ).get(modifier) as { t: string };
  return row.t;
}

function inboxNotTrash(alias = 'v'): string {
  return (
    `EXISTS (SELECT 1 FROM video_labels WHERE video_id = ${alias}.id AND label_id = ${INBOX})` +
    ` AND NOT EXISTS (SELECT 1 FROM video_labels WHERE video_id = ${alias}.id AND label_id = ${TRASH})`
  );
}

/** Inbox items whose first in-app finish is older than `hours`. Empty if hours is 0. */
export function inboxFinishedIds(db: DatabaseSync, hours: number): number[] {
  if (hours <= 0) return [];
  const cutoff = isoCutoff(db, `-${hours} hours`);
  return (db.prepare(
    `SELECT v.id FROM videos v
     WHERE v.finished_at IS NOT NULL
       AND v.finished_at <= ?
       AND ${inboxNotTrash('v')}`
  ).all(cutoff) as { id: number }[]).map(r => r.id);
}

/**
 * Inbox items whose last in-app activity is older than `days`.
 * Activity = max(added_at, started_at, finished_at). RSS/Overcast fetch is ignored.
 */
export function inboxInactiveIds(db: DatabaseSync, days: number): number[] {
  if (days <= 0) return [];
  const cutoff = isoCutoff(db, `-${days} days`);
  return (db.prepare(
    `SELECT v.id FROM videos v
     WHERE ${inboxNotTrash('v')}
       AND MAX(v.added_at, COALESCE(v.started_at, ''), COALESCE(v.finished_at, '')) <= ?`
  ).all(cutoff) as { id: number }[]).map(r => r.id);
}

export function trashIds(db: DatabaseSync): number[] {
  return (db.prepare(
    `SELECT DISTINCT video_id AS id FROM video_labels WHERE label_id = ${TRASH}`
  ).all() as { id: number }[]).map(r => r.id);
}

export function trashOlderIds(db: DatabaseSync, days: number): number[] {
  if (days <= 0) return [];
  const cutoff = isoCutoff(db, `-${days} days`);
  return (db.prepare(
    `SELECT video_id AS id FROM video_labels
     WHERE label_id = ${TRASH} AND labeled_at <= ?`
  ).all(cutoff) as { id: number }[]).map(r => r.id);
}

/** Trash items that have sat long enough for audio to be stripped. 0 = never. */
export function trashAudioDueIds(db: DatabaseSync, seconds: number): number[] {
  if (seconds <= 0) return [];
  const cutoff = isoCutoff(db, `-${seconds} seconds`);
  return (db.prepare(
    `SELECT video_id AS id FROM video_labels
     WHERE label_id = ${TRASH} AND labeled_at <= ?`
  ).all(cutoff) as { id: number }[]).map(r => r.id);
}

export function stampStarted(db: DatabaseSync, id: number): boolean {
  if (!db.prepare('SELECT id FROM videos WHERE id = ?').get(id)) return false;
  db.prepare(
    `UPDATE videos SET
       started_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
       status = CASE WHEN status = 'new' THEN 'started' ELSE status END
     WHERE id = ?`
  ).run(id);
  return true;
}

export function stampFinished(db: DatabaseSync, id: number): boolean {
  if (!db.prepare('SELECT id FROM videos WHERE id = ?').get(id)) return false;
  db.prepare(
    `UPDATE videos SET
       status = 'finished',
       finished_at = COALESCE(finished_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
     WHERE id = ?`
  ).run(id);
  return true;
}
