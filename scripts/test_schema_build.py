"""Validate structured data against the rendered, complete static build."""

import json
import os
from html.parser import HTMLParser
from pathlib import Path
import unittest
from urllib.parse import urljoin


def clean(value):
    return ' '.join(value.split())


class Page(HTMLParser):
    def __init__(self, path):
        super().__init__(convert_charrefs=True)
        self.json_ld = []
        self.canonical = ''
        self.robots = ''
        self.site_name = ''
        self.h1 = ''
        self.body = ''
        self.times = []
        self.crumbs = []
        self.faq = []
        self.in_json = False
        self.in_h1 = False
        self.in_body = False
        self.in_crumbs = False
        self.in_faq = False
        self.faq_field = None
        self.feed(path.read_text(encoding='utf-8'))
        self.items = [json.loads(item) for item in self.json_ld]

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if tag == 'script' and attrs.get('type') == 'application/ld+json':
            self.json_ld.append('')
            self.in_json = True
        elif tag == 'link' and attrs.get('rel') == 'canonical':
            self.canonical = attrs.get('href', '')
        elif tag == 'meta' and attrs.get('name') == 'robots':
            self.robots = attrs.get('content', '')
        elif tag == 'meta' and attrs.get('property') == 'og:site_name':
            self.site_name = attrs.get('content', '')
        elif tag == 'body':
            self.in_body = True
        elif tag == 'h1':
            self.in_h1 = True
        elif tag == 'time' and attrs.get('datetime'):
            self.times.append(attrs['datetime'])
        elif tag == 'nav' and attrs.get('aria-label') == 'Brödsmulor':
            self.in_crumbs = True
        elif tag == 'li' and self.in_crumbs:
            self.crumbs.append({'name': '', 'href': None})
        elif tag == 'a' and self.in_crumbs and self.crumbs:
            self.crumbs[-1]['href'] = attrs.get('href')
        elif tag == 'dl' and 'faq' in attrs.get('class', '').split():
            self.in_faq = True
        elif self.in_faq and tag == 'dt':
            self.faq.append({'q': '', 'a': ''})
            self.faq_field = 'q'
        elif self.in_faq and tag == 'dd':
            self.faq_field = 'a'

    def handle_data(self, data):
        if self.in_json:
            self.json_ld[-1] += data
        elif self.in_body:
            self.body += data + ' '
            if self.in_h1:
                self.h1 += data
            if self.in_crumbs and self.crumbs:
                self.crumbs[-1]['name'] += data
            if self.in_faq and self.faq_field:
                self.faq[-1][self.faq_field] += data

    def handle_endtag(self, tag):
        if tag == 'script':
            self.in_json = False
        elif tag == 'body':
            self.in_body = False
        elif tag == 'h1':
            self.in_h1 = False
        elif tag == 'nav' and self.in_crumbs:
            self.in_crumbs = False
        elif tag in ('dt', 'dd') and self.in_faq:
            self.faq_field = None
        elif tag == 'dl' and self.in_faq:
            self.in_faq = False

    def objects(self, kind):
        return [item for item in self.items if isinstance(item, dict) and item.get('@type') == kind]


class SchemaBuildTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(os.environ.get('SE_OUT_DIR', 'dist'))
        if not (cls.root / 'index.html').is_file():
            raise RuntimeError('Build the complete site before running test:schema')
        cls.home = Page(cls.root / 'index.html')
        cls.about = Page(cls.root / 'om' / 'index.html')
        cls.origin = cls.home.canonical.rstrip('/')

    def test_homepage_site_name_matches_visible_brand_and_canonical(self):
        sites = self.home.objects('WebSite')
        self.assertEqual(len(sites), 1)
        self.assertEqual(sites[0]['url'], self.home.canonical)
        self.assertEqual(sites[0]['name'], self.home.site_name)
        self.assertIn(sites[0]['name'], self.home.body)

    def test_provider_details_match_the_visible_about_page(self):
        providers = self.about.objects('Organization')
        self.assertEqual(len(providers), 1)
        provider = providers[0]
        self.assertEqual(provider['@id'], self.origin + '/om/#provider')
        for field in ('name', 'taxID', 'email', 'telephone'):
            self.assertIn(clean(provider[field]), clean(self.about.body))
        address = provider['address']
        self.assertEqual(address['@type'], 'PostalAddress')
        self.assertEqual(address['addressCountry'], 'FI')
        for field in ('streetAddress', 'postalCode', 'addressLocality'):
            self.assertIn(clean(address[field]), clean(self.about.body))

    def test_guides_identify_the_article_publisher_and_visible_date(self):
        provider = self.about.objects('Organization')[0]
        guides = list((self.root / 'guider').glob('*/index.html'))
        self.assertTrue(guides, 'no rendered guide articles found')
        for path in guides:
            with self.subTest(path=path):
                page = Page(path)
                articles = page.objects('Article')
                self.assertEqual(len(articles), 1)
                article = articles[0]
                self.assertEqual(article['headline'], clean(page.h1))
                self.assertEqual(article['@id'], page.canonical + '#article')
                self.assertEqual(article['mainEntityOfPage'], page.canonical)
                self.assertTrue(page.times, 'guide must expose its visible update date')
                if 'dateModified' in article:
                    self.assertRegex(article['dateModified'], r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$')
                    self.assertIn(article['dateModified'][:10], [value[:10] for value in page.times])
                self.assertEqual(article['publisher']['@id'], provider['@id'])
                self.assertEqual(article['publisher']['name'], provider['name'])
                self.assertEqual(article['publisher']['url'], provider['url'])

    def test_breadcrumbs_match_visible_navigation(self):
        count = 0
        for path in self.root.rglob('*.html'):
            page = Page(path)
            breadcrumbs = page.objects('BreadcrumbList')
            if not breadcrumbs:
                if page.crumbs and not ('/foretag/' in page.canonical and 'noindex' in page.robots):
                    self.fail(f'{path}: visible breadcrumbs have no structured data')
                continue
            with self.subTest(path=path):
                self.assertEqual(len(breadcrumbs), 1)
                items = breadcrumbs[0]['itemListElement']
                self.assertGreaterEqual(len(items), 2)
                self.assertEqual(len(items), len(page.crumbs))
                for index, (item, visible) in enumerate(zip(items, page.crumbs)):
                    self.assertEqual(item['@type'], 'ListItem')
                    self.assertEqual(item['position'], index + 1)
                    self.assertEqual(item['name'], clean(visible['name']))
                    if index < len(items) - 1:
                        self.assertTrue(visible['href'])
                        self.assertEqual(item['item'], urljoin(self.origin, visible['href']))
                count += 1
        self.assertGreater(count, 0, 'no breadcrumb markup found')

    def test_faq_markup_matches_visible_questions_and_answers(self):
        page = Page(self.root / 'fragor' / 'index.html')
        faq = page.objects('FAQPage')
        self.assertEqual(len(faq), 1)
        pairs = [(clean(item['name']), clean(item['acceptedAnswer']['text'])) for item in faq[0]['mainEntity']]
        self.assertEqual(pairs, [(clean(item['q']), clean(item['a'])) for item in page.faq])

    def test_company_markup_identifies_the_visible_company(self):
        count = 0
        for path in (self.root / 'foretag').rglob('index.html'):
            page = Page(path)
            companies = page.objects('Organization')
            if not companies:
                continue
            with self.subTest(path=path):
                self.assertEqual(len(companies), 1)
                company = companies[0]
                self.assertEqual(company['name'], clean(page.h1))
                self.assertEqual(company['@id'], page.canonical + '#company')
                self.assertEqual(company['mainEntityOfPage'], page.canonical)
                identifier = company['identifier']
                self.assertEqual(identifier['propertyID'], 'organisationsnummer')
                self.assertIn(identifier['value'], page.canonical)
                self.assertNotIn('url', company)
                count += 1
        if os.environ.get('SE_EXPECT_COMPANY_SCHEMA') == '1':
            self.assertGreater(count, 0, 'no company markup found in the test release')


if __name__ == '__main__':
    unittest.main()
