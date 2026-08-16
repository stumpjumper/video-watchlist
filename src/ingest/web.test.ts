import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import path from 'path';
import { IngestError } from './errors';
import {
  dateFromUrl,
  extractArsContainer,
  extractFromHtml,
  extractPublishedAt,
  isCoherent,
  looksLikeEmptyShell,
  looksLikePaywall,
  normalizeDate,
  parseJsonLd,
  pickCandidate,
  previewFromHtml,
  runTrafilatura,
} from './web';

const BEES = readFileSync(
  path.join(__dirname, '..', '..', 'public', 'test-articles', 'bees.html'),
  'utf8',
);

const LONG_A = 'A honeybee that finds a patch of flowers can fly back to the hive and communicate its exact location to thousands of other bees using nothing but movement. '.repeat(3);
const LONG_B = 'Coffee houses sprang up across the Arab world and became centers of social life — places where people gathered to talk, play chess, and exchange information. '.repeat(3);
const LONG_C = 'What makes this even more remarkable is that the honeybee brain contains fewer than a million neurons, yet packs navigation and memory into a sesame seed. '.repeat(3);

function jsonLdPage(fields: Record<string, unknown>, extraHtml = ''): string {
  return `<!DOCTYPE html><html><head>
<title>Fallback Title</title>
<meta property="og:title" content="OG Title">
<meta property="og:site_name" content="Example Site">
<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    ...fields,
  })}</script>
</head><body>${extraHtml}</body></html>`;
}

describe('normalizeDate / dateFromUrl', () => {
  it('keeps ISO datetimes and date-only values', () => {
    assert.equal(normalizeDate('2026-08-15T15:46:05+00:00'), '2026-08-15T15:46:05+00:00');
    assert.equal(normalizeDate('2024-05-02'), '2024-05-02');
    assert.equal(normalizeDate('20240502'), '2024-05-02');
  });

  it('rejects garbage and implausible years', () => {
    assert.equal(normalizeDate('not a date'), null);
    assert.equal(normalizeDate('1899-01-01'), null);
  });

  it('reads a YYYY-MM-DD path segment', () => {
    assert.equal(dateFromUrl('https://tldr.tech/ai/2026-07-03'), '2026-07-03');
    assert.equal(dateFromUrl('https://example.com/2026/07/some-slug/'), null);
  });
});

describe('parseJsonLd', () => {
  it('pulls articleBody, headline, author, and date out of NewsArticle', () => {
    const html = jsonLdPage({
      headline: 'Grok Build will rewrite how you use your laptop',
      articleBody: LONG_A,
      datePublished: '2026-08-15T15:46:05+00:00',
      author: { '@type': 'Person', name: 'Eric Berger' },
    });
    const ld = parseJsonLd(html);
    assert.equal(ld.headline, 'Grok Build will rewrite how you use your laptop');
    assert.equal(ld.author, 'Eric Berger');
    assert.equal(ld.datePublished, '2026-08-15T15:46:05+00:00');
    assert.match(ld.articleBody ?? '', /honeybee/);
  });

  it('walks @graph', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      '@graph': [
        { '@type': 'WebSite', name: 'Example' },
        { '@type': 'Article', headline: 'Inside @graph', articleBody: LONG_B, datePublished: '2024-03-15' },
      ],
    })}</script>`;
    const ld = parseJsonLd(html);
    assert.equal(ld.headline, 'Inside @graph');
    assert.ok((ld.articleBody ?? '').length > 150);
  });
});

describe('extractPublishedAt', () => {
  it('prefers JSON-LD over meta and URL', () => {
    const html = jsonLdPage({
      headline: 'Hi',
      datePublished: '2026-08-15T15:46:05+00:00',
    }).replace('</head>', '<meta property="article:published_time" content="2020-01-01"></head>');
    assert.equal(
      extractPublishedAt(html, 'https://example.com/2024-05-02/post'),
      '2026-08-15T15:46:05+00:00',
    );
  });

  it('falls back to article:published_time, then the URL', () => {
    const meta = `<html><head><meta property="article:published_time" content="2024-05-02T08:00:00Z"></head><body></body></html>`;
    assert.equal(extractPublishedAt(meta, 'https://example.com/x'), '2024-05-02T08:00:00+00:00');
    assert.equal(extractPublishedAt('<html></html>', 'https://tldr.tech/ai/2026-07-03'), '2026-07-03');
  });
});

describe('pickCandidate', () => {
  it('prefers the Ars container when it passes', () => {
    const picked = pickCandidate([
      { name: 'ars', text: LONG_A },
      { name: 'readability', text: LONG_A + LONG_B },
    ]);
    assert.equal(picked?.name, 'ars');
  });

  it('prefers Readability when both it and another candidate are long', () => {
    const picked = pickCandidate([
      { name: 'trafilatura', text: LONG_A + ' extra chrome words here.' },
      { name: 'readability', text: LONG_A },
    ]);
    assert.equal(picked?.name, 'readability');
  });

  it('takes the longest when Readability missed most of the article', () => {
    const teaser = LONG_A.slice(0, 180);
    const picked = pickCandidate([
      { name: 'readability', text: teaser },
      { name: 'jsonld', text: LONG_A + LONG_B + LONG_C },
    ]);
    assert.equal(picked?.name, 'jsonld');
  });

  it('rejects text that is just the og:description', () => {
    assert.equal(isCoherent(LONG_A.slice(0, 80), LONG_A.slice(0, 80)), false);
    assert.equal(pickCandidate([{ name: 'jsonld', text: 'short teaser only' }]), null);
  });
});

describe('extractArsContainer', () => {
  it('joins qualifying <p>s inside post-content', () => {
    const html = `<div class="post-content">
      <p>${LONG_A}</p>
      <p>${LONG_B}</p>
      <p>${LONG_C}</p>
    </div>
    <div class="comments"><p>${'nope '.repeat(40)}</p></div>`;
    const text = extractArsContainer(html);
    assert.ok(text);
    assert.match(text!, /honeybee/);
    assert.match(text!, /Coffee houses/);
    assert.doesNotMatch(text!, /nope/);
  });
});

describe('extractFromHtml', () => {
  it('uses JSON-LD articleBody when that is the only long candidate', async () => {
    const html = jsonLdPage({
      headline: 'JSON-LD only article',
      articleBody: LONG_A + LONG_B,
      datePublished: '2026-01-02T00:00:00+00:00',
      author: 'Ada Lovelace',
    });
    const doc = await extractFromHtml(html, 'https://example.com/ld', { trafilatura: false });
    assert.equal(doc.source, 'web');
    assert.equal(doc.title, 'JSON-LD only article');
    assert.equal(doc.author, 'Ada Lovelace');
    assert.equal(doc.publishedAt, '2026-01-02T00:00:00+00:00');
    assert.match(doc.text, /honeybee/);
    assert.equal(doc.nativeAudio, false);
  });

  it('reads a normal <article> via Readability', async () => {
    const doc = await extractFromHtml(BEES, 'https://example.com/bees', { trafilatura: false });
    assert.match(doc.title, /How Bees Know Where They Are/);
    assert.match(doc.text, /waggle dance/i);
    assert.ok(doc.text.length > 150);
    assert.equal(doc.publishedAt, '2024-05-02T08:00:00+00:00');
  });

  it('uses the Ars container on arstechnica.com URLs', async () => {
    const html = `<html><head><title>Ars story</title></head><body>
      <div class="post-content">
        <p>${LONG_A}</p>
        <p>${LONG_B}</p>
        <p>${LONG_C}</p>
      </div>
      <article><p>${'Related junk that a generic reader might keep. '.repeat(20)}</p></article>
    </body></html>`;
    const doc = await extractFromHtml(
      html,
      'https://arstechnica.com/space/2026/08/ukraine-strikes/',
      { trafilatura: false },
    );
    assert.equal(doc.source, 'ars_technica');
    assert.match(doc.text, /honeybee/);
    assert.match(doc.text, /Coffee houses/);
    assert.doesNotMatch(doc.text, /Related junk/);
  });

  it('throws paywall when the page is a teaser plus a subscribe wall', async () => {
    const html = `<html><body>
      <p>One short teaser paragraph.</p>
      <div>Subscribe to continue reading this exclusive report.</div>
    </body></html>`;
    await assert.rejects(
      () => extractFromHtml(html, 'https://example.com/walled', { trafilatura: false }),
      (err: unknown) => err instanceof IngestError && err.code === 'paywall' && err.retryable === false,
    );
  });

  it('throws parse_failed for an empty JavaScript shell', async () => {
    const html = `<!doctype html><html><head><title>The Defense Reformation</title></head>
      <body><div id="root"></div><script src="/assets/index.js"></script></body></html>`;
    await assert.rejects(
      () => extractFromHtml(html, 'https://18theses.com/', { trafilatura: false }),
      (err: unknown) => err instanceof IngestError && err.code === 'parse_failed' && err.retryable === false,
    );
  });

  it('throws too_short when extractors return a stub', async () => {
    const html = `<html><head><title>Tiny</title></head><body>
      <article><p>This page only has a couple of short sentences in it.</p></article>
    </body></html>`;
    await assert.rejects(
      () => extractFromHtml(html, 'https://example.com/tiny', { trafilatura: false }),
      (err: unknown) => err instanceof IngestError && err.code === 'too_short' && err.retryable === false,
    );
  });

  it('does not treat the word paywall in analytics JS as a wall', () => {
    assert.equal(looksLikePaywall('{"accessPaywall":undefined,"subscriberStatus":"none"}'), false);
    assert.equal(looksLikePaywall('Subscribe to continue reading'), true);
    assert.equal(looksLikeEmptyShell('<html><body><div id="root"></div></body></html>'), true);
  });
});

describe('runTrafilatura', () => {
  it('extracts bees.html from stdin when the binary is installed', async () => {
    const got = await runTrafilatura(BEES);
    if (!got) {
      console.log('skip: trafilatura not available');
      return;
    }
    assert.match(got.text, /waggle dance/i);
    assert.ok(got.text.length > 150);
  });
});

describe('previewFromHtml', () => {
  it('prefers the JSON-LD headline over og:title', () => {
    const preview = previewFromHtml(
      jsonLdPage({ headline: 'Real headline from JSON-LD' }),
      'https://example.com/post',
    );
    assert.equal(preview.title, 'Real headline from JSON-LD');
    assert.equal(preview.channel_name, 'Example Site');
    assert.equal(preview.source, 'web');
    assert.equal(preview.emoji, '📰');
  });

  it('labels Ars pages as ars_technica', () => {
    const preview = previewFromHtml(
      '<html><head><title>Ukraine strikes - Ars Technica</title></head><body></body></html>',
      'https://arstechnica.com/space/2026/08/ukraine-strikes/',
    );
    assert.equal(preview.source, 'ars_technica');
    assert.equal(preview.channel_name, 'Ars Technica');
    assert.equal(preview.emoji, '🚀');
  });
});
