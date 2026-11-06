import importlib.util
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest


spec = importlib.util.spec_from_file_location('audit_seo', Path(__file__).with_name('audit-seo.py'))
audit_seo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit_seo)
ORIGIN = 'https://www.kreditrisker.se'
NS = 'http://www.sitemaps.org/schemas/sitemap/0.9'


class AuditSeoTest(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        self.write('index.html', self.page())
        self.write('robots.txt', 'User-agent: *\nDisallow: /\n')
        self.write('sitemap-index.xml', f'<sitemapindex xmlns="{NS}"><sitemap><loc>{ORIGIN}/sitemap-pages.xml</loc></sitemap></sitemapindex>')
        self.write('sitemap-pages.xml', f'<urlset xmlns="{NS}"/>')

    def write(self, path, text):
        file = self.root / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text, encoding='utf-8')

    def page(self, robots='noindex,follow', extra=''):
        return f'''<html lang="sv"><head><title>Test</title>
        <meta name="description" content="Description"><meta name="robots" content="{robots}">
        <link rel="canonical" href="{ORIGIN}/"><meta property="og:title" content="Test">
        <meta property="og:description" content="Description"><meta property="og:url" content="{ORIGIN}/">
        </head><body><h1>Test</h1>{extra}</body></html>'''

    def test_blocked_build_and_leaks(self):
        self.assertEqual(audit_seo.audit(self.root, ORIGIN, 'blocked')[0], [])
        self.write('index.html', self.page('index,follow'))
        self.assertTrue(any('indexable page' in error for error in audit_seo.audit(self.root, ORIGIN, 'blocked')[0]))

    def test_indexable_build_checks_sitemap_against_actual_html(self):
        self.write('robots.txt', f'User-agent: *\nDisallow: /sok/\nUser-agent: GPTBot\nDisallow: /\nSitemap: {ORIGIN}/sitemap-index.xml\n')
        self.write('index.html', self.page('index,follow'))
        self.write('sitemap-pages.xml', f'<urlset xmlns="{NS}"><url><loc>{ORIGIN}/</loc></url></urlset>')
        self.assertEqual(audit_seo.audit(self.root, ORIGIN, 'indexable')[0], [])
        self.write('index.html', self.page())
        self.assertTrue(any('noindex' in error for error in audit_seo.audit(self.root, ORIGIN, 'indexable')[0]))

    def test_bad_internal_links_and_json_ld_are_reported(self):
        self.write('index.html', self.page(extra='<a href="/missing/">Missing</a><script type="application/ld+json">{bad}</script>'))
        errors = audit_seo.audit(self.root, ORIGIN, 'blocked')[0]
        self.assertTrue(any('broken internal link /missing/' in error for error in errors))
        self.assertTrue(any('invalid JSON-LD' in error for error in errors))

    def test_analytics_frame_is_noindex_without_content_page_metadata(self):
        self.write('analytics-frame/index.html', '<html lang="sv"><head><title>Statistik</title><meta name="robots" content="noindex,nofollow"></head></html>')
        self.assertEqual(audit_seo.audit(self.root, ORIGIN, 'blocked')[0], [])
        self.write('analytics-frame/index.html', '<html lang="sv"><head><title>Statistik</title><meta name="robots" content="index,follow"></head></html>')
        self.assertTrue(any('analytics frame must be noindex' in error for error in audit_seo.audit(self.root, ORIGIN, 'indexable')[0]))


if __name__ == '__main__':
    unittest.main()
