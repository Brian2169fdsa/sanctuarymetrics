#!/usr/bin/env python3
"""Crawl sanctuaryrecoverycenters.com and build website-pages.js.

    python3 tools/crawl-website.py

Reads every URL in the site's sitemap.xml, fetches it, and keeps what the
"Website edits" page shows: title, meta description, H1, the page's own
content (headings and paragraphs, without the shared header and footer),
word and image counts, and a few quick checks (missing description, no H1,
leftover template text). Re-run it after the site changes and commit the
new website-pages.js.

The site is built on Duda: the page body lives in #dm_content; the header
(#hcontainer) and footer (.dmFooterContainer) repeat on every page and are
skipped.
"""
import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup

SITE = 'https://www.sanctuaryrecoverycenters.com'
OUT = 'website-pages.js'
UA = 'SanctuaryMetrics site inventory (internal)'
MAX_BLOCKS = 80          # per page, keeps the published file small
MAX_BLOCK_CHARS = 600

# Duda's sample-gallery text that should never reach a live page
PLACEHOLDERS = [r'Photo By: John Doe', r'\bLorem ipsum\b', r'\bJohn Doe\b', r'^Button$',
                r'^Fashion Magazine$', r'^Birthday Sparks$', r'^City skyline$']
PLACEHOLDER_RE = [re.compile(p, re.I) for p in PLACEHOLDERS]
BLOCK_TAGS = ['h1', 'h2', 'h3', 'h4', 'p', 'li']
DATE_RE = re.compile(r'\b(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, (20\d\d)\b')


def get(url):
    for attempt in range(3):
        try:
            r = requests.get(url, headers={'User-Agent': UA}, timeout=30)
            return r
        except requests.RequestException:
            time.sleep(2 ** attempt)
    return None


def sitemap():
    r = get(SITE + '/sitemap.xml')
    soup = BeautifulSoup(r.text, 'xml')
    out = []
    for u in soup.find_all('url'):
        loc = u.find('loc').text.strip()
        lm = u.find('lastmod')
        out.append((loc, lm.text.strip() if lm else ''))
    return out


def clean(t):
    return re.sub(r'\s+', ' ', t.replace('﻿', '')).strip()


def blocks_of(content):
    """Headings, paragraphs and list items in reading order, skipping any
    element nested inside another one already taken."""
    out, seen = [], set()
    for el in content.find_all(BLOCK_TAGS):
        if any(id(p) in seen for p in el.parents):
            continue
        seen.add(id(el))
        text = clean(el.get_text(' '))
        if not text:
            continue
        tag = 'p' if el.name == 'li' else el.name
        if out and out[-1][1] == text:
            continue
        out.append([tag, text[:MAX_BLOCK_CHARS]])
    return out


def page(entry):
    url, lastmod = entry
    r = get(url)
    path = urlparse(url).path or '/'
    if r is None or r.status_code != 200:
        return {'url': url, 'path': path, 'lastmod': lastmod, 'status': r.status_code if r else 0,
                'kind': 'page', 'published': '',
                'title': '', 'description': '', 'h1': [], 'words': 0, 'images': 0, 'blocks': [],
                'issues': ['Page did not load (' + str(r.status_code if r else 'no response') + ')']}
    soup = BeautifulSoup(r.text, 'lxml')
    title = clean(soup.title.get_text()) if soup.title else ''
    d = soup.find('meta', attrs={'name': 'description'})
    desc = clean(d.get('content', '')) if d else ''
    content = soup.select_one('#dm_content') or soup.body
    blocks = blocks_of(content)
    h1 = [clean(h.get_text(' ')) for h in content.find_all('h1')]
    body_text = clean(content.get_text(' '))
    words = len(body_text.split())
    # blog posts carry their publish date near the top of the body
    m = DATE_RE.search(body_text[:500])
    images = len(content.find_all('img')) + len(content.select('[data-bg], .dmImageSlider, [style*="background-image"]'))

    issues = []
    if not desc:
        issues.append('No meta description')
    elif len(desc) > 165:
        issues.append('Meta description is long (' + str(len(desc)) + ' chars)')
    if not title:
        issues.append('No page title')
    elif len(title) > 65:
        issues.append('Page title is long (' + str(len(title)) + ' chars)')
    if not h1:
        issues.append('No H1 heading')
    elif len(h1) > 1:
        issues.append(str(len(h1)) + ' H1 headings')
    hits = sorted({b[1] for b in blocks for rx in PLACEHOLDER_RE if rx.search(b[1])})
    hits += sorted({clean(t) for t in content.find_all(string=PLACEHOLDER_RE[0])} - set(hits))
    if hits:
        issues.append('Template placeholder text: ' + '; '.join(hits[:4]))
    if words < 150:
        issues.append('Thin content (' + str(words) + ' words)')

    return {'url': url, 'path': path, 'lastmod': lastmod, 'status': 200, 'title': title,
            'kind': 'blog' if m else 'page', 'published': m.group(0) if m else '',
            'description': desc, 'h1': h1, 'words': words, 'images': images,
            'blocks': blocks[:MAX_BLOCKS], 'issues': issues}


def main():
    entries = sitemap()
    print(len(entries), 'URLs in sitemap', file=sys.stderr)
    with ThreadPoolExecutor(max_workers=6) as pool:
        pages = list(pool.map(page, entries))
    pages.sort(key=lambda p: (p['path'] != '/', p['path']))
    data = {'site': SITE, 'crawled': datetime.now(timezone.utc).strftime('%Y-%m-%d'), 'pages': pages}
    with open(OUT, 'w') as f:
        f.write('/* Built by tools/crawl-website.py — do not edit by hand. */\n')
        f.write('var WEBSITE = ' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n')
    bad = sum(1 for p in pages if p['status'] != 200)
    print('wrote', OUT, len(pages), 'pages,', bad, 'failed', file=sys.stderr)


if __name__ == '__main__':
    main()
