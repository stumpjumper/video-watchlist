import { DatabaseSync } from 'node:sqlite';
import path from 'path';

const db = new DatabaseSync(path.join(__dirname, '..', 'watchlist.db'));

db.exec('PRAGMA foreign_keys = ON');

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

// legacy column additions (old DBs pre-V2)
try { db.exec('ALTER TABLE videos ADD COLUMN started_at TEXT'); } catch {}
try { db.exec('ALTER TABLE videos ADD COLUMN removed_at TEXT'); } catch {}
try { db.exec('ALTER TABLE videos ADD COLUMN summary TEXT'); } catch {}

// legacy status value migrations
db.exec(`UPDATE videos SET status = 'new'     WHERE status = 'unplayed'`);
db.exec(`UPDATE videos SET status = 'started' WHERE status = 'played'`);
db.exec(`UPDATE videos SET started_at = played_at WHERE played_at IS NOT NULL AND started_at IS NULL`);

// V3 prep columns (idempotent)
try { db.exec(`ALTER TABLE videos ADD COLUMN source TEXT NOT NULL DEFAULT 'youtube'`); } catch {}
try { db.exec(`ALTER TABLE videos ADD COLUMN content_type TEXT NOT NULL DEFAULT 'video'`); } catch {}
try { db.exec(`ALTER TABLE videos ADD COLUMN external_id TEXT`); } catch {}
try { db.exec(`ALTER TABLE videos ADD COLUMN source_metadata TEXT`); } catch {}

// V2 migration: labels system
const { user_version: userVersion } = db.prepare('PRAGMA user_version').get() as { user_version: number };

if (userVersion < 1) {
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS labels (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT    NOT NULL UNIQUE,
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS video_labels (
        video_id   INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        label_id   INTEGER NOT NULL REFERENCES labels(id),
        labeled_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        PRIMARY KEY (video_id, label_id)
      )
    `);
    db.exec(`INSERT OR IGNORE INTO labels (id, name) VALUES (1, 'Inbox')`);
    db.exec(`INSERT OR IGNORE INTO labels (id, name) VALUES (2, 'Trash')`);
    // active videos → Inbox
    db.exec(`
      INSERT OR IGNORE INTO video_labels (video_id, label_id, labeled_at)
      SELECT id, 1, added_at FROM videos WHERE status IN ('new', 'started')
    `);
    // removed videos → Trash
    db.exec(`
      INSERT OR IGNORE INTO video_labels (video_id, label_id, labeled_at)
      SELECT id, 2, COALESCE(removed_at, added_at) FROM videos WHERE status = 'removed'
    `);
    // normalize: Trash label carries the removed semantic now
    db.exec(`UPDATE videos SET status = 'new' WHERE status = 'removed'`);
    db.exec('PRAGMA user_version = 1');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface Label {
  id: number;
  name: string;
  created_at: string;
}

export interface VideoLabel {
  label_id: number;
  label_name: string;
  labeled_at: string;
}

export interface Video {
  id: number;
  url: string;
  title: string;
  channel_name: string;
  emoji: string;
  added_at: string;
  status: string;
  summary: string | null;
  source: string;
  content_type: string;
  external_id: string | null;
  source_metadata: string | null;
  labels: VideoLabel[];
}

export interface VideoFilter {
  q?: string;
  after?: string;
  before?: string;
  labels?: number[];
  label_mode?: 'and' | 'or';
  source?: string;
}

// ── Internal helpers ────────────────────────────────────────────────────────

function attachLabels(videos: Omit<Video, 'labels'>[]): Video[] {
  if (videos.length === 0) return [];
  const ids = videos.map(v => v.id);
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT vl.video_id, vl.label_id, l.name AS label_name, vl.labeled_at
    FROM video_labels vl JOIN labels l ON l.id = vl.label_id
    WHERE vl.video_id IN (${ph})
    ORDER BY vl.labeled_at
  `).all(...ids) as { video_id: number; label_id: number; label_name: string; labeled_at: string }[];

  const labelMap = new Map<number, VideoLabel[]>();
  for (const row of rows) {
    if (!labelMap.has(row.video_id)) labelMap.set(row.video_id, []);
    labelMap.get(row.video_id)!.push({
      label_id: row.label_id,
      label_name: row.label_name,
      labeled_at: row.labeled_at,
    });
  }
  return videos.map(v => ({ ...v, labels: labelMap.get(v.id) ?? [] }));
}

// ── Video queries ──────────────────────────────────────────────────────────

export function getVideos(filter: VideoFilter = {}): Video[] {
  const { q, after, before, labels, label_mode = 'or', source } = filter;
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  const requestingTrash = labels && labels.includes(2);

  if (!labels || labels.length === 0) {
    conditions.push('EXISTS (SELECT 1 FROM video_labels WHERE video_id = v.id AND label_id = 1)');
    conditions.push('NOT EXISTS (SELECT 1 FROM video_labels WHERE video_id = v.id AND label_id = 2)');
  } else if (label_mode === 'and') {
    for (const lid of labels) {
      conditions.push('EXISTS (SELECT 1 FROM video_labels WHERE video_id = v.id AND label_id = ?)');
      params.push(lid);
    }
    if (!requestingTrash) conditions.push('NOT EXISTS (SELECT 1 FROM video_labels WHERE video_id = v.id AND label_id = 2)');
  } else {
    const lph = labels.map(() => '?').join(',');
    conditions.push(`EXISTS (SELECT 1 FROM video_labels WHERE video_id = v.id AND label_id IN (${lph}))`);
    params.push(...labels);
    if (!requestingTrash) conditions.push('NOT EXISTS (SELECT 1 FROM video_labels WHERE video_id = v.id AND label_id = 2)');
  }

  if (q) {
    conditions.push('(LOWER(v.title) LIKE ? OR LOWER(v.channel_name) LIKE ?)');
    const like = `%${q.toLowerCase()}%`;
    params.push(like, like);
  }
  if (after)  { conditions.push('v.added_at >= ?'); params.push(after); }
  if (before) { conditions.push('v.added_at <= ?'); params.push(before); }
  if (source) { conditions.push('v.source = ?'); params.push(source); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const rows = db.prepare(`SELECT * FROM videos v ${where} ORDER BY v.added_at DESC`).all(...params) as Omit<Video, 'labels'>[];
  return attachLabels(rows);
}

export function getVideoById(id: number): Video | null {
  const row = db.prepare('SELECT * FROM videos WHERE id = ?').get(id) as Omit<Video, 'labels'> | undefined;
  if (!row) return null;
  return attachLabels([row])[0];
}

export function addVideo(
  url: string,
  title: string,
  channel_name: string,
  emoji: string,
  summary?: string,
  source?: string,
  content_type?: string,
  source_metadata?: string,
): Video {
  const info = db.prepare(
    `INSERT INTO videos (url, title, channel_name, emoji, status, summary, source, content_type, source_metadata)
     VALUES (?, ?, ?, ?, 'new', ?, ?, ?, ?)`
  ).run(
    url, title, channel_name, emoji,
    summary ?? null,
    source ?? 'youtube',
    content_type ?? 'video',
    source_metadata ?? null,
  );
  const id = info.lastInsertRowid as number;
  db.prepare(`INSERT INTO video_labels (video_id, label_id) VALUES (?, 1)`).run(id);
  return getVideoById(id)!;
}

export function getCategories(): { source: string; count: number }[] {
  return db.prepare(
    `SELECT source, COUNT(*) AS count FROM videos
     WHERE EXISTS (SELECT 1 FROM video_labels WHERE video_id = videos.id AND label_id = 1)
     GROUP BY source ORDER BY source`
  ).all() as { source: string; count: number }[];
}

export function hardDelete(id: number): boolean {
  return (db.prepare('DELETE FROM videos WHERE id = ?').run(id).changes as number) > 0;
}

export function markStarted(id: number): boolean {
  return (db.prepare(`UPDATE videos SET status = 'started' WHERE id = ?`).run(id).changes as number) > 0;
}

export function markFinished(id: number): boolean {
  return (db.prepare(`UPDATE videos SET status = 'finished' WHERE id = ?`).run(id).changes as number) > 0;
}

export function saveSummary(id: number, summary: string): boolean {
  return (db.prepare('UPDATE videos SET summary = ? WHERE id = ?').run(summary, id).changes as number) > 0;
}

// ── Label management ────────────────────────────────────────────────────────

export function getLabels(): Label[] {
  return db.prepare('SELECT * FROM labels ORDER BY id').all() as Label[];
}

export function createLabel(name: string): Label | null {
  try {
    const info = db.prepare('INSERT INTO labels (name) VALUES (?)').run(name.trim());
    return db.prepare('SELECT * FROM labels WHERE id = ?').get(info.lastInsertRowid) as Label;
  } catch {
    return null; // duplicate name
  }
}

export function deleteLabel(id: number): { ok: boolean; reason?: string } {
  if (id === 1 || id === 2) return { ok: false, reason: 'system label' };
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM video_labels WHERE label_id = ?').get(id) as { n: number };
  if (n > 0) return { ok: false, reason: 'label in use' };
  db.prepare('DELETE FROM labels WHERE id = ?').run(id);
  return { ok: true };
}

// ── Label assignment ────────────────────────────────────────────────────────

export function addLabelToVideo(videoId: number, labelId: number): boolean {
  if (!db.prepare('SELECT id FROM videos WHERE id = ?').get(videoId)) return false;
  db.prepare(
    `INSERT OR IGNORE INTO video_labels (video_id, label_id, labeled_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`
  ).run(videoId, labelId);
  return true;
}

export function removeLabelFromVideo(videoId: number, labelId: number): { ok: boolean; restoredInbox: boolean } {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM video_labels WHERE video_id = ?').get(videoId) as { n: number };
  if (n <= 1) {
    if (labelId === 1) return { ok: false, restoredInbox: false };
    // last label: restore Inbox before removing
    db.prepare(
      `INSERT OR IGNORE INTO video_labels (video_id, label_id, labeled_at) VALUES (?, 1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`
    ).run(videoId);
    db.prepare('DELETE FROM video_labels WHERE video_id = ? AND label_id = ?').run(videoId, labelId);
    return { ok: true, restoredInbox: true };
  }
  db.prepare('DELETE FROM video_labels WHERE video_id = ? AND label_id = ?').run(videoId, labelId);
  return { ok: true, restoredInbox: false };
}

export function setVideoLabels(videoId: number, labelIds: number[]): boolean {
  if (!db.prepare('SELECT id FROM videos WHERE id = ?').get(videoId)) return false;
  const finalIds = labelIds.length === 0 ? [1] : labelIds; // enforce min one label (default Inbox)
  const current = (db.prepare('SELECT label_id FROM video_labels WHERE video_id = ?').all(videoId) as { label_id: number }[]).map(r => r.label_id);
  for (const lid of current) {
    if (!finalIds.includes(lid)) db.prepare('DELETE FROM video_labels WHERE video_id = ? AND label_id = ?').run(videoId, lid);
  }
  for (const lid of finalIds) {
    if (!current.includes(lid)) db.prepare(
      `INSERT OR IGNORE INTO video_labels (video_id, label_id, labeled_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`
    ).run(videoId, lid);
  }
  return true;
}

export function archiveVideo(videoId: number, labelIds: number[]): boolean {
  const validIds = labelIds.filter(id => id !== 1 && id !== 2);
  if (validIds.length === 0) return false;
  if (!db.prepare('SELECT id FROM videos WHERE id = ?').get(videoId)) return false;
  for (const lid of validIds) {
    db.prepare(
      `INSERT OR IGNORE INTO video_labels (video_id, label_id, labeled_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`
    ).run(videoId, lid);
  }
  db.prepare('DELETE FROM video_labels WHERE video_id = ? AND label_id = 1').run(videoId);
  return true;
}

export function trashVideo(videoId: number): boolean {
  if (!db.prepare('SELECT id FROM videos WHERE id = ?').get(videoId)) return false;
  db.prepare(
    `INSERT OR IGNORE INTO video_labels (video_id, label_id, labeled_at) VALUES (?, 2, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`
  ).run(videoId);
  db.prepare('DELETE FROM video_labels WHERE video_id = ? AND label_id = 1').run(videoId);
  return true;
}

export function restoreFromTrash(videoId: number): boolean {
  if (!db.prepare('SELECT id FROM videos WHERE id = ?').get(videoId)) return false;
  db.prepare('DELETE FROM video_labels WHERE video_id = ? AND label_id = 2').run(videoId);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM video_labels WHERE video_id = ?').get(videoId) as { n: number };
  if (n === 0) {
    db.prepare(
      `INSERT INTO video_labels (video_id, label_id, labeled_at) VALUES (?, 1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`
    ).run(videoId);
  }
  return true;
}

export function getTrashCount(): number {
  return (db.prepare('SELECT COUNT(DISTINCT video_id) AS n FROM video_labels WHERE label_id = 2').get() as { n: number }).n;
}

export function purgeTrash(): number {
  const rows = db.prepare('SELECT video_id FROM video_labels WHERE label_id = 2').all() as { video_id: number }[];
  if (rows.length === 0) return 0;
  const ids = rows.map(r => r.video_id);
  const ph = ids.map(() => '?').join(',');
  return (db.prepare(`DELETE FROM videos WHERE id IN (${ph})`).run(...ids).changes as number);
}
