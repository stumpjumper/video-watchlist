import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, readFile, unlink, mkdir, stat, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { savePublishedAt } from './db';
import { extractDocument } from './ingest';

const execFileAsync = promisify(execFile);

export const AUDIO_DIR  = path.join(__dirname, '..', 'audio');
export const TEXT_DIR   = path.join(__dirname, '..', 'text');
export const SAY_VOICE  = process.env.SAY_VOICE ?? 'Ava (Premium)';
const YTDLP_PATH        = '/opt/homebrew/bin/yt-dlp';
const BROWSER_UA        = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

export function textPath(id: number): string {
  return path.join(TEXT_DIR, `${id}.txt`);
}

export async function textExists(id: number): Promise<boolean> {
  try { await stat(textPath(id)); return true; } catch { return false; }
}

export async function readCachedText(id: number): Promise<string | null> {
  try { return await readFile(textPath(id), 'utf8'); } catch { return null; }
}

export async function fetchAndCacheText(id: number, url: string): Promise<string> {
  const doc = await extractDocument(url);
  if (doc.nativeAudio || !doc.text) {
    throw new Error('this URL has no article text to cache');
  }
  await mkdir(TEXT_DIR, { recursive: true }).catch(() => {});
  await writeFile(textPath(id), doc.text, 'utf8').catch(() => {});
  if (doc.publishedAt) savePublishedAt(id, doc.publishedAt);
  return doc.text;
}

export function audioPath(id: number): string {
  return path.join(AUDIO_DIR, `${id}.m4a`);
}

export function audioUrl(id: number): string {
  return `/audio/${id}.m4a`;
}

export async function audioExists(id: number): Promise<boolean> {
  try { await stat(audioPath(id)); return true; } catch { return false; }
}

export async function probeAudioDuration(id: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/afinfo', [audioPath(id)]);
    const match = stdout.match(/estimated duration:\s*([\d.]+)\s*sec/);
    return match ? Math.round(parseFloat(match[1])) : null;
  } catch {
    return null;
  }
}

export async function audioDirSizeBytes(): Promise<number> {
  try {
    const files = await readdir(AUDIO_DIR);
    let total = 0;
    for (const f of files) {
      try { total += (await stat(path.join(AUDIO_DIR, f))).size; } catch {}
    }
    return total;
  } catch { return 0; }
}



function buildAudioHeader(title?: string, publishedAt?: string | null): string {
  const parts: string[] = [];
  if (title) parts.push(title);
  if (publishedAt) {
    const date = new Date(publishedAt);
    if (!isNaN(date.getTime())) {
      parts.push(date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }));
    }
  }
  return parts.join('. ');
}

// ── YouTube transcripts ──────────────────────────────────────────────────────
// Saved to text/<id>.txt — the same cache articles use, so the /api text
// endpoint, reader display, and lifecycle deletion all apply unchanged.

type CaptionFormat = { url?: string; ext?: string };
type CaptionPool = Record<string, CaptionFormat[]>;

// Prefer creator-uploaded subtitles over auto-generated captions ("transcript
// vs CC" is one data source with two origins). Within auto captions, en-orig
// is the untranslated ASR track.
function pickJson3Url(info: { subtitles?: CaptionPool; automatic_captions?: CaptionPool }): string | null {
  const fromPool = (pool: CaptionPool | undefined, prefs: string[]): string | null => {
    if (!pool) return null;
    const keys = Object.keys(pool);
    const ordered = [...prefs.filter(p => keys.includes(p)),
                     ...keys.filter(k => k.startsWith('en') && !prefs.includes(k))];
    for (const lang of ordered) {
      const fmt = (pool[lang] ?? []).find(f => f.ext === 'json3' && f.url);
      if (fmt) return fmt.url!;
    }
    return null;
  };
  return fromPool(info.subtitles, ['en', 'en-US', 'en-GB'])
      ?? fromPool(info.automatic_captions, ['en-orig', 'en']);
}

type CaptionEvent = { tStartMs?: number; aAppend?: number; segs?: { utf8?: string }[] };

// Paragraphs break on speech gaps; a [m:ss] marker opens the first paragraph
// after each 2.5-minute boundary (labeled with the actual speech time).
function captionEventsToText(events: CaptionEvent[]): string {
  const MARK_MS = 150_000;
  const GAP_MS = 6_000;
  const fmtTs = (ms: number): string => {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h > 0 ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(sec).padStart(2, '0');
  };
  const paras: string[] = [];
  let buf: string[] = [];
  let nextMark = 0;
  let lastStart = 0;
  for (const e of events) {
    if (e.aAppend || !e.segs) continue;
    const text = e.segs.map(s => s.utf8 ?? '').join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const t = e.tStartMs ?? 0;
    if (t >= nextMark) {
      if (buf.length) paras.push(buf.join(' '));
      buf = [`[${fmtTs(t)}]`];
      nextMark = (Math.floor(t / MARK_MS) + 1) * MARK_MS;
    } else if (t - lastStart > GAP_MS && buf.length) {
      paras.push(buf.join(' '));
      buf = [];
    }
    buf.push(text);
    lastStart = t;
  }
  if (buf.length) paras.push(buf.join(' '));
  return paras.join('\n\n');
}

// Fetch the transcript for a YouTube URL and cache it as text/<id>.txt.
// Never throws — transcript absence/failure must not fail audio production.
// 'ratelimited' is reported distinctly: YouTube 429s the caption endpoint
// (IP-level, temporal) when hit in bursts; callers should back off, not
// treat it as "video has no captions".
export type TranscriptResult = 'ok' | 'none' | 'ratelimited';
export async function saveYouTubeTranscript(id: number, url: string): Promise<TranscriptResult> {
  try {
    const { stdout } = await execFileAsync(YTDLP_PATH, ['-J', '--no-warnings', url],
      { timeout: 120_000, maxBuffer: 100 * 1024 * 1024 });
    const trackUrl = pickJson3Url(JSON.parse(stdout));
    if (!trackUrl) return 'none';
    const resp = await fetch(trackUrl, { headers: { 'User-Agent': BROWSER_UA } });
    if (resp.status === 429) return 'ratelimited';
    if (!resp.ok) return 'none';
    const data = await resp.json() as { events?: CaptionEvent[] };
    const text = captionEventsToText(data.events ?? []);
    if (text.length < 100) return 'none';
    await mkdir(TEXT_DIR, { recursive: true }).catch(() => {});
    await writeFile(textPath(id), text, 'utf8');
    return 'ok';
  } catch (e) {
    console.error(`[transcript] failed for ${id}: ${(e as Error).message}`);
    return 'none';
  }
}

// Download audio directly from YouTube via yt-dlp (no TTS — uses the actual audio track).
export async function downloadYouTubeAudio(id: number, url: string): Promise<void> {
  if (!existsSync(AUDIO_DIR)) await mkdir(AUDIO_DIR, { recursive: true });
  // --print emits upload_date during the same download (--no-simulate keeps
  // the download happening); it still prints under -q.
  const { stdout } = await execFileAsync(YTDLP_PATH, [
    '-x', '--audio-format', 'm4a',
    '--no-warnings', '-q',
    '--no-simulate', '--print', '%(upload_date>%Y-%m-%d)s',
    '-o', path.join(AUDIO_DIR, `${id}.%(ext)s`), url,
  ], { timeout: 5 * 60 * 1000 });
  if (!existsSync(audioPath(id))) throw new Error('yt-dlp produced no output file');
  const uploadDate = stdout.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(uploadDate)) savePublishedAt(id, uploadDate);
}

// Best-effort creation-date probe for backfilling items whose audio was
// generated before published_at capture existed. Videos: yt-dlp metadata
// only (no download). Articles: re-run the extractor for its date field.
export async function probePublishedAt(url: string, contentType: string): Promise<string | null> {
  try {
    if (contentType === 'video') {
      const { stdout } = await execFileAsync(YTDLP_PATH, [
        '--no-warnings', '--print', '%(upload_date>%Y-%m-%d)s', url,
      ], { timeout: 60_000 });
      const d = stdout.trim();
      return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
    }
    const doc = await extractDocument(url);
    return doc.publishedAt;
  } catch {
    return null;
  }
}

export async function generateAudio(id: number, url: string, title?: string, publishedAt?: string | null): Promise<void> {
  if (!existsSync(AUDIO_DIR)) await mkdir(AUDIO_DIR, { recursive: true });
  if (!existsSync(TEXT_DIR))  await mkdir(TEXT_DIR,  { recursive: true });

  const text = await fetchAndCacheText(id, url);

  const header = buildAudioHeader(title, publishedAt);
  const audioText = header ? `${header}\n\n${text}` : text;

  const txtFile  = path.join(tmpdir(), `watchlist-${id}-${Date.now()}.txt`);
  const aiffFile = path.join(tmpdir(), `watchlist-${id}-${Date.now()}.aiff`);
  const outFile  = audioPath(id);

  try {
    await writeFile(txtFile, audioText, 'utf8');

    await execFileAsync('/usr/bin/say', ['-v', SAY_VOICE, '-f', txtFile, '-o', aiffFile]);

    await execFileAsync('/usr/bin/afconvert', [
      aiffFile, '-f', 'm4af', '-d', 'aac', '-b', '64000', outFile,
    ]);
  } finally {
    await unlink(txtFile).catch(() => {});
    await unlink(aiffFile).catch(() => {});
  }
}
