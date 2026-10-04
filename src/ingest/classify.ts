export type SourceKey = 'youtube' | 'ars_technica' | 'web' | 'x';
export type ContentType = 'video' | 'article';
export type DocumentKind =
  | 'article'
  | 'long_post'
  | 'tweet'
  | 'thread'
  | 'native_video'
  | 'unknown';

export interface ClassifiedUrl {
  source: SourceKey;
  contentType: ContentType;
  /** Present for x.com / twitter.com status URLs. */
  statusId?: string;
  /** Why classify refused (spaces, bare profile, etc.). */
  unsupported?: string;
}

const YT = /youtube\.com|youtu\.be/i;
const ARS = /arstechnica\.com/i;
const X_HOST = /(?:^|\.)(?:x\.com|twitter\.com)$/i;
const X_STATUS = /\/(?:i\/web\/status|i\/status|[^/?#]+\/status)\/(\d+)/i;
const X_ARTICLE = /\/i\/article\/(\d+)/i;
const X_SPACES = /\/i\/spaces\//i;

export const EMOJI_BY_SOURCE: Record<SourceKey, string> = {
  youtube: '📺',
  ars_technica: '🚀',
  web: '📰',
  x: '𝕏',
};

export function classifyUrl(raw: string): ClassifiedUrl {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { source: 'web', contentType: 'article', unsupported: 'bad_url' };
  }

  const host = parsed.hostname.replace(/^www\./i, '').replace(/^mobile\./i, '');

  if (YT.test(host) || YT.test(raw)) {
    return { source: 'youtube', contentType: 'video' };
  }

  if (X_HOST.test(host)) {
    if (X_SPACES.test(parsed.pathname)) {
      return { source: 'x', contentType: 'article', unsupported: 'X Spaces are not supported' };
    }
    const status = parsed.pathname.match(X_STATUS);
    if (status) {
      return { source: 'x', contentType: 'article', statusId: status[1] };
    }
    const article = parsed.pathname.match(X_ARTICLE);
    if (article) {
      return { source: 'x', contentType: 'article', statusId: article[1] };
    }
    return {
      source: 'x',
      contentType: 'article',
      unsupported: 'Need a post URL (x.com/user/status/…), not a profile or search page',
    };
  }

  if (ARS.test(host)) {
    return { source: 'ars_technica', contentType: 'article' };
  }

  return { source: 'web', contentType: 'article' };
}

export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    for (const key of [...u.searchParams.keys()]) {
      if (key === 's' || key === 't' || key.startsWith('utm_')) u.searchParams.delete(key);
    }
    u.hash = '';
    const host = u.hostname.replace(/^www\./i, '').replace(/^mobile\./i, '');
    if (X_HOST.test(host)) {
      u.pathname = u.pathname.replace(/\/video\/\d+\/?$/, '');
    }
    return u.toString();
  } catch {
    return raw.trim();
  }
}

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const TRACKING_KEYS = new Set(['s', 't', 'si', 'fbclid', 'gclid', 'mc_cid', 'mc_eid']);

function cleanYouTubeId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const id = raw.split(/[?&#/]/)[0];
  return YT_ID.test(id) ? id : null;
}

/** YouTube video id from watch, youtu.be, shorts, embed, or live URLs. */
export function youtubeVideoId(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
  if (host === 'youtu.be') {
    return cleanYouTubeId(parsed.pathname.split('/').filter(Boolean)[0]);
  }
  const youtubeHost = host === 'youtube.com' || host.endsWith('.youtube.com')
    || host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com');
  if (!youtubeHost) return null;
  const fromQuery = cleanYouTubeId(parsed.searchParams.get('v'));
  if (fromQuery) return fromQuery;
  const fromPath = parsed.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/);
  return fromPath ? cleanYouTubeId(fromPath[1]) : null;
}

/** Stable page URL for sources that are not a YouTube id or an X status id. */
export function canonicalPageUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  parsed.hash = '';
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_KEYS.has(key) || key.startsWith('utm_')) parsed.searchParams.delete(key);
  }
  const entries = [...parsed.searchParams.entries()].sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
    return 0;
  });
  parsed.search = '';
  for (const [key, value] of entries) parsed.searchParams.append(key, value);
  parsed.hostname = parsed.hostname.replace(/^www\./i, '').toLowerCase();
  if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString();
}

/**
 * Identity for one watchlist row. YouTube → video id. X → status id.
 * Anything else → canonical page URL. Same source + same id is the same item.
 */
export function externalIdFor(source: string, rawUrl: string): string | null {
  if (source === 'youtube') return youtubeVideoId(rawUrl) ?? canonicalPageUrl(rawUrl);
  if (source === 'x') {
    const statusId = classifyUrl(rawUrl).statusId;
    if (statusId) return statusId;
  }
  return canonicalPageUrl(rawUrl);
}
