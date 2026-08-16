import { ingestError } from './errors';
import type { Document, Preview } from './types';

export async function previewYouTube(url: string): Promise<Preview> {
  let res: Response;
  try {
    res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
      { signal: AbortSignal.timeout(8_000) },
    );
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw ingestError('timeout', '(YouTube oEmbed)');
    }
    throw ingestError('fetch_failed', 'Could not reach YouTube.');
  }
  if (res.status === 404 || res.status === 401) {
    throw ingestError('http_404', 'Not a recognised YouTube URL.');
  }
  if (!res.ok) throw ingestError('fetch_failed', `YouTube oEmbed HTTP ${res.status}.`);
  const data = await res.json() as { title?: string; author_name?: string };
  if (!data.title) throw ingestError('parse_failed', 'YouTube oEmbed returned no title.');
  return {
    source: 'youtube',
    kind: 'native_video',
    contentType: 'video',
    title: data.title,
    channel_name: data.author_name || '',
    emoji: '📺',
  };
}

export function youtubeDocument(url: string): Document {
  return {
    source: 'youtube',
    kind: 'native_video',
    contentType: 'video',
    title: '',
    author: '',
    publishedAt: null,
    text: '',
    canonicalUrl: url,
    nativeAudio: true,
  };
}
