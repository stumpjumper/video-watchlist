import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  inboxFinishedIds, inboxInactiveIds, trashIds, trashOlderIds, trashAudioDueIds,
  stampStarted, stampFinished, parseLifecycleInt,
} from './lifecycle';

function isoAgo(db: DatabaseSync, modifier: string): string {
  return (db.prepare(
    `SELECT strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now', ?)) AS t`
  ).get(modifier) as { t: string }).t;
}

function open(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL DEFAULT 'http://example.test',
      title TEXT NOT NULL DEFAULT 't',
      channel_name TEXT NOT NULL DEFAULT '',
      emoji TEXT NOT NULL DEFAULT '',
      added_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      audio_status TEXT NOT NULL DEFAULT 'none',
      audio_fetched_at TEXT
    );
    CREATE TABLE video_labels (
      video_id INTEGER NOT NULL,
      label_id INTEGER NOT NULL,
      labeled_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      PRIMARY KEY (video_id, label_id)
    );
  `);
  return db;
}

function insert(
  db: DatabaseSync,
  opts: {
    labels: number[];
    added_at: string;
    started_at?: string | null;
    finished_at?: string | null;
    fetched_at?: string | null;
    trash_labeled_at?: string;
  },
): number {
  const info = db.prepare(
    `INSERT INTO videos (added_at, started_at, finished_at, audio_fetched_at, status)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    opts.added_at,
    opts.started_at ?? null,
    opts.finished_at ?? null,
    opts.fetched_at ?? null,
    opts.finished_at ? 'finished' : opts.started_at ? 'started' : 'new',
  );
  const id = Number(info.lastInsertRowid);
  const ins = db.prepare(
    `INSERT INTO video_labels (video_id, label_id, labeled_at) VALUES (?, ?, ?)`
  );
  for (const lid of opts.labels) {
    const when = lid === 2 && opts.trash_labeled_at ? opts.trash_labeled_at : opts.added_at;
    ins.run(id, lid, when);
  }
  return id;
}

describe('parseLifecycleInt', () => {
  it('treats 0 as off, missing as fallback, junk as fallback', () => {
    assert.equal(parseLifecycleInt('0', 24), 0);
    assert.equal(parseLifecycleInt(undefined, 24), 24);
    assert.equal(parseLifecycleInt('', 24), 24);
    assert.equal(parseLifecycleInt('nope', 30), 30);
    assert.equal(parseLifecycleInt('-3', 30), 30);
    assert.equal(parseLifecycleInt('24', 1), 24);
  });
});

describe('inbox finished → trash', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = open(); });

  it('selects Inbox finished older than the window, not newer', () => {
    const oldId = insert(db, {
      labels: [1],
      added_at: isoAgo(db, '-40 hours'),
      finished_at: isoAgo(db, '-25 hours'),
    });
    insert(db, {
      labels: [1],
      added_at: isoAgo(db, '-2 hours'),
      finished_at: isoAgo(db, '-2 hours'),
    });
    assert.deepEqual(inboxFinishedIds(db, 24), [oldId]);
  });

  it('skips filed items (no Inbox) even if finished long ago', () => {
    insert(db, {
      labels: [3],
      added_at: isoAgo(db, '-40 hours'),
      finished_at: isoAgo(db, '-40 hours'),
    });
    assert.deepEqual(inboxFinishedIds(db, 24), []);
  });

  it('skips Trash', () => {
    insert(db, {
      labels: [2],
      added_at: isoAgo(db, '-40 hours'),
      finished_at: isoAgo(db, '-40 hours'),
    });
    assert.deepEqual(inboxFinishedIds(db, 24), []);
  });

  it('hours=0 selects nothing', () => {
    insert(db, {
      labels: [1],
      added_at: isoAgo(db, '-40 hours'),
      finished_at: isoAgo(db, '-40 hours'),
    });
    assert.deepEqual(inboxFinishedIds(db, 0), []);
  });
});

describe('inbox inactive → trash', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = open(); });

  it('selects Inbox whose only stamp is an old added_at', () => {
    const oldId = insert(db, { labels: [1], added_at: isoAgo(db, '-31 days') });
    insert(db, { labels: [1], added_at: isoAgo(db, '-2 days') });
    assert.deepEqual(inboxInactiveIds(db, 30), [oldId]);
  });

  it('a recent open (started_at) saves an otherwise-stale add', () => {
    insert(db, {
      labels: [1],
      added_at: isoAgo(db, '-40 days'),
      started_at: isoAgo(db, '-2 days'),
    });
    assert.deepEqual(inboxInactiveIds(db, 30), []);
  });

  it('audio_fetched_at does not count as activity', () => {
    const id = insert(db, {
      labels: [1],
      added_at: isoAgo(db, '-40 days'),
      fetched_at: isoAgo(db, '-1 hours'),
    });
    assert.deepEqual(inboxInactiveIds(db, 30), [id]);
  });

  it('filed library items are exempt', () => {
    insert(db, { labels: [3], added_at: isoAgo(db, '-40 days') });
    assert.deepEqual(inboxInactiveIds(db, 30), []);
  });

  it('days=0 selects nothing', () => {
    insert(db, { labels: [1], added_at: isoAgo(db, '-40 days') });
    assert.deepEqual(inboxInactiveIds(db, 0), []);
  });
});

describe('stamps', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = open(); });

  it('stampStarted writes started_at every time and does not un-finish', () => {
    const id = insert(db, {
      labels: [1],
      added_at: isoAgo(db, '-2 days'),
      finished_at: isoAgo(db, '-1 days'),
    });
    assert.equal(stampStarted(db, id), true);
    const row = db.prepare('SELECT status, started_at, finished_at FROM videos WHERE id = ?').get(id) as {
      status: string; started_at: string; finished_at: string;
    };
    assert.equal(row.status, 'finished');
    assert.ok(row.started_at);
    const first = row.started_at;
    // second stamp must move started_at (or at least not fail)
    stampStarted(db, id);
    const row2 = db.prepare('SELECT started_at, status FROM videos WHERE id = ?').get(id) as {
      started_at: string; status: string;
    };
    assert.equal(row2.status, 'finished');
    assert.ok(row2.started_at >= first);
  });

  it('stampFinished does not move finished_at on a second call', () => {
    const id = insert(db, { labels: [1], added_at: isoAgo(db, '-2 days') });
    stampFinished(db, id);
    const first = (db.prepare('SELECT finished_at FROM videos WHERE id = ?').get(id) as { finished_at: string }).finished_at;
    stampFinished(db, id);
    const second = (db.prepare('SELECT finished_at FROM videos WHERE id = ?').get(id) as { finished_at: string }).finished_at;
    assert.equal(second, first);
  });

  it('unknown id returns false', () => {
    assert.equal(stampStarted(db, 999), false);
    assert.equal(stampFinished(db, 999), false);
  });
});

describe('trash clocks', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = open(); });

  it('lists current trash ids', () => {
    const id = insert(db, { labels: [2], added_at: isoAgo(db, '-1 days') });
    insert(db, { labels: [1], added_at: isoAgo(db, '-1 days') });
    assert.deepEqual(trashIds(db), [id]);
  });

  it('purge selects trash older than the window, not newer', () => {
    const oldId = insert(db, {
      labels: [2],
      added_at: isoAgo(db, '-40 days'),
      trash_labeled_at: isoAgo(db, '-31 days'),
    });
    insert(db, {
      labels: [2],
      added_at: isoAgo(db, '-2 days'),
      trash_labeled_at: isoAgo(db, '-2 days'),
    });
    assert.deepEqual(trashOlderIds(db, 30), [oldId]);
  });

  it('days=0 selects nothing to purge', () => {
    insert(db, {
      labels: [2],
      added_at: isoAgo(db, '-40 days'),
      trash_labeled_at: isoAgo(db, '-40 days'),
    });
    assert.deepEqual(trashOlderIds(db, 0), []);
  });

  it('audio strip waits the grace window, then is due', () => {
    const due = insert(db, {
      labels: [2],
      added_at: isoAgo(db, '-2 hours'),
      trash_labeled_at: isoAgo(db, '-90 seconds'),
    });
    insert(db, {
      labels: [2],
      added_at: isoAgo(db, '-2 hours'),
      trash_labeled_at: isoAgo(db, '-10 seconds'),
    });
    assert.deepEqual(trashAudioDueIds(db, 60), [due]);
    assert.deepEqual(trashAudioDueIds(db, 0), []);
  });
});
