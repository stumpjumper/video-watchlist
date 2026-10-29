import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { resolveSource } from './ingest';

const dir = mkdtempSync(path.join(tmpdir(), 'vw-episode-'));
process.env.WATCHLIST_DB = path.join(dir, 'watchlist.db');
process.env.WATCHLIST_TEXT_DIR = path.join(dir, 'text');
delete process.env.XAI_API_KEY_WATCHLIST;

type EpisodeModule = typeof import('./episode.ts');
type AudioModule = typeof import('./audio.ts');
type DbModule = typeof import('./db.ts');

let createEpisode: EpisodeModule['createEpisode'];
let EpisodeError: EpisodeModule['EpisodeError'];
let isLoopbackAddress: EpisodeModule['isLoopbackAddress'];
let splitTtsText: AudioModule['splitTtsText'];
let renderXaiAudio: AudioModule['renderXaiAudio'];
let writePcmWav: AudioModule['writePcmWav'];
let XaiTtsError: AudioModule['XaiTtsError'];
let textPath: AudioModule['textPath'];
let getVideos: DbModule['getVideos'];

before(async () => {
  const episode = await import('./episode.ts');
  const audio = await import('./audio.ts');
  const db = await import('./db.ts');
  createEpisode = episode.createEpisode;
  EpisodeError = episode.EpisodeError;
  isLoopbackAddress = episode.isLoopbackAddress;
  splitTtsText = audio.splitTtsText;
  renderXaiAudio = audio.renderXaiAudio;
  writePcmWav = audio.writePcmWav;
  XaiTtsError = audio.XaiTtsError;
  textPath = audio.textPath;
  getVideos = db.getVideos;
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const base = {
  text: 'First script.',
  title: 'Morning note',
  channel_name: 'Ada Lovelace',
  published_at: '2026-10-28',
  url: 'https://www.example.com/notes/morning?utm_source=mail',
};

describe('origin url is stored, not fetched', () => {
  it('keeps the caller metadata and dedupes on the origin', async () => {
    const prev = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('episode create must not fetch'); };
    try {
      const first = await createEpisode(base);
      assert.equal(first.created, true);
      assert.equal(first.video.source, 'ai_update');
      assert.equal(first.video.channel_name, 'Ada Lovelace');
      assert.equal(first.video.published_at, '2026-10-28');
      assert.equal(first.video.url, 'https://example.com/notes/morning');
      assert.equal(readFileSync(textPath(first.video.id), 'utf8'), 'First script.');
      assert.ok(first.video.labels.some(l => l.label_id === 1));

      const again = await createEpisode({ ...base, text: 'Replacement.', title: 'Other title' });
      assert.equal(again.created, false);
      assert.equal(again.video.id, first.video.id);
      assert.equal(again.video.title, 'Morning note');
      assert.equal(readFileSync(textPath(first.video.id), 'utf8'), 'First script.');
    } finally {
      globalThis.fetch = prev;
    }
  });

  it('treats two YouTube URL shapes as the same episode', async () => {
    const watch = await createEpisode({
      ...base,
      title: 'Talk',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    });
    const short = await createEpisode({
      ...base,
      title: 'Talk again',
      text: 'Different.',
      url: 'https://youtu.be/dQw4w9WgXcQ',
    });
    assert.equal(short.created, false);
    assert.equal(short.video.id, watch.video.id);
    assert.equal(readFileSync(textPath(watch.video.id), 'utf8'), 'First script.');
  });

  it('rejects a missing creator, a bad date, and a non-http url', async () => {
    await assert.rejects(() => createEpisode({ ...base, channel_name: '  ' }), EpisodeError);
    await assert.rejects(() => createEpisode({ ...base, published_at: '2026-02-31' }), EpisodeError);
    await assert.rejects(() => createEpisode({ ...base, url: 'ftp://example.com/a' }), EpisodeError);
  });

  it('does not insert when an xAI voice is requested and the key is missing', async () => {
    const beforeCount = getVideos().length;
    await assert.rejects(
      () => createEpisode({ ...base, url: 'https://example.com/needs-key', voice: 'ara' }),
      (err: unknown) => err instanceof EpisodeError && err.status === 400 && /XAI_API_KEY_WATCHLIST/.test(err.message),
    );
    assert.equal(getVideos().length, beforeCount);
  });
});

describe('ai_update is not a URL-add source', () => {
  it('classifies a web URL as web even if the client asks for ai_update', () => {
    assert.equal(resolveSource('https://example.com/story', 'ai_update').source, 'web');
  });
});

describe('loopback gate', () => {
  it('accepts only local addresses', () => {
    assert.equal(isLoopbackAddress('127.0.0.1'), true);
    assert.equal(isLoopbackAddress('::1'), true);
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
    assert.equal(isLoopbackAddress('100.104.14.6'), false);
    assert.equal(isLoopbackAddress(undefined), false);
  });
});

describe('splitTtsText', () => {
  it('returns one chunk when the text fits', () => {
    assert.deepEqual(splitTtsText('Hello there.', 50), ['Hello there.']);
  });

  it('splits over the cap without dropping words', () => {
    const words = Array.from({ length: 30 }, (_, i) => `word${i}`);
    const text = words.join(' ');
    const chunks = splitTtsText(text, 40);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every(chunk => chunk.length <= 40));
    assert.equal(chunks.join(' ').replace(/\s+/g, ' '), text);
  });
});

describe('renderXaiAudio', () => {
  it('fails before any request when the key is missing', async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => { called = true; return new Response(); };
    await assert.rejects(
      () => renderXaiAudio('Hello.', path.join(dir, 'missing.m4a'), 'ara', fetchImpl),
      (err: unknown) => err instanceof XaiTtsError && err.retryable === false,
    );
    assert.equal(called, false);
  });

  it('rejects a JSON body', async () => {
    process.env.XAI_API_KEY_WATCHLIST = 'test-key-not-real';
    try {
      const fetchImpl: typeof fetch = async () => new Response(
        JSON.stringify({ error: 'nope' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
      await assert.rejects(
        () => renderXaiAudio('Hello.', path.join(dir, 'json.m4a'), 'ara', fetchImpl),
        (err: unknown) => err instanceof XaiTtsError && /non-audio/.test(err.message),
      );
    } finally {
      delete process.env.XAI_API_KEY_WATCHLIST;
    }
  });

  it('encodes a wav response to m4a', async () => {
    process.env.XAI_API_KEY_WATCHLIST = 'test-key-not-real';
    const wav = writePcmWav(
      { channels: 1, sampleRate: 24000, bitsPerSample: 16 },
      Buffer.alloc(4000),
    );
    const outFile = path.join(dir, 'ok.m4a');
    try {
      const fetchImpl: typeof fetch = async (_url, init) => {
        const headers = new Headers(init?.headers);
        assert.equal(headers.get('authorization'), 'Bearer test-key-not-real');
        const body = JSON.parse(String(init?.body));
        assert.equal(body.voice_id, 'rex');
        assert.equal(body.output_format.codec, 'wav');
        return new Response(wav, { status: 200, headers: { 'content-type': 'audio/wav', 'x-request-id': 'req-1' } });
      };
      await renderXaiAudio('Hello from rex.', outFile, 'rex', fetchImpl);
      const stat = readFileSync(outFile);
      assert.ok(stat.length > 100);
    } finally {
      delete process.env.XAI_API_KEY_WATCHLIST;
    }
  });
});
