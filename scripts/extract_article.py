#!/usr/bin/env python3
"""
Extract article text + publication date from a URL.
Uses site-specific extraction for known sites, falls back to trafilatura.

The page is fetched once here (browser UA — sites that block trafilatura's
own fetcher often allow this) and shared by every extractor. Trafilatura
runs on the fetched HTML via stdin; its own URL-fetching mode is only a
last resort if our fetch failed.

Date priority: meta/JSON-LD/<time> markup > trafilatura's heuristic (htmldate)
> a YYYY-MM-DD embedded in the URL. All dates are normalized to ISO 8601 and
validated — never emit a string that a Date parser could choke on.

Output: JSON {"text": "...", "published_at": "..."|null}
Usage: extract_article.py <url>
"""
import sys, re, gzip, subprocess, urllib.request, json
import email.utils
from datetime import datetime
from html.parser import HTMLParser

TRAFILATURA = '/Users/nano/.local/bin/trafilatura'
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
MIN_TEXT_LEN = 150  # below this it's a cookie wall / error page, not an article

def fetch_html(url):
    req = urllib.request.Request(url, headers={
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read()
        if r.headers.get('Content-Encoding') == 'gzip':
            raw = gzip.decompress(raw)
        charset = r.headers.get_content_charset() or 'utf-8'
        return raw.decode(charset, errors='replace')

class ContainerExtractor(HTMLParser):
    """Extract <p> text from within a div whose class contains any of container_classes."""
    def __init__(self, container_classes):
        super().__init__()
        self.container_classes = container_classes
        self.depth = 0
        self.in_container = False
        self.container_depth = 0
        self.in_p = False
        self.p_depth = 0
        self.paragraphs = []
        self._buf = []

    def handle_starttag(self, tag, attrs):
        self.depth += 1
        cls = dict(attrs).get('class', '')
        if not self.in_container and any(c in cls for c in self.container_classes):
            self.in_container = True
            self.container_depth = self.depth
        if self.in_container and tag == 'p' and not self.in_p:
            self.in_p = True
            self.p_depth = self.depth
            self._buf = []

    def handle_endtag(self, tag):
        if self.in_p and tag == 'p' and self.depth == self.p_depth:
            text = ' '.join(self._buf).strip()
            text = re.sub(r'\s+', ' ', text)
            if len(text) > 30:
                self.paragraphs.append(text)
            self.in_p = False
        if self.in_container and self.depth == self.container_depth:
            self.in_container = False
        self.depth -= 1

    def handle_data(self, data):
        if self.in_p:
            self._buf.append(data.strip())

def extract_via_container(html, container_classes):
    p = ContainerExtractor(container_classes)
    p.feed(html)
    if len(p.paragraphs) >= 3:
        return '\n\n'.join(p.paragraphs)
    return None

def _ld_date(data):
    """Walk JSON-LD (single object, list, or @graph) for a publication date."""
    stack = [data]
    while stack:
        item = stack.pop()
        if isinstance(item, list):
            stack.extend(item)
        elif isinstance(item, dict):
            date = item.get('datePublished') or item.get('dateCreated')
            if date:
                return str(date)
            if '@graph' in item:
                stack.append(item['@graph'])
    return None

class MetaDateExtractor(HTMLParser):
    """Extract publication date from <meta> tags, JSON-LD, and <time datetime>."""
    DATE_PROPS = {
        'article:published_time', 'article:published_date',
        'og:article:published_time',
    }
    DATE_NAMES = {'publish_date', 'date', 'dc.date', 'dcterms.created'}

    def __init__(self):
        super().__init__()
        self.published_at = None   # from meta / JSON-LD — authoritative
        self.time_datetime = None  # first <time datetime> — weaker fallback
        self._in_ld = False
        self._ld_buf = []

    def handle_starttag(self, tag, attrs):
        d = dict(attrs)
        if tag == 'time' and not self.time_datetime and d.get('datetime'):
            self.time_datetime = d['datetime'].strip()
        if self.published_at:
            return
        if tag == 'meta':
            prop = (d.get('property') or '').lower()
            name = (d.get('name') or '').lower()
            itemprop = (d.get('itemprop') or '')
            content = (d.get('content') or '').strip()
            if content and (prop in self.DATE_PROPS or name in self.DATE_NAMES
                            or itemprop == 'datePublished'):
                self.published_at = content
        if tag == 'script' and d.get('type') == 'application/ld+json':
            self._in_ld = True
            self._ld_buf = []

    def handle_endtag(self, tag):
        if tag == 'script' and self._in_ld:
            self._in_ld = False
            if not self.published_at:
                try:
                    self.published_at = _ld_date(json.loads(''.join(self._ld_buf)))
                except Exception:
                    pass

    def handle_data(self, data):
        if self._in_ld:
            self._ld_buf.append(data)

def extract_published_at(html):
    p = MetaDateExtractor()
    try:
        p.feed(html)
    except Exception:
        pass
    return p.published_at or p.time_datetime or None

def normalize_date(s):
    """Parse a claimed date string; return ISO 8601 or None. Never pass garbage through."""
    if not s:
        return None
    s = str(s).strip()
    dt = None
    try:
        dt = datetime.fromisoformat(s.replace('Z', '+00:00'))
    except ValueError:
        pass
    if dt is None:
        try:
            dt = email.utils.parsedate_to_datetime(s)  # RFC 2822: "Fri, 03 Jul 2026 ..."
        except (ValueError, TypeError):
            pass
    if dt is None:
        for fmt in ('%Y%m%d', '%B %d, %Y', '%d %B %Y', '%m/%d/%Y', '%Y/%m/%d'):
            try:
                dt = datetime.strptime(s, fmt)
                break
            except ValueError:
                continue
    if dt is None or not (1995 <= dt.year <= datetime.now().year + 1):
        return None
    if dt.tzinfo is None and (dt.hour, dt.minute, dt.second) == (0, 0, 0):
        return dt.date().isoformat()
    return dt.isoformat()

def date_from_url(url):
    """A full YYYY-MM-DD (or YYYY/MM/DD) path segment, e.g. tldr.tech/ai/2026-07-03.
    Requires all three parts numeric, so /2026/07/some-slug/ does not match."""
    m = re.search(r'/(20\d{2})[-/](\d{1,2})[-/](\d{1,2})(?:[/?#]|$)', url)
    if not m:
        return None
    try:
        return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3))).date().isoformat()
    except ValueError:
        return None

def run_trafilatura(args, stdin_text=None):
    """Run trafilatura --json; return (text, date) — (None, None) on any failure."""
    try:
        r = subprocess.run([TRAFILATURA, '--json', *args],
                           input=stdin_text, capture_output=True, text=True, timeout=35)
        data = json.loads(r.stdout)
        text = (data.get('text') or '').strip()
        return (text or None, data.get('date') or None)
    except Exception:
        return (None, None)

SITE_RULES = {
    'arstechnica.com': ['post-content'],
}

def main():
    if len(sys.argv) < 2:
        sys.stderr.write('usage: extract_article.py <url>\n')
        sys.exit(1)
    url = sys.argv[1]

    html = None
    try:
        html = fetch_html(url)
    except Exception as e:
        sys.stderr.write(f'fetch failed: {e}\n')

    text = None
    traf_date = None
    if html:
        for domain, classes in SITE_RULES.items():
            if domain in url:
                text = extract_via_container(html, classes)
                break
        if not text:
            text, traf_date = run_trafilatura([], stdin_text=html)
    if not text:
        # Last resort: trafilatura's own fetcher (different code path than ours).
        text, traf_date = run_trafilatura(['-u', url])
    if not text or len(text) < MIN_TEXT_LEN:
        sys.stderr.write('all extractors failed\n')
        sys.exit(1)

    published_at = None
    if html:
        published_at = normalize_date(extract_published_at(html))
    if not published_at:
        published_at = normalize_date(traf_date)
    if not published_at:
        published_at = date_from_url(url)

    print(json.dumps({'text': text, 'published_at': published_at}))

if __name__ == '__main__':
    main()
