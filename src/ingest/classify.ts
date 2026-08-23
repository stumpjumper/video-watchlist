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
