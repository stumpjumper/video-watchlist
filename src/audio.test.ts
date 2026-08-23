import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { unlink, stat } from 'fs/promises';
import path from 'path';
import { tmpdir } from 'os';
import {
  parseWav, writePcmWav, silentPcmWav, concatPcmWavs,
  renderArticleAudio, SAY_CLOSER_SILENCE_SEC,
} from './audio';

const execFileAsync = promisify(execFile);

const FMT = { channels: 1, sampleRate: 22050, bitsPerSample: 16 as const };

function pcmFilled(nSamples: number, value: number): Buffer {
  const pcm = Buffer.alloc(nSamples * 2);
  for (let i = 0; i < nSamples; i++) pcm.writeInt16LE(value, i * 2);
  return pcm;
}

describe('pcm wav concat', () => {
  it('round-trips a standard header', () => {
    const pcm = pcmFilled(10, 1234);
    const wav = writePcmWav(FMT, pcm);
    const parsed = parseWav(wav);
    assert.equal(parsed.channels, 1);
    assert.equal(parsed.sampleRate, 22050);
    assert.equal(parsed.bitsPerSample, 16);
    assert.equal(parsed.pcm.length, 20);
    assert.equal(parsed.pcm.readInt16LE(0), 1234);
  });

  it('parses a fmt chunk with a pad byte after an odd-sized preceding chunk', () => {
    // RIFF/WAVE + odd-sized LIST-like junk (1 byte payload + pad) + fmt + data
    const pcm = pcmFilled(4, 7);
    const inner = writePcmWav(FMT, pcm);
    const junkSize = 1;
    const extra = 8 + junkSize + 1; // id+size + payload + pad
    const out = Buffer.alloc(inner.length + extra);
    inner.copy(out, 0, 0, 12);
    out.write('JUNK', 12);
    out.writeUInt32LE(junkSize, 16);
    out[20] = 0xAB;
    out[21] = 0x00; // pad
    inner.copy(out, 22, 12);
    out.writeUInt32LE(inner.readUInt32LE(4) + extra, 4);
    const parsed = parseWav(out);
    assert.equal(parsed.pcm.readInt16LE(0), 7);
    assert.equal(parsed.pcm.length, 8);
  });

  it('concatenates pcm in order and writes silence of the closer length', () => {
    const a = writePcmWav(FMT, pcmFilled(3, 1));
    const b = writePcmWav(FMT, pcmFilled(2, 2));
    const joined = concatPcmWavs([a, b]);
    const p = parseWav(joined);
    assert.equal(p.pcm.length, 10);
    assert.equal(p.pcm.readInt16LE(0), 1);
    assert.equal(p.pcm.readInt16LE(4), 1);
    assert.equal(p.pcm.readInt16LE(6), 2);

    const silence = silentPcmWav(SAY_CLOSER_SILENCE_SEC, FMT);
    const s = parseWav(silence);
    assert.equal(s.pcm.length, FMT.sampleRate * 2 * SAY_CLOSER_SILENCE_SEC);
    assert.ok(s.pcm.every(b => b === 0));
  });

  it('rejects a sample-rate mismatch', () => {
    const a = writePcmWav(FMT, pcmFilled(1, 1));
    const b = writePcmWav({ ...FMT, sampleRate: 44100 }, pcmFilled(1, 1));
    assert.throws(() => concatPcmWavs([a, b]), /mismatch/);
  });
});

describe('renderArticleAudio', { timeout: 120_000 }, () => {
  it('writes an m4a longer than the two silences', async () => {
    const outFile = path.join(tmpdir(), `watchlist-closer-smoke-${process.pid}.m4a`);
    try {
      await renderArticleAudio('Hello.', outFile);
      const st = await stat(outFile);
      assert.ok(st.size > 2000, `m4a too small: ${st.size}`);
      const { stdout } = await execFileAsync('/usr/bin/afinfo', [outFile]);
      const match = stdout.match(/estimated duration:\s*([\d.]+)\s*sec/);
      assert.ok(match, 'afinfo missing duration');
      const dur = parseFloat(match[1]);
      // 2s + closer + 2s, plus "Hello." — a 1s+1s closer would be ~4.1s.
      assert.ok(dur >= 5.5, `duration ${dur}s too short for 2s silences`);
      assert.ok(dur < 20, `duration ${dur}s unexpectedly long`);
    } finally {
      await unlink(outFile).catch(() => {});
    }
  });
});
