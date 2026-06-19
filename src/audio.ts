import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink, mkdir, stat, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';

const execFileAsync = promisify(execFile);

export const AUDIO_DIR = path.join(__dirname, '..', 'audio');
export const SAY_VOICE = process.env.SAY_VOICE ?? 'Ava (Premium)';

// Rough estimate: ~150 words/min at 1× speed, ~5 chars/word
export function estimateDurationSec(text: string): number {
  return Math.ceil((text.length / 5) / 150 * 60);
}

export function audioPath(id: number): string {
  return path.join(AUDIO_DIR, `${id}.m4a`);
}

export function audioUrl(id: number): string {
  return `/audio/${id}.m4a`;
}

export async function audioExists(id: number): Promise<boolean> {
  try {
    await stat(audioPath(id));
    return true;
  } catch {
    return false;
  }
}

export async function audioDirSizeBytes(): Promise<number> {
  try {
    const files = await readdir(AUDIO_DIR);
    let total = 0;
    for (const f of files) {
      try {
        const s = await stat(path.join(AUDIO_DIR, f));
        total += s.size;
      } catch {}
    }
    return total;
  } catch {
    return 0;
  }
}

export async function generateAudio(id: number, text: string): Promise<void> {
  if (!existsSync(AUDIO_DIR)) {
    await mkdir(AUDIO_DIR, { recursive: true });
  }

  const txtFile = path.join(tmpdir(), `watchlist-${id}-${Date.now()}.txt`);
  const aiffFile = path.join(tmpdir(), `watchlist-${id}-${Date.now()}.aiff`);
  const outFile = audioPath(id);

  try {
    await writeFile(txtFile, text, 'utf8');

    // Generate AIFF with say
    await execFileAsync('/usr/bin/say', [
      '-v', SAY_VOICE,
      '-f', txtFile,
      '-o', aiffFile,
    ]);

    // Convert to AAC/M4A (much smaller, ~10× compression vs AIFF)
    await execFileAsync('/usr/bin/afconvert', [
      aiffFile,
      '-f', 'm4af',
      '-d', 'aac',
      '-b', '64000',
      outFile,
    ]);
  } finally {
    await unlink(txtFile).catch(() => {});
    await unlink(aiffFile).catch(() => {});
  }
}
