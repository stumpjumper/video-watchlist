import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, readFile, unlink, mkdir, stat, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { savePublishedAt } from './db';

const execFileAsync = promisify(execFile);

export const AUDIO_DIR  = path.join(__dirname, '..', 'audio');
export const TEXT_DIR   = path.join(__dirname, '..', 'text');
export const SAY_VOICE  = process.env.SAY_VOICE ?? 'Ava (Premium)';
const YTDLP_PATH        = '/opt/homebrew/bin/yt-dlp';

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
  const { text, publishedAt } = await fetchArticleText(url);
  await mkdir(TEXT_DIR, { recursive: true }).catch(() => {});
  await writeFile(textPath(id), text, 'utf8').catch(() => {});
  if (publishedAt) savePublishedAt(id, publishedAt);
  return text;
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

async function fetchArticleText(url: string): Promise<{text: string, publishedAt: string | null}> {
  const script = path.join(__dirname, '..', 'scripts', 'extract_article.py');
  const { stdout } = await execFileAsync('python3', [script, url], {
    timeout: 40_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const raw = stdout.trim();
  if (!raw) throw new Error('article extraction returned empty output');
  try {
    const parsed = JSON.parse(raw) as { text: string; published_at: string | null };
    return { text: parsed.text, publishedAt: parsed.published_at ?? null };
  } catch {
    return { text: raw, publishedAt: null };
  }
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
    const { publishedAt } = await fetchArticleText(url);
    return publishedAt;
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
