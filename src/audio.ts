import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink, mkdir, stat, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';

const execFileAsync = promisify(execFile);

export const AUDIO_DIR = path.join(__dirname, '..', 'audio');
export const SAY_VOICE = process.env.SAY_VOICE ?? 'Ava (Premium)';

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

async function fetchArticleText(url: string): Promise<string> {
  const bin = process.env.TRAFILATURA_BIN ?? '/Users/nano/.local/bin/trafilatura';
  const { stdout } = await execFileAsync(bin, ['-u', url], {
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const text = stdout.trim();
  if (!text) throw new Error('trafilatura returned empty output');
  return text;
}

export async function generateAudio(id: number, url: string): Promise<void> {
  if (!existsSync(AUDIO_DIR)) {
    await mkdir(AUDIO_DIR, { recursive: true });
  }

  const text = await fetchArticleText(url);

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
