import { httpStatusError, ingestError } from './errors';

export const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

export interface FetchedPage {
  html: string;
  finalUrl: string;
  status: number;
}

const FETCH_HEADERS = {
  'User-Agent': BROWSER_UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

export async function fetchPage(url: string, timeoutMs = 20_000): Promise<FetchedPage> {
  const attempts = 3;
  let lastStatus = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: FETCH_HEADERS,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const name = e instanceof Error ? e.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw ingestError('timeout', `(${Math.round(timeoutMs / 1000)}s)`);
      }
      const msg = e instanceof Error ? e.message : String(e);
      throw ingestError('fetch_failed', msg);
    }

    if (res.ok) {
      const html = await res.text();
      return { html, finalUrl: res.url || url, status: res.status };
    }

    lastStatus = res.status;
    const err = httpStatusError(res.status);
    if (err.code !== 'http_5xx' || attempt === attempts) throw err;
    console.warn(`[ingest] HTTP ${res.status} for ${url}, retry ${attempt}/${attempts - 1}`);
    await new Promise(r => setTimeout(r, 400 * attempt));
  }
  throw httpStatusError(lastStatus);
}

export function looksLikeLoginWall(html: string): boolean {
  if (html.includes('__typename:"ArticleEntity"')) return false;
  if (html.includes('__typename:"ApiMediaEntityVideoInfo"')) return false;
  if (html.length > 80_000) return false;
  const lower = html.toLowerCase();
  return (
    lower.includes('log in or sign up') ||
    lower.includes('sign in to x') ||
    (lower.includes('login') && lower.includes('sign up'))
  );
}
