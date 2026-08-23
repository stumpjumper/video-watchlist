import { classifyUrl, normalizeUrl } from './classify';
import { ingestError } from './errors';
import { fetchPage, looksLikeLoginWall } from './fetchPage';
import { findNoteTweetText, findTypedObjectFields, firstJsStringField, readObjectStringFields } from './relay';
import type { Document, Preview } from './types';

const MIN_ARTICLE = 150;
const MIN_LONG_POST = 281;

export interface ParsedX {
  kind: 'article' | 'long_post' | 'tweet' | 'native_video';
  title: string;
  author: string;
  text: string;
  publishedAt: string | null;
}

/** Relay id for a status: base64("Tweet:" + statusId). */
export function tweetRelayB64(statusId: string): string {
  return Buffer.from(`Tweet:${statusId}`).toString('base64');
}

/** True when THIS status (not a parent/quote/reply neighbor) has attached video. */
export function hasNativeVideo(html: string, statusId: string): boolean {
  const b64 = tweetRelayB64(statusId);
  return html.includes(`${b64}:media_entities2:0:video_info`)
      || html.includes(`${b64}:media_entities:0:video_info`);
}

function tweetCaption(html: string, statusId: string): string {
  const b64 = tweetRelayB64(statusId);
  const marker = `"client:${b64}:details":`;
  const idx = html.indexOf(marker);
  if (idx >= 0) {
    const brace = html.indexOf('{', idx + marker.length);
    if (brace >= 0 && brace - (idx + marker.length) < 80) {
      const fields = readObjectStringFields(html, brace, ['full_text']);
      const text = fields.full_text?.trim();
      if (text) return text;
    }
  }
  return '';
}

function ogDescription(html: string): string {
  const m = html.match(/<meta\s+(?:property|name)="og:description"\s+content="([^"]*)"/i)
    ?? html.match(/<meta\s+content="([^"]*)"\s+(?:property|name)="og:description"/i);
  if (!m) return '';
  const raw = m[1]
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
  return raw.replace(/\s+/g, ' ').trim();
}

function videoTitle(caption: string, html: string): string {
  const collapsed = caption.replace(/\s+/g, ' ').trim();
  if (collapsed.length >= 8) return collapsed.slice(0, 140);
  const og = ogDescription(html);
  if (og.length >= 8) return og.slice(0, 140);
  return 'X video';
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

export function parseXHtml(html: string, statusId?: string): ParsedX {
  const author = authorFromHtml(html);

  if (statusId && hasNativeVideo(html, statusId)) {
    const caption = tweetCaption(html, statusId);
    return {
      kind: 'native_video',
      title: videoTitle(caption, html),
      author,
      text: '',
      publishedAt: null,
    };
  }

  const article = findTypedObjectFields(html, 'ArticleEntity', ['title', 'plain_text']);
  const articleText = article?.plain_text?.trim() ?? '';
  if (article && articleText.length >= MIN_ARTICLE) {
    const title = (article.title || '').trim() || firstLineTitle(articleText);
    return {
      kind: 'article',
      title,
      author,
      text: articleText,
      publishedAt: null,
    };
  }

  const note = findNoteTweetText(html)?.trim() ?? '';
  if (note.length >= MIN_LONG_POST) {
    return {
      kind: 'long_post',
      title: firstLineTitle(note),
      author,
      text: note,
      publishedAt: null,
    };
  }

  const tweetText =
    (statusId ? tweetCaption(html, statusId) : '') ||
    firstJsStringField(html, 'full_text')?.trim() ||
    firstJsStringField(html, 'text')?.trim() ||
    '';

  return {
    kind: 'tweet',
    title: tweetText ? firstLineTitle(tweetText) : 'X post',
    author,
    text: tweetText || note || articleText,
    publishedAt: null,
  };
}

async function loadXPage(url: string): Promise<{ html: string; finalUrl: string; statusId: string }> {
  const classified = classifyUrl(url);
  if (classified.unsupported && classified.unsupported !== 'bad_url') {
    throw ingestError('unsupported', classified.unsupported);
  }
  if (!classified.statusId) {
    throw ingestError('unsupported', classified.unsupported || 'Need a post URL (x.com/user/status/…)');
  }

  const { html, finalUrl } = await fetchPage(normalizeUrl(url));
  if (
    looksLikeLoginWall(html) &&
    !html.includes('__typename:"ArticleEntity"') &&
    !hasNativeVideo(html, classified.statusId)
  ) {
    throw ingestError('login_wall');
  }
  return { html, finalUrl, statusId: classified.statusId };
}

export async function previewX(url: string): Promise<Preview> {
  const { html, statusId } = await loadXPage(url);
  const parsed = parseXHtml(html, statusId);
  const preview: Preview = {
    source: 'x',
    kind: parsed.kind,
    contentType: parsed.kind === 'native_video' ? 'video' : 'article',
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
  const { html, finalUrl, statusId } = await loadXPage(url);
  const parsed = parseXHtml(html, statusId);

  if (parsed.kind === 'tweet') {
    throw ingestError(
      'not_article',
      parsed.text
        ? `(${parsed.text.length} characters)`
        : undefined,
    );
  }

  if (parsed.kind === 'native_video') {
    return {
      source: 'x',
      kind: 'native_video',
      contentType: 'video',
      title: parsed.title,
      author: parsed.author,
      publishedAt: parsed.publishedAt,
      text: '',
      canonicalUrl: finalUrl,
      nativeAudio: true,
    };
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
