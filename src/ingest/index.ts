import { classifyUrl, EMOJI_BY_SOURCE, type ClassifiedUrl, type SourceKey } from './classify';
import { ingestError } from './errors';
import { extractWeb, previewWeb } from './web';
import { extractX, previewX } from './x';
import { previewYouTube, youtubeDocument } from './youtube';
import type { Document, Preview } from './types';

export { classifyUrl, EMOJI_BY_SOURCE, normalizeUrl } from './classify';
export type { ClassifiedUrl, ContentType, DocumentKind, SourceKey } from './classify';
export { IngestError, formatFailure, ingestError, isRetryableFailure } from './errors';
export type { IngestCode } from './errors';
export type { Document, Preview } from './types';

const KNOWN: ReadonlySet<string> = new Set(['youtube', 'ars_technica', 'web', 'x']);

/** Server-side source of truth. Client source wins only for unknown custom slugs. */
export function resolveSource(url: string, clientSource?: string): ClassifiedUrl {
  const classified = classifyUrl(url);
  if (classified.source !== 'web') return classified;
  if (clientSource && !KNOWN.has(clientSource)) {
    return { source: clientSource as SourceKey, contentType: 'article' };
  }
  if (clientSource === 'ars_technica' || clientSource === 'youtube' || clientSource === 'x') {
    return classified;
  }
  return classified;
}

export async function previewUrl(url: string): Promise<Preview> {
  const classified = classifyUrl(url);
  if (classified.unsupported === 'bad_url') throw ingestError('bad_url');
  if (classified.source === 'youtube') return previewYouTube(url);
  if (classified.source === 'x') {
    if (classified.unsupported) throw ingestError('unsupported', classified.unsupported);
    return previewX(url);
  }
  return previewWeb(url);
}

export async function extractDocument(url: string): Promise<Document> {
  const classified = classifyUrl(url);
  if (classified.unsupported === 'bad_url') throw ingestError('bad_url');
  if (classified.source === 'youtube') return youtubeDocument(url);
  if (classified.source === 'x') {
    if (classified.unsupported) throw ingestError('unsupported', classified.unsupported);
    return extractX(url);
  }
  return extractWeb(url);
}
