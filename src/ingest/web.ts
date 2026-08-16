import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { classifyUrl, EMOJI_BY_SOURCE } from './classify';
import { IngestError, ingestError } from './errors';
import { fetchPage } from './fetchPage';
import type { Document, Preview } from './types';

const execFileAsync = promisify(execFile);

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
}

export async function previewWeb(url: string): Promise<Preview> {
  const classified = classifyUrl(url);
  const source = classified.source === 'ars_technica' ? 'ars_technica' : 'web';
  try {
    const { html } = await fetchPage(url, 8_000);
    const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1];
    const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
    const title = decodeHtmlEntities((ogTitle || titleTag || '').trim());
    const siteName = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)?.[1];
    let host = '';
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
    const channel_name = decodeHtmlEntities(
      (siteName || (source === 'ars_technica' ? 'Ars Technica' : host) || '').trim(),
    );
    if (!title) throw ingestError('parse_failed', 'No og:title or <title> on the page.');
    return {
      source,
      kind: 'article',
      contentType: 'article',
      title,
      channel_name,
      emoji: EMOJI_BY_SOURCE[source],
    };
  } catch (e) {
    if (e instanceof IngestError) throw e;
    throw e;
  }
}

export async function extractWeb(url: string): Promise<Document> {
  const classified = classifyUrl(url);
  const source = classified.source === 'ars_technica' ? 'ars_technica' : 'web';
  const script = path.join(__dirname, '..', '..', 'scripts', 'extract_article.py');
  try {
    const { stdout, stderr } = await execFileAsync('python3', [script, url], {
      timeout: 40_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const raw = stdout.trim();
    if (!raw) throw ingestError('extract_failed', 'Extractor returned empty output.');
    let text: string;
    let publishedAt: string | null = null;
    try {
      const parsed = JSON.parse(raw) as { text: string; published_at: string | null };
      text = parsed.text;
      publishedAt = parsed.published_at ?? null;
    } catch {
      text = raw;
    }
    if (!text || text.trim().length < 150) {
      throw ingestError('too_short', `(${(text || '').trim().length} characters)`);
    }
    return {
      source,
      kind: 'article',
      contentType: 'article',
      title: '',
      author: '',
      publishedAt,
      text: text.trim(),
      canonicalUrl: url,
      nativeAudio: false,
    };
  } catch (e) {
    if (e instanceof IngestError) throw e;
    const err = e as { stderr?: string; message?: string; killed?: boolean; signal?: string };
    const stderr = String(err.stderr || '');
    if (err.killed || err.signal === 'SIGTERM') {
      throw ingestError('timeout', '(extractor 40s)');
    }
    if (/fetch failed/i.test(stderr)) {
      throw ingestError('fetch_failed', stderr.replace(/^fetch failed:\s*/i, '').trim());
    }
    if (/all extractors failed/i.test(stderr)) {
      throw ingestError('extract_failed');
    }
    throw ingestError('extract_failed', err.message || stderr || String(e));
  }
}
