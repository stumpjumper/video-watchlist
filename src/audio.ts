import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, readFile, unlink, mkdir, stat, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';

const execFileAsync = promisify(execFile);

export const AUDIO_DIR = path.join(__dirname, '..', 'audio');
export const TEXT_DIR  = path.join(__dirname, '..', 'text');
export const SAY_VOICE = process.env.SAY_VOICE ?? 'Ava (Premium)';

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
  const text = await fetchArticleText(url);
  await mkdir(TEXT_DIR, { recursive: true }).catch(() => {});
  await writeFile(textPath(id), text, 'utf8').catch(() => {});
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

export async function fetchArticleText(url: string): Promise<string> {
  const script = path.join(__dirname, '..', 'scripts', 'extract_article.py');
  const { stdout } = await execFileAsync('python3', [script, url], {
    timeout: 40_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const text = stdout.trim();
  if (!text) throw new Error('article extraction returned empty output');
  return text;
}

export async function generateAudio(id: number, url: string): Promise<void> {
  if (!existsSync(AUDIO_DIR)) await mkdir(AUDIO_DIR, { recursive: true });
  if (!existsSync(TEXT_DIR))  await mkdir(TEXT_DIR,  { recursive: true });

  const text = await fetchArticleText(url);
  await writeFile(textPath(id), text, 'utf8').catch(() => {});

  const txtFile  = path.join(tmpdir(), `watchlist-${id}-${Date.now()}.txt`);
  const aiffFile = path.join(tmpdir(), `watchlist-${id}-${Date.now()}.aiff`);
  const outFile  = audioPath(id);

  try {
    await writeFile(txtFile, text, 'utf8');

    await execFileAsync('/usr/bin/say', ['-v', SAY_VOICE, '-f', txtFile, '-o', aiffFile]);

    await execFileAsync('/usr/bin/afconvert', [
      aiffFile, '-f', 'm4af', '-d', 'aac', '-b', '64000', outFile,
    ]);
  } finally {
    await unlink(txtFile).catch(() => {});
    await unlink(aiffFile).catch(() => {});
  }
}
