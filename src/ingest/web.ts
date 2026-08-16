import { spawn } from 'child_process';
import { Readability } from '@mozilla/readability';
import { JSDOM, VirtualConsole } from 'jsdom';
import { classifyUrl, EMOJI_BY_SOURCE } from './classify';
import { IngestError, ingestError } from './errors';
import { fetchPage, looksLikeLoginWall } from './fetchPage';
import type { Document, Preview } from './types';

export const MIN_ARTICLE = 150;
const TRAFILATURA = process.env.TRAFILATURA ?? '/Users/aal/.local/bin/trafilatura';

const ARTICLE_LD_TYPES = new Set([
  'article',
  'newsarticle',
  'blogposting',
  'techreport',
  'report',
  'scholarlyarticle',
]);

/** Strong user-facing phrases only — not the word "paywall" (Ars analytics uses it). */
const PAYWALL_RE =
  /subscribe to (?:continue|read|unlock)|become a (?:paid )?subscriber|already a subscriber|this (?:article|story) is (?:for|exclusive to) subscribers|(?:sign in|log in) to (?:continue|read|unlock)|create a free account to (?:continue|read)|subscribers? only/i;

export type CandidateName = 'ars' | 'jsonld' | 'readability' | 'trafilatura';

export interface Candidate {
  name: CandidateName;
  text: string;
}

export interface JsonLdArticle {
  articleBody?: string;
  headline?: string;
  datePublished?: string;
  author?: string;
}

export interface TrafilaturaResult {
  text: string;
  date: string | null;
  title?: string;
}

// ── small HTML / date helpers ────────────────────────────────────────────────

export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#0?39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const n = parseInt(h, 16);
      return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : _;
    })
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _;
    });
}

export function normalizeDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const raw = String(s).trim();
  if (!raw) return null;

  let isoCandidate = raw;
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) isoCandidate = `${compact[1]}-${compact[2]}-${compact[3]}`;

  const ms = Date.parse(isoCandidate.replace(/Z$/, '+00:00'));
  if (Number.isNaN(ms)) return null;
  const year = new Date(ms).getUTCFullYear();
  const nowY = new Date().getUTCFullYear();
  if (year < 1995 || year > nowY + 1) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(isoCandidate)) return isoCandidate;
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) return raw.replace(/Z$/, '+00:00');
  return new Date(ms).toISOString();
}

export function dateFromUrl(url: string): string | null {
  const m = url.match(/\/(20\d{2})[-/](\d{1,2})[-/](\d{1,2})(?:[/?#]|$)/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return normalizeDate(`${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
}

function metaContent(html: string, key: string, attr: 'property' | 'name' | 'itemprop'): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `<meta\\b[^>]*(?:${attr}=["']${escaped}["'][^>]*content=["']([^"']*)["']|content=["']([^"']*)["'][^>]*${attr}=["']${escaped}["'])`,
    'i',
  );
  const m = html.match(re);
  if (!m) return null;
  const val = decodeHtmlEntities((m[1] || m[2] || '').trim());
  return val || null;
}

function firstTimeDatetime(html: string): string | null {
  const m = html.match(/<time\b[^>]*\bdatetime=["']([^"']+)["']/i);
  return m ? m[1].trim() : null;
}

export function ogTitle(html: string): string | null {
  return metaContent(html, 'og:title', 'property');
}

export function ogSiteName(html: string): string | null {
  return metaContent(html, 'og:site_name', 'property');
}

export function ogDescription(html: string): string | null {
  return metaContent(html, 'og:description', 'property')
    ?? metaContent(html, 'description', 'name');
}

function titleTag(html: string): string | null {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? decodeHtmlEntities(m[1].trim()) : null;
}

// ── JSON-LD ──────────────────────────────────────────────────────────────────

function cleanLdText(s: string): string {
  return s
    .replace(/^\s*<!--/, '')
    .replace(/-->\s*$/, '')
    .replace(/^\/?\s*<!\[CDATA\[/, '')
    .replace(/\]\]>\s*$/, '')
    .trim();
}

function ldScripts(html: string): string[] {
  const out: string[] = [];
  const re = /<script\b[^>]*\btype\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push(cleanLdText(m[1]));
  return out;
}

function authorFromLd(author: unknown): string | undefined {
  if (!author) return undefined;
  if (typeof author === 'string') {
    const t = author.trim();
    return t || undefined;
  }
  if (Array.isArray(author)) {
    const names = author.map(authorFromLd).filter((x): x is string => Boolean(x));
    return names.length ? names.join(', ') : undefined;
  }
  if (typeof author === 'object' && author !== null && typeof (author as { name?: unknown }).name === 'string') {
    const t = ((author as { name: string }).name).trim();
    return t || undefined;
  }
  return undefined;
}

function asTypes(value: unknown): string[] {
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value]).map(v => String(v).toLowerCase());
}

function walkLd(node: unknown, acc: JsonLdArticle, depth = 0): void {
  if (node == null || depth > 8) return;
  if (Array.isArray(node)) {
    for (const item of node) walkLd(item, acc, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  const o = node as Record<string, unknown>;
  const types = asTypes(o['@type']);
  const isArticle = types.some(t => ARTICLE_LD_TYPES.has(t));
  const body = typeof o.articleBody === 'string' ? o.articleBody.trim() : '';
  const headlineRaw =
    (typeof o.headline === 'string' && o.headline) ||
    (isArticle && typeof o.name === 'string' ? o.name : '');
  const headline = headlineRaw ? headlineRaw.trim() : '';
  const date = (typeof o.datePublished === 'string' && o.datePublished)
    || (typeof o.dateCreated === 'string' && o.dateCreated)
    || '';
  const author = authorFromLd(o.author);

  if (body && body.length > (acc.articleBody?.length ?? 0)) {
    acc.articleBody = body;
    if (headline) acc.headline = headline;
    if (date) acc.datePublished = date;
    if (author) acc.author = author;
  } else if (isArticle) {
    if (headline && !acc.headline) acc.headline = headline;
    if (date && !acc.datePublished) acc.datePublished = date;
    if (author && !acc.author) acc.author = author;
  }

  for (const [key, value] of Object.entries(o)) {
    if (key === '@context') continue;
    if (value && typeof value === 'object') walkLd(value, acc, depth + 1);
  }
}

export function parseJsonLd(html: string): JsonLdArticle {
  const acc: JsonLdArticle = {};
  for (const raw of ldScripts(html)) {
    if (!raw) continue;
    try {
      walkLd(JSON.parse(raw), acc);
    } catch {
      // publishers regularly ship trailing commas / HTML entities
    }
  }
  return acc;
}

// ── dates ────────────────────────────────────────────────────────────────────

export function extractPublishedAt(html: string, url: string, ld?: JsonLdArticle): string | null {
  const jsonld = ld ?? parseJsonLd(html);
  const fromLd = normalizeDate(jsonld.datePublished);
  if (fromLd) return fromLd;

  const meta =
    metaContent(html, 'article:published_time', 'property')
    ?? metaContent(html, 'article:published_date', 'property')
    ?? metaContent(html, 'og:article:published_time', 'property')
    ?? metaContent(html, 'publish_date', 'name')
    ?? metaContent(html, 'date', 'name')
    ?? metaContent(html, 'dc.date', 'name')
    ?? metaContent(html, 'dcterms.created', 'name')
    ?? metaContent(html, 'datePublished', 'itemprop');
  const fromMeta = normalizeDate(meta);
  if (fromMeta) return fromMeta;

  const fromTime = normalizeDate(firstTimeDatetime(html));
  if (fromTime) return fromTime;

  return dateFromUrl(url);
}

// ── quality gate / picker ────────────────────────────────────────────────────

function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function isCoherent(text: string, description?: string | null): boolean {
  const t = text.trim();
  if (t.length < MIN_ARTICLE) return false;
  if (description) {
    const a = collapseWs(t).toLowerCase();
    const b = collapseWs(description).toLowerCase();
    if (b.length >= 40 && (a === b || (a.startsWith(b) && a.length < b.length + 80))) {
      return false;
    }
  }
  return true;
}

export function pickCandidate(candidates: Candidate[], description?: string | null): Candidate | null {
  const passing = candidates.filter(c => isCoherent(c.text, description));
  if (!passing.length) return null;
  const ars = passing.find(c => c.name === 'ars');
  if (ars) return ars;
  const longest = passing.reduce((a, b) => (a.text.length >= b.text.length ? a : b));
  const read = passing.find(c => c.name === 'readability');
  if (read && read.text.length >= longest.text.length * 0.8) return read;
  return longest;
}

export function looksLikePaywall(html: string): boolean {
  return PAYWALL_RE.test(html);
}

export function visibleTextLength(html: string): number {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;
}

export function looksLikeEmptyShell(html: string): boolean {
  const visible = visibleTextLength(html);
  if (visible < 200 && /id=["'](?:root|app|__next)["']/.test(html)) return true;
  return visible < 120;
}

// ── DOM extractors ───────────────────────────────────────────────────────────

function parseDom(html: string, url: string): JSDOM {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  virtualConsole.on('error', () => {});
  virtualConsole.on('warn', () => {});
  return new JSDOM(html, { url, virtualConsole, contentType: 'text/html' });
}

function htmlFragmentToText(fragment: string): string {
  try {
    const { window } = parseDom(`<!DOCTYPE html><body>${fragment}</body>`, 'https://example.com/');
    const blocks = window.document.body.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, pre');
    const parts: string[] = [];
    for (const el of blocks) {
      const t = collapseWs(el.textContent ?? '');
      if (t.length > 1) parts.push(t);
    }
    if (parts.length) return parts.join('\n\n');
    return collapseWs(window.document.body.textContent ?? '');
  } catch {
    return collapseWs(fragment.replace(/<[^>]+>/g, ' '));
  }
}

export function extractArsContainer(html: string): string | null {
  try {
    const { window } = parseDom(html, 'https://arstechnica.com/');
    const nodes = window.document.querySelectorAll('[class*="post-content"]');
    const paras: string[] = [];
    for (const node of nodes) {
      for (const p of node.querySelectorAll('p')) {
        const t = collapseWs(p.textContent ?? '');
        if (t.length > 30) paras.push(t);
      }
    }
    if (paras.length >= 3) return paras.join('\n\n');
    return null;
  } catch {
    return null;
  }
}

export function extractReadability(html: string, url: string): { title: string; text: string; byline: string } | null {
  try {
    const dom = parseDom(html, url);
    const parsed = new Readability(dom.window.document).parse();
    if (!parsed) return null;
    const fromHtml = parsed.content ? htmlFragmentToText(parsed.content) : '';
    const text = fromHtml || collapseWs(parsed.textContent ?? '');
    if (!text) return null;
    return {
      title: (parsed.title || '').trim(),
      text,
      byline: (parsed.byline || '').trim(),
    };
  } catch {
    return null;
  }
}

function runWithStdin(cmd: string, args: string[], stdin: string, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(Object.assign(new Error('timeout'), { killed: true, stderr, stdout }));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve({ stdout, stderr });
    });
    child.stdin.on('error', () => { /* closed early */ });
    child.stdin.end(stdin);
  });
}

export async function runTrafilatura(html: string): Promise<TrafilaturaResult | null> {
  try {
    const { stdout } = await runWithStdin(
      TRAFILATURA,
      ['--json', '--with-metadata', '--no-comments'],
      html,
      35_000,
    );
    const raw = stdout.trim();
    if (!raw) return null;
    const data = JSON.parse(raw) as { text?: string; date?: string; title?: string };
    const text = (data.text || '').trim();
    if (!text) return null;
    return { text, date: data.date || null, title: data.title };
  } catch {
    return null;
  }
}

// ── public extract / preview ─────────────────────────────────────────────────

function sourceFor(url: string): 'ars_technica' | 'web' {
  return classifyUrl(url).source === 'ars_technica' ? 'ars_technica' : 'web';
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export function previewFromHtml(html: string, url: string): Preview {
  const source = sourceFor(url);
  const ld = parseJsonLd(html);
  const title = (ld.headline || ogTitle(html) || titleTag(html) || '').trim();
  const channel_name = (
    ogSiteName(html)
    || (source === 'ars_technica' ? 'Ars Technica' : hostOf(url))
    || ''
  ).trim();
  if (!title) throw ingestError('parse_failed', 'No og:title, JSON-LD headline, or <title> on the page.');
  return {
    source,
    kind: 'article',
    contentType: 'article',
    title,
    channel_name,
    emoji: EMOJI_BY_SOURCE[source],
  };
}

function finishDocument(opts: {
  source: 'ars_technica' | 'web';
  url: string;
  html: string;
  ld: JsonLdArticle;
  text: string;
  traf: TrafilaturaResult | null;
  readable: { title: string; text: string; byline: string } | null;
}): Document {
  let publishedAt = extractPublishedAt(opts.html, opts.url, opts.ld);
  if (!publishedAt && opts.traf?.date) publishedAt = normalizeDate(opts.traf.date);
  const title = (
    opts.ld.headline
    || opts.readable?.title
    || opts.traf?.title
    || ogTitle(opts.html)
    || titleTag(opts.html)
    || ''
  ).trim();
  const author = (opts.ld.author || opts.readable?.byline || '').trim();
  return {
    source: opts.source,
    kind: 'article',
    contentType: 'article',
    title,
    author,
    publishedAt,
    text: opts.text.trim(),
    canonicalUrl: opts.url,
    nativeAudio: false,
  };
}

export async function extractFromHtml(
  html: string,
  url: string,
  opts: {
    trafilatura?: boolean | ((html: string) => Promise<TrafilaturaResult | null>);
  } = {},
): Promise<Document> {
  const source = sourceFor(url);
  const ld = parseJsonLd(html);
  const description = ogDescription(html);
  const candidates: Candidate[] = [];

  // Ars container is the known-good path — skip the generic extractors when it passes.
  if (source === 'ars_technica') {
    const ars = extractArsContainer(html);
    if (ars && isCoherent(ars, description)) {
      return finishDocument({
        source,
        url,
        html,
        ld,
        text: ars,
        traf: null,
        readable: null,
      });
    }
    if (ars) candidates.push({ name: 'ars', text: ars });
  }

  if (ld.articleBody) {
    candidates.push({ name: 'jsonld', text: ld.articleBody.trim() });
  }

  const readable = extractReadability(html, url);
  if (readable?.text) {
    candidates.push({ name: 'readability', text: readable.text });
  }

  let traf: TrafilaturaResult | null = null;
  const trafOpt = opts.trafilatura;
  if (trafOpt === false) {
    traf = null;
  } else if (typeof trafOpt === 'function') {
    traf = await trafOpt(html);
  } else {
    traf = await runTrafilatura(html);
  }
  if (traf?.text) candidates.push({ name: 'trafilatura', text: traf.text.trim() });

  const picked = pickCandidate(candidates, description);
  if (!picked) {
    const longest = candidates.reduce<Candidate | null>(
      (a, b) => (!a || b.text.length > a.text.length ? b : a),
      null,
    );
    console.error(
      '[ingest/web] no candidate passed the quality gate',
      url,
      candidates.map(c => `${c.name}:${c.text.length}`).join(' ') || '(none)',
    );
    if (looksLikePaywall(html)) throw ingestError('paywall');
    if (longest && longest.text.trim().length > 0) {
      throw ingestError('too_short', `(${longest.text.trim().length} characters)`);
    }
    if (looksLikeLoginWall(html)) throw ingestError('login_wall');
    if (looksLikeEmptyShell(html)) {
      throw ingestError('parse_failed', '(JavaScript shell, no article text in the HTML)');
    }
    throw ingestError('extract_failed');
  }

  return finishDocument({
    source,
    url,
    html,
    ld,
    text: picked.text,
    traf,
    readable,
  });
}

export async function previewWeb(url: string): Promise<Preview> {
  try {
    const { html } = await fetchPage(url, 8_000);
    return previewFromHtml(html, url);
  } catch (e) {
    if (e instanceof IngestError) throw e;
    throw e;
  }
}

export async function extractWeb(url: string): Promise<Document> {
  const { html, finalUrl } = await fetchPage(url);
  return extractFromHtml(html, finalUrl || url);
}
