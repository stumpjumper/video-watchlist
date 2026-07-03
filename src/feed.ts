import { statSync } from 'fs';
import { getReadyAudioVideos } from './db';
import { audioUrl, audioPath } from './audio';

const PUBLIC_AUDIO_BASE_URL = process.env.PUBLIC_AUDIO_BASE_URL ?? 'https://turbo.taild6cb04.ts.net:4443';

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildFeedXml(contentType: string, channelTitle: string): string {
  const videos = getReadyAudioVideos(contentType);

  const items = videos.map(v => {
    let length = 0;
    try { length = statSync(audioPath(v.id)).size; } catch {}

    const pubDate = v.audio_added_at ? new Date(v.audio_added_at).toUTCString() : new Date().toUTCString();
    const enclosureUrl = `${PUBLIC_AUDIO_BASE_URL}${audioUrl(v.id)}`;
    const description = v.summary ? escapeXml(v.summary) : '';

    return `
    <item>
      <title>${escapeXml(v.title)}</title>
      <guid isPermaLink="false">wl-${v.id}</guid>
      <pubDate>${pubDate}</pubDate>
      <description>${description}</description>
      <enclosure url="${escapeXml(enclosureUrl)}" length="${length}" type="audio/mp4"/>
    </item>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
<channel>
  <title>${escapeXml(channelTitle)}</title>
  <link>${PUBLIC_AUDIO_BASE_URL}</link>
  <description>${escapeXml(channelTitle)} — personal watchlist feed</description>
  <language>en-us</language>
  <itunes:explicit>false</itunes:explicit>${items}
</channel>
</rss>
`;
}
