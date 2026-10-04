/** A watchlist row reduced to the fields that decide which duplicate to keep. */
export interface DedupeCandidate {
  id: number;
  status: string;
  finished_at: string | null;
  audio_status: string;
  audio_fetched_at: string | null;
  summary: string | null;
  labels: { label_id: number }[];
}

const INBOX = 1;
const TRASH = 2;

/** Higher wins. Equal scores keep the older row (lower id). */
export function dedupeScore(row: DedupeCandidate): number {
  const labels = row.labels.map(l => l.label_id);
  let score = 0;
  if (!labels.includes(TRASH)) score += 1_000_000;
  if (row.finished_at || row.status === 'finished') score += 100_000;
  if (row.status === 'started') score += 20_000;
  if (labels.some(id => id !== INBOX && id !== TRASH)) score += 50_000;
  if (row.audio_status === 'ready') score += 10_000;
  else if (row.audio_status === 'pending' || row.audio_status === 'generating') score += 5_000;
  else if (row.audio_status === 'failed') score += 1_000;
  if (row.audio_fetched_at) score += 2_000;
  if (row.summary && row.summary.trim()) score += 500;
  return score;
}

export function chooseKeeper<T extends DedupeCandidate>(rows: T[]): T {
  if (rows.length === 0) throw new Error('chooseKeeper: empty');
  return rows.reduce((best, row) => {
    const delta = dedupeScore(row) - dedupeScore(best);
    if (delta > 0) return row;
    if (delta < 0) return best;
    return row.id < best.id ? row : best;
  });
}

/** node:sqlite throws errcode 2067 (SQLITE_CONSTRAINT_UNIQUE) on the partial index. */
export function isUniqueConstraint(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { errcode?: number; message?: string };
  if (e.errcode === 2067) return true;
  return typeof e.message === 'string' && e.message.includes('UNIQUE constraint failed');
}
