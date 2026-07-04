import { statSync } from 'fs';
import { getReadyAudioVideos, Video } from './db';
import { audioUrl, audioPath } from './audio';

const PUBLIC_AUDIO_BASE_URL = process.env.PUBLIC_AUDIO_BASE_URL ?? 'https://turbo.taild6cb04.ts.net:4443';
// Distinct from PUBLIC_AUDIO_BASE_URL: audio enclosures are fetched directly by the
// device (proven to work over Tailscale-only), but the feed XML and its referenced
// artwork may be fetched by Overcast's own crawler infrastructure, which can only
// reach the public Funnel hostname (no port — Funnel serves on 443).
const PUBLIC_FEED_BASE_URL = process.env.PUBLIC_FEED_BASE_URL ?? 'https://turbo.taild6cb04.ts.net';

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function formatDuration(seconds: number | null): string | null {
  if (seconds === null) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function formatBytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024 * 10) / 10} MB`;
}

function audioSourceLabel(v: Video): string {
  if (v.content_type === 'video') return 'Direct audio grab (yt-dlp)';
  return v.audio_voice ? `Text-to-speech (${v.audio_voice})` : 'Text-to-speech';
}

function buildDescription(v: Video, size: number, duration: number | null): string {
  const lines: string[] = [];
  lines.push(`<p><strong>Channel/Source:</strong> ${escapeXml(v.channel_name || v.source)}</p>`);
  const published = formatDate(v.published_at);
  if (published) lines.push(`<p><strong>Published:</strong> ${published}</p>`);
  const added = formatDate(v.added_at);
  if (added) lines.push(`<p><strong>Added to watchlist:</strong> ${added}</p>`);
  const durationStr = formatDuration(duration);
  const audioBits = [audioSourceLabel(v), formatBytes(size), durationStr].filter(Boolean);
  lines.push(`<p><strong>Audio:</strong> ${audioBits.join(' · ')}</p>`);
  lines.push(`<p><strong>Source:</strong> <a href="${escapeXml(v.url)}">${escapeXml(v.url)}</a></p>`);
  if (v.summary) lines.push(v.summary);
  return lines.join('\n    ');
}

export function buildFeedXml(sourceKey: string, channelTitle: string, iconFile: string): string {
  const videos = getReadyAudioVideos(sourceKey);
  const imageUrl = `${PUBLIC_FEED_BASE_URL}/feed/icons/${iconFile}`;

  const items = videos.map(v => {
    let length = 0;
    try { length = statSync(audioPath(v.id)).size; } catch {}

    // Creation date, not added date — Overcast sorts episodes by pubDate.
    // Guard against an unparseable stored published_at: added_at is always
    // server-stamped ISO and safe.
    let pubDateMs = Date.parse(v.published_at ?? v.added_at);
    if (isNaN(pubDateMs)) pubDateMs = Date.parse(v.added_at);
    const pubDate = new Date(pubDateMs).toUTCString();
    const enclosureUrl = `${PUBLIC_AUDIO_BASE_URL}${audioUrl(v.id)}`;
    const duration = formatDuration(v.audio_duration_seconds);
    const description = buildDescription(v, length, v.audio_duration_seconds);

    return `
    <item>
      <title>${escapeXml(v.title)}</title>
      <guid isPermaLink="false">wl-${v.id}</guid>
      <pubDate>${pubDate}</pubDate>
      <itunes:author>${escapeXml(v.channel_name || v.source)}</itunes:author>
      <itunes:subtitle>${escapeXml(v.channel_name || v.source)}</itunes:subtitle>
      ${duration ? `<itunes:duration>${duration}</itunes:duration>` : ''}
      <description><![CDATA[${description}]]></description>
      <enclosure url="${escapeXml(enclosureUrl)}" length="${length}" type="audio/mp4"/>
    </item>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
<channel>
  <title>${escapeXml(channelTitle)}</title>
  <link>${PUBLIC_FEED_BASE_URL}</link>
  <description>${escapeXml(channelTitle)} — personal watchlist feed</description>
  <language>en-us</language>
  <itunes:explicit>false</itunes:explicit>
  <itunes:image href="${escapeXml(imageUrl)}"/>
  <image>
    <url>${escapeXml(imageUrl)}</url>
    <title>${escapeXml(channelTitle)}</title>
    <link>${PUBLIC_FEED_BASE_URL}</link>
  </image>${items}
</channel>
</rss>
`;
}
