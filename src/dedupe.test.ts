import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { externalIdFor } from './ingest/classify';
import { chooseKeeper, isUniqueConstraint, type DedupeCandidate } from './dedupe';

const dir = mkdtempSync(path.join(tmpdir(), 'vw-dedupe-'));
process.env.WATCHLIST_DB = path.join(dir, 'watchlist.db');

let db: typeof import('./db.ts');

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function row(partial: Partial<DedupeCandidate> & Pick<DedupeCandidate, 'id'>): DedupeCandidate {
  return {
    status: 'new',
    finished_at: null,
    audio_status: 'none',
    audio_fetched_at: null,
    summary: null,
    labels: [{ label_id: 1 }],
    ...partial,
  };
}

describe('chooseKeeper', () => {
  it('keeps the ready fetched copy over an older failed copy', () => {
    const kept = chooseKeeper([
      row({ id: 692, audio_status: 'failed' }),
      row({ id: 695, audio_status: 'ready', audio_fetched_at: '2026-09-08T11:18:31Z' }),
    ]);
    assert.equal(kept.id, 695);
  });

  it('keeps the older row when both copies are otherwise equal', () => {
    const kept = chooseKeeper([
      row({ id: 853, audio_status: 'ready', audio_fetched_at: '2026-10-04T03:48:57Z' }),
      row({ id: 856, audio_status: 'ready' }),
    ]);
    assert.equal(kept.id, 853);
  });

  it('keeps a started Trash row over older untouched Trash copies', () => {
    const kept = chooseKeeper([
      row({ id: 27, labels: [{ label_id: 2 }], audio_status: 'none' }),
      row({ id: 551, labels: [{ label_id: 2 }], audio_status: 'deleted' }),
      row({ id: 572, labels: [{ label_id: 2 }], status: 'started', audio_status: 'deleted', audio_fetched_at: '2026-08-16T14:56:57Z' }),
    ]);
    assert.equal(kept.id, 572);
  });

  it('prefers an active row over a Trash twin', () => {
    const kept = chooseKeeper([
      row({ id: 1, labels: [{ label_id: 2 }], audio_status: 'ready' }),
      row({ id: 2, labels: [{ label_id: 1 }], audio_status: 'none' }),
    ]);
    assert.equal(kept.id, 2);
  });
});

describe('isUniqueConstraint', () => {
  it('recognizes the node:sqlite unique-index error', () => {
    const mem = new DatabaseSync(':memory:');
    mem.exec('CREATE TABLE t (k TEXT)');
    mem.exec('CREATE UNIQUE INDEX u ON t(k)');
    mem.prepare('INSERT INTO t (k) VALUES (?)').run('a');
    try {
      mem.prepare('INSERT INTO t (k) VALUES (?)').run('a');
      assert.fail('expected unique constraint');
    } catch (err) {
      assert.equal(isUniqueConstraint(err), true);
    }
    mem.close();
  });
});

describe('addVideoDeduped', { concurrency: false }, () => {
  before(async () => {
    db = await import('./db.ts');
  });

  it('stores one row when the same YouTube video is posted with a new title and URL form', () => {
    const firstUrl = 'https://www.youtube.com/watch?v=cy_KQor_wgE';
    const secondUrl = 'https://youtu.be/cy_KQor_wgE?si=abc';
    const externalId = externalIdFor('youtube', firstUrl);
    assert.equal(externalIdFor('youtube', secondUrl), externalId);

    const first = db.addVideoDeduped(
      firstUrl, 'Original title', 'Channel', '📺', undefined, 'youtube', 'video', undefined, externalId,
    );
    const second = db.addVideoDeduped(
      secondUrl, 'Retitled later', 'Channel', '📺', undefined, 'youtube', 'video', undefined, externalId,
    );

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.video.id, first.video.id);
    assert.equal(second.video.title, 'Original title');
    assert.equal(second.video.url, firstUrl);
    assert.equal(second.video.external_id, 'cy_KQor_wgE');
    assert.equal(db.getVideoById(first.video.id + 1), null);
  });

  it('returns a trashed row unchanged instead of inserting another', () => {
    const url = 'https://www.youtube.com/watch?v=AAAAAAAAAAA';
    const externalId = externalIdFor('youtube', url);
    const created = db.addVideoDeduped(
      url, 'Keep this title', 'Channel', '📺', undefined, 'youtube', 'video', undefined, externalId,
    );
    assert.equal(created.video.id, 2);
    assert.equal(db.trashVideo(created.video.id), true);

    const again = db.addVideoDeduped(
      'https://youtu.be/AAAAAAAAAAA', 'A different title', 'Other', '📺', undefined,
      'youtube', 'video', undefined, externalId,
    );
    assert.equal(again.created, false);
    assert.equal(again.video.id, created.video.id);
    assert.equal(again.video.title, 'Keep this title');
    assert.equal(again.video.labels.some(l => l.label_id === 2), true);
    assert.equal(db.getVideoById(3), null);
  });
});
