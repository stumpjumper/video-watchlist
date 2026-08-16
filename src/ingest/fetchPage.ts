import { httpStatusError, ingestError } from './errors';

export const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

export interface FetchedPage {
  html: string;
  finalUrl: string;
  status: number;
}

export async function fetchPage(url: string, timeoutMs = 20_000): Promise<FetchedPage> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
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

  if (!res.ok) throw httpStatusError(res.status);

  const html = await res.text();
  return { html, finalUrl: res.url || url, status: res.status };
}

export function looksLikeLoginWall(html: string): boolean {
  if (html.includes('__typename:"ArticleEntity"')) return false;
  if (html.length > 80_000) return false;
  const lower = html.toLowerCase();
  return (
    lower.includes('log in or sign up') ||
    lower.includes('sign in to x') ||
    (lower.includes('login') && lower.includes('sign up'))
  );
}
