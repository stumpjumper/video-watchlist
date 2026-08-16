import { classifyUrl, normalizeUrl } from './classify';
import { ingestError } from './errors';
import { fetchPage, looksLikeLoginWall } from './fetchPage';
import { findNoteTweetText, findTypedObjectFields, firstJsStringField } from './relay';
import type { Document, Preview } from './types';

const MIN_ARTICLE = 150;
const MIN_LONG_POST = 281;

export interface ParsedX {
  kind: 'article' | 'long_post' | 'tweet';
  title: string;
  author: string;
  text: string;
  publishedAt: string | null;
}

function authorFromHtml(html: string): string {
  const handle = firstJsStringField(html, 'screenName');
  let name: string | null = null;
  if (handle) {
    const hIdx = html.indexOf(`screenName:"${handle}"`);
    if (hIdx >= 0) {
      name = firstJsStringField(html.slice(Math.max(0, hIdx - 2500), hIdx + 2500), 'name');
    }
  }
  if (!name) name = firstJsStringField(html, 'name');
  if (name && handle) return `${name} (@${handle})`;
  if (handle) return `@${handle}`;
  if (name) return name;
  return 'X';
}

function firstLineTitle(text: string): string {
  const line = text.split(/\n/)[0]?.trim() ?? '';
  if (line.length >= 8 && line.length <= 140) return line;
  return text.replace(/\s+/g, ' ').trim().slice(0, 100);
}

export function parseXHtml(html: string): ParsedX {
  const article = findTypedObjectFields(html, 'ArticleEntity', ['title', 'plain_text']);
  const articleText = article?.plain_text?.trim() ?? '';
  if (article && articleText.length >= MIN_ARTICLE) {
    const title = (article.title || '').trim() || firstLineTitle(articleText);
    return {
      kind: 'article',
      title,
      author: authorFromHtml(html),
      text: articleText,
      publishedAt: null,
    };
  }

  const note = findNoteTweetText(html)?.trim() ?? '';
  if (note.length >= MIN_LONG_POST) {
    return {
      kind: 'long_post',
      title: firstLineTitle(note),
      author: authorFromHtml(html),
      text: note,
      publishedAt: null,
    };
  }

  const tweetText =
    firstJsStringField(html, 'full_text')?.trim() ||
    firstJsStringField(html, 'text')?.trim() ||
    '';

  return {
    kind: 'tweet',
    title: tweetText ? firstLineTitle(tweetText) : 'X post',
    author: authorFromHtml(html),
    text: tweetText || note || articleText,
    publishedAt: null,
  };
}

async function loadXPage(url: string): Promise<{ html: string; finalUrl: string }> {
  const classified = classifyUrl(url);
  if (classified.unsupported && classified.unsupported !== 'bad_url') {
    throw ingestError('unsupported', classified.unsupported);
  }
  if (!classified.statusId) {
    throw ingestError('unsupported', classified.unsupported || 'Need a post URL (x.com/user/status/…)');
  }

  const { html, finalUrl } = await fetchPage(normalizeUrl(url));
  if (looksLikeLoginWall(html) && !html.includes('__typename:"ArticleEntity"')) {
    throw ingestError('login_wall');
  }
  return { html, finalUrl };
}

export async function previewX(url: string): Promise<Preview> {
  const { html } = await loadXPage(url);
  const parsed = parseXHtml(html);
  const preview: Preview = {
    source: 'x',
    kind: parsed.kind,
    contentType: 'article',
    title: parsed.title,
    channel_name: parsed.author,
    emoji: '𝕏',
  };
  if (parsed.kind === 'tweet') {
    const err = ingestError('not_article');
    preview.warning = { code: err.code, message: err.message };
  }
  return preview;
}

export async function extractX(url: string): Promise<Document> {
  const { html, finalUrl } = await loadXPage(url);
  const parsed = parseXHtml(html);

  if (parsed.kind === 'tweet') {
    throw ingestError(
      'not_article',
      parsed.text
        ? `(${parsed.text.length} characters)`
        : undefined,
    );
  }

  if (parsed.text.length < MIN_ARTICLE) {
    throw ingestError('too_short', `(${parsed.text.length} characters)`);
  }

  return {
    source: 'x',
    kind: parsed.kind,
    contentType: 'article',
    title: parsed.title,
    author: parsed.author,
    publishedAt: parsed.publishedAt,
    text: parsed.text,
    canonicalUrl: finalUrl,
    nativeAudio: false,
  };
}
