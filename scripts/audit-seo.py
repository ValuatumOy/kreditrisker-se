#!/usr/bin/env python3
"""Check the actual static build before changing search indexing settings."""

import argparse
import json
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urljoin, urlsplit
import xml.etree.ElementTree as ET


NS = {'s': 'http://www.sitemaps.org/schemas/sitemap/0.9'}


class Page(HTMLParser):
    def __init__(self, text):
        super().__init__(convert_charrefs=True)
        self.lang = ''
        self.titles = []
        self.headings = 0
        self.descriptions = []
        self.robots = []
        self.canonicals = []
        self.og = {}
        self.links = []
        self.redirect = False
        self.json_ld = []
        self.in_title = False
        self.in_json_ld = False
        self.feed(text)

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if tag == 'html':
            self.lang = attrs.get('lang', '')
        elif tag == 'title':
            self.titles.append('')
            self.in_title = True
        elif tag == 'h1':
            self.headings += 1
        elif tag == 'meta':
            if attrs.get('name', '').lower() == 'description':
                self.descriptions.append(attrs.get('content', ''))
            if attrs.get('name', '').lower() == 'robots':
                self.robots.append(attrs.get('content', ''))
            if attrs.get('http-equiv', '').lower() == 'refresh':
                self.redirect = True
            if attrs.get('property', '').startswith('og:'):
                self.og.setdefault(attrs['property'], []).append(attrs.get('content', ''))
        elif tag == 'link' and 'canonical' in attrs.get('rel', '').lower().split():
            self.canonicals.append(attrs.get('href', ''))
        elif tag == 'a' and attrs.get('href'):
            self.links.append(attrs['href'])
        elif tag == 'script' and attrs.get('type', '').lower() == 'application/ld+json':
            self.json_ld.append('')
            self.in_json_ld = True

    def handle_data(self, data):
        if self.in_title:
            self.titles[-1] += data
        if self.in_json_ld:
            self.json_ld[-1] += data

    def handle_endtag(self, tag):
        if tag == 'title':
            self.in_title = False
        elif tag == 'script':
            self.in_json_ld = False


def page_path(root, file):
    rel = file.relative_to(root).as_posix()
    if rel == '404.html':
        return '/404/'
    if rel == 'index.html':
        return '/'
    if rel.endswith('/index.html'):
        return '/' + rel[:-len('index.html')]
    return '/' + rel


def local_file(root, path):
    # Resolve only within this build, even if a malformed URL contains ../.
    target = (root / unquote(path).lstrip('/')).resolve()
    if not target.is_relative_to(root):
        return None
    if target.is_dir():
        target /= 'index.html'
    return target if target.is_file() else None


def robots_rules(text):
    groups = []
    agents, rules, sitemaps = [], [], []
    for line in text.splitlines():
        line = line.split('#', 1)[0].strip()
        if ':' not in line:
            continue
        key, value = (part.strip() for part in line.split(':', 1))
        key = key.lower()
        if key == 'user-agent':
            if rules:
                groups.append((agents, rules))
                agents, rules = [], []
            agents.append(value.lower())
        elif key in ('allow', 'disallow') and agents:
            rules.append((key, value))
        elif key == 'sitemap':
            sitemaps.append(value)
    if agents:
        groups.append((agents, rules))
    wildcard = [rule for agents, rules in groups if '*' in agents for rule in rules]
    return any('*' in agents for agents, _ in groups), wildcard, sitemaps


def audit(root, origin, mode):
    root = Path(root).resolve()
    origin = origin.rstrip('/')
    errors = []
    pages = {}
    files = list(root.rglob('*.html')) if root.is_dir() else []
    if not files:
        return ['No HTML pages found in the build directory.'], 0, 0

    for file in files:
        path = page_path(root, file)
        page = Page(file.read_text(encoding='utf-8'))
        pages[path] = page
        if page.lang.lower() != 'sv':
            errors.append(f'{path}: expected lang="sv"')
        if len(page.titles) != 1 or not page.titles[0].strip():
            errors.append(f'{path}: expected one nonempty title')
        if len(page.robots) != 1 or not page.robots[0].strip():
            errors.append(f'{path}: expected one robots meta tag')
        # This isolated frame is an internal measurement endpoint, not a content page.
        if path == '/analytics-frame/':
            if not page.robots or 'noindex' not in page.robots[0].lower():
                errors.append(f'{path}: analytics frame must be noindex')
            continue
        if len(page.canonicals) != 1 or not page.canonicals[0].startswith(origin + '/'):
            errors.append(f'{path}: expected one canonical on {origin}')
        if page.redirect:
            if not page.robots or 'noindex' not in page.robots[0].lower():
                errors.append(f'{path}: redirect fallback must be noindex')
            continue
        if page.headings != 1:
            errors.append(f'{path}: expected one h1, found {page.headings}')
        if len(page.descriptions) != 1 or not page.descriptions[0].strip():
            errors.append(f'{path}: expected one nonempty meta description')
        if page.canonicals != [origin + path]:
            errors.append(f'{path}: canonical does not match page URL')
        for field in ('og:title', 'og:description', 'og:url'):
            if len(page.og.get(field, [])) != 1 or not page.og[field][0].strip():
                errors.append(f'{path}: expected one nonempty {field}')
        if page.og.get('og:url') != [origin + path]:
            errors.append(f'{path}: og:url does not match page URL')
        for item in page.json_ld:
            try:
                json.loads(item)
            except ValueError:
                errors.append(f'{path}: invalid JSON-LD')
        if mode == 'blocked' and page.robots and 'noindex' not in page.robots[0].lower():
            errors.append(f'{path}: blocked build has an indexable page')

    # Links are checked within the complete build only, not against remote sites.
    for path, page in pages.items():
        for href in page.links:
            if href.startswith('#'):
                continue
            url = urlsplit(urljoin(origin + path, href))
            if f'{url.scheme}://{url.netloc}' == origin and not local_file(root, url.path):
                errors.append(f'{path}: broken internal link {url.path}')

    robots_file = root / 'robots.txt'
    robots = robots_file.read_text(encoding='utf-8') if robots_file.is_file() else ''
    has_wildcard, wildcard_rules, sitemaps = robots_rules(robots)
    if not has_wildcard:
        errors.append('robots.txt: missing User-agent: *')
    blocked = ('disallow', '/') in wildcard_rules and ('allow', '/') not in wildcard_rules
    if mode == 'blocked' and not blocked:
        errors.append('robots.txt: blocked build must disallow /')
    if mode == 'indexable' and blocked:
        errors.append('robots.txt: indexable build must not disallow /')
    if mode == 'indexable' and origin + '/sitemap-index.xml' not in sitemaps:
        errors.append('robots.txt: missing sitemap index')

    urls = set()
    try:
        index = ET.parse(root / 'sitemap-index.xml').getroot()
        if index.tag != f'{{{NS["s"]}}}sitemapindex':
            raise ValueError('not a sitemap index')
        sitemap_locs = [node.text or '' for node in index.findall('s:sitemap/s:loc', NS)]
        if not sitemap_locs or len(sitemap_locs) != len(set(sitemap_locs)):
            errors.append('sitemap-index.xml: empty or duplicate sitemap locations')
        for loc in sitemap_locs:
            parsed = urlsplit(loc)
            if f'{parsed.scheme}://{parsed.netloc}' != origin or parsed.query or parsed.fragment:
                errors.append(f'sitemap index: invalid location {loc}')
                continue
            file = local_file(root, parsed.path)
            if not file:
                errors.append(f'sitemap index: missing {parsed.path}')
                continue
            urlset = ET.parse(file).getroot()
            if urlset.tag != f'{{{NS["s"]}}}urlset':
                errors.append(f'{parsed.path}: expected urlset')
                continue
            for node in urlset.findall('s:url/s:loc', NS):
                url = node.text or ''
                if url in urls:
                    errors.append(f'duplicate sitemap URL: {url}')
                urls.add(url)
                parts = urlsplit(url)
                page = pages.get(parts.path)
                if f'{parts.scheme}://{parts.netloc}' != origin or parts.query or parts.fragment:
                    errors.append(f'invalid sitemap URL: {url}')
                elif not page:
                    errors.append(f'sitemap URL has no built page: {url}')
                elif page.redirect or page.canonicals != [url] or not page.robots or 'noindex' in page.robots[0].lower():
                    errors.append(f'sitemap URL is redirected, noncanonical, or noindex: {url}')
    except (OSError, ET.ParseError, ValueError) as exc:
        errors.append(f'sitemap: {exc}')
    if mode == 'blocked' and urls:
        errors.append('blocked build must have empty sitemaps')
    if mode == 'indexable' and origin + '/' not in urls:
        errors.append('indexable build must list the homepage in a sitemap')

    return errors, len(pages), len(urls)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dir', default='dist', help='complete build directory (default: dist)')
    parser.add_argument('--origin', default='https://www.kreditrisker.se', help='canonical site origin')
    parser.add_argument('--mode', required=True, choices=('blocked', 'indexable'))
    args = parser.parse_args()
    errors, pages, urls = audit(args.dir, args.origin, args.mode)
    print(f'Checked {pages} HTML pages and {urls} sitemap URLs in {args.mode} mode.')
    for error in errors:
        print('ERROR:', error)
    return 1 if errors else 0


if __name__ == '__main__':
    raise SystemExit(main())
