// Submitted scripts for the AI Update feed. The caller sends the text and the
// origin metadata it already has. This module does not fetch the URL.

import { mkdir, writeFile } from 'fs/promises';
import { addVideoDeduped, getVideoById, hardDelete, savePublishedAt, type Video } from './db';
import { textDir, textPath } from './audio';
import { canonicalPageUrl, classifyUrl, externalIdFor } from './ingest/classify';

export const AI_UPDATE_SOURCE = 'ai_update';
export const XAI_VOICES = ['ara', 'eve', 'rex', 'sal', 'leo'] as const;
export const MAX_EPISODE_CHARS = 200_000;

export class EpisodeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'EpisodeError';
    this.status = status;
  }
}

export type EpisodeVoice =
  | { tts: 'say' }
  | { tts: 'xai'; voice: (typeof XAI_VOICES)[number] };

export function isLoopbackAddress(addr: string | undefined): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

export function parseEpisodeVoice(raw: unknown): EpisodeVoice {
  if (raw === undefined || raw === null || raw === '' || raw === 'say') return { tts: 'say' };
  if (typeof raw === 'string' && (XAI_VOICES as readonly string[]).includes(raw)) {
    return { tts: 'xai', voice: raw as (typeof XAI_VOICES)[number] };
  }
  throw new EpisodeError(400, `voice must be "say" or one of: ${XAI_VOICES.join(', ')}`);
}

export function episodeMetadata(voice: EpisodeVoice): string {
  return voice.tts === 'xai'
    ? JSON.stringify({ tts: 'xai', voice: voice.voice })
    : JSON.stringify({ tts: 'say' });
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new EpisodeError(400, `${key} is required`);
  }
  return value.trim();
}

function parseDate(raw: unknown): string {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new EpisodeError(400, 'published_at is required (YYYY-MM-DD)');
  }
  const [year, month, day] = raw.split('-').map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    throw new EpisodeError(400, 'published_at is required (YYYY-MM-DD)');
  }
  return raw;
}

function originUrl(raw: string): { storedUrl: string; externalId: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new EpisodeError(400, 'url must be an http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new EpisodeError(400, 'url must be an http(s) URL');
  }
  const classified = classifyUrl(raw);
  const externalId = externalIdFor(classified.source, raw);
  const storedUrl = canonicalPageUrl(raw);
  if (!externalId || !storedUrl) throw new EpisodeError(400, 'url must be an http(s) URL');
  return { storedUrl, externalId };
}

/**
 * Insert an AI Update episode, or return the row already stored for this origin.
 * A repeat does not rewrite text, title, or audio. The URL is not fetched.
 */
export async function createEpisode(body: unknown): Promise<{ video: Video; created: boolean }> {
  if (!body || typeof body !== 'object') throw new EpisodeError(400, 'JSON body is required');
  const rec = body as Record<string, unknown>;
  const text = requiredString(rec, 'text');
  if (text.length > MAX_EPISODE_CHARS) {
    throw new EpisodeError(400, `text is longer than ${MAX_EPISODE_CHARS} characters`);
  }
  const title = requiredString(rec, 'title');
  const channel = requiredString(rec, 'channel_name');
  const publishedAt = parseDate(rec.published_at);
  const { storedUrl, externalId } = originUrl(requiredString(rec, 'url'));
  const voice = parseEpisodeVoice(rec.voice);
  if (voice.tts === 'xai' && !process.env.XAI_API_KEY_WATCHLIST?.trim()) {
    throw new EpisodeError(400, 'XAI_API_KEY_WATCHLIST is not set');
  }
  const summary = typeof rec.summary === 'string' && rec.summary.trim() ? rec.summary.trim() : undefined;

  const { video, created } = addVideoDeduped(
    storedUrl,
    title,
    channel,
    '🤖',
    summary,
    AI_UPDATE_SOURCE,
    'article',
    episodeMetadata(voice),
    externalId,
  );
  if (!created) return { video, created: false };

  savePublishedAt(video.id, publishedAt);
  try {
    await mkdir(textDir(), { recursive: true });
    await writeFile(textPath(video.id), text, 'utf8');
  } catch (err) {
    hardDelete(video.id);
    throw err;
  }
  return { video: getVideoById(video.id)!, created: true };
}
