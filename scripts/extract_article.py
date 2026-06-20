#!/usr/bin/env python3
"""
Extract article text + publication date from a URL.
Uses site-specific extraction for known sites, falls back to trafilatura.
Output: JSON {"text": "...", "published_at": "..."|null}
Usage: extract_article.py <url>
"""
import sys, re, subprocess, urllib.request, json
from html.parser import HTMLParser

TRAFILATURA = '/Users/nano/.local/bin/trafilatura'
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'

def fetch_html(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode('utf-8', errors='replace')

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

class MetaDateExtractor(HTMLParser):
    """Extract publication date from <meta> tags and JSON-LD."""
    DATE_PROPS = {
        'article:published_time', 'article:published_date',
        'og:article:published_time',
    }
    DATE_NAMES = {'publish_date', 'date', 'dc.date', 'dcterms.created'}

    def __init__(self):
        super().__init__()
        self.published_at = None
        self._in_ld = False
        self._ld_buf = []

    def handle_starttag(self, tag, attrs):
        if self.published_at:
            return
        d = dict(attrs)
        if tag == 'meta':
            prop = (d.get('property') or '').lower()
            name = (d.get('name') or '').lower()
            content = d.get('content', '').strip()
            if content and (prop in self.DATE_PROPS or name in self.DATE_NAMES):
                self.published_at = content
        if tag == 'script' and d.get('type') == 'application/ld+json':
            self._in_ld = True
            self._ld_buf = []

    def handle_endtag(self, tag):
        if tag == 'script' and self._in_ld:
            self._in_ld = False
            if not self.published_at:
                try:
                    data = json.loads(''.join(self._ld_buf))
                    # handle single object or @graph array
                    items = data if isinstance(data, list) else [data]
                    for item in items:
                        if isinstance(item, dict):
                            date = item.get('datePublished') or item.get('dateCreated')
                            if date:
                                self.published_at = str(date)
                                break
                except Exception:
                    pass

    def handle_data(self, data):
        if self._in_ld:
            self._ld_buf.append(data)

def extract_published_at(html):
    p = MetaDateExtractor()
    p.feed(html)
    return p.published_at or None

def extract_trafilatura(url):
    r = subprocess.run([TRAFILATURA, '-u', url],
                       capture_output=True, text=True, timeout=35)
    return r.stdout.strip() or None

SITE_RULES = {
    'arstechnica.com': ['post-content'],
}

def main():
    if len(sys.argv) < 2:
        sys.stderr.write('usage: extract_article.py <url>\n')
        sys.exit(1)
    url = sys.argv[1]

    for domain, classes in SITE_RULES.items():
        if domain in url:
            try:
                html = fetch_html(url)
                text = extract_via_container(html, classes)
                if text:
                    print(json.dumps({
                        'text': text,
                        'published_at': extract_published_at(html),
                    }))
                    return
            except Exception as e:
                sys.stderr.write(f'site extractor failed: {e}\n')
            break

    try:
        text = extract_trafilatura(url)
        if text:
            published_at = None
            try:
                html = fetch_html(url)
                published_at = extract_published_at(html)
            except Exception:
                pass
            print(json.dumps({'text': text, 'published_at': published_at}))
            return
    except Exception as e:
        sys.stderr.write(f'trafilatura failed: {e}\n')

    sys.stderr.write('all extractors failed\n')
    sys.exit(1)

if __name__ == '__main__':
    main()
