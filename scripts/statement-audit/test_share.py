import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import share


class ShareTest(unittest.TestCase):
    def test_viewer_removes_active_tags_events_remote_resources_preserves_fact_ids(self):
        source = '''<html><head><meta http-equiv="refresh" content="0;url=https://evil.example">
        <script>alert('unsafe')</script><style>@import 'https://evil.example/css'; p{color:green;background:url(https://evil.example/img)}</style></head>
        <body onload="unsafe()"><iframe src="https://evil.example">iframe contents</iframe>
        <svg><script>svg unsafe</script></svg><form action="https://evil.example"><input></form>
        <ix:nonFraction id="fact-7" onclick="unsafe()" style="color:red;background:url(https://evil.example)">12 &amp; 34</ix:nonFraction>
        <a href="javascript:unsafe()">unsafe link</a><a href="#fact-7">safe anchor</a><img src="https://evil.example/tracker"></body></html>'''
        html = share.safe_viewer(source)
        for forbidden in ("<script", "<iframe", "<svg", "<form", "onload=", "onclick=", "javascript:", "evil.example", "http-equiv=\"refresh\""):
            self.assertNotIn(forbidden, html)
        self.assertIn('id="fact-7"', html)
        self.assertIn('href="#fact-7"', html)
        self.assertIn("12 &amp; 34", html)
        self.assertIn("Content-Security-Policy", html)
        self.assertIn("default-src &#x27;none&#x27;", html)

    def test_unsafe_external_urls_are_not_links(self):
        for url in ("javascript:alert(1)", "data:text/html,unsafe", "file:///tmp/secret", "https://user:password@example.com", "https://[broken", "https://example.com\n"):
            self.assertNotIn("<a", share.external_link(url, "Source"))
        self.assertIn('rel="noopener noreferrer"', share.external_link("https://example.com/?x=1&y=2", "Source"))
        self.assertIn("&amp;", share.external_link("https://example.com/?x=1&y=2", "Source"))

    def test_case_escapes_labels_notes_and_precise_anchor(self):
        report = {"company": {"name": '<img src=x onerror="unsafe()">'}, "periodEnd": "2026-06-30",
                  "rows": [{"label": "<script>unsafe</script>", "official": {"value": 123456789, "unit": "SEK",
                      "selectedFact": {"documentIndex": 0, "elementId": 'fact\"7'}},
                      "backend": {"value": 123456789}, "website": {"value": 123457000},
                      "sourceBackendStatus": "match", "backendWebsiteStatus": "manual", "status": "manual", "note": "<iframe>"}],
                  "provenance": {"websiteUrl": "javascript:alert(1)"}}
        html = share.make_case(report, [{"path": "doc.html", "title": "Annual"}])
        self.assertNotIn("<script>", html)
        self.assertNotIn("<img src=x", html)
        self.assertNotIn("javascript:", html)
        self.assertIn("&lt;iframe&gt;", html)
        self.assertIn('href="doc.html#fact%227"', html)
        self.assertIn("123 456 789", html)
        self.assertIn("Tarkista käsin", html)

    def make_run(self, root, expected_sha=None):
        run, cache = root / "run", root / "official"
        run.mkdir(); cache.mkdir()
        raw = b"original ZIP bytes"
        filename = "5561939215_2026-06-30.zip"
        (cache / filename).write_bytes(raw)
        report = {"company": {"name": "Test AB", "orgnr": "5561939215"}, "periodEnd": "2026-06-30",
                  "rows": [{"label": "Nettoomsättning", "official": {"value": 5, "selectedFact": {"documentIndex": 0, "elementId": "fact-1"}},
                            "backend": {"value": 5}, "website": {"value": 5}, "status": "manual", "sourceBackendStatus": "match", "backendWebsiteStatus": "manual"}],
                  "provenance": {"filingName": filename, "filingSha256": expected_sha or hashlib.sha256(raw).hexdigest(),
                                 "documents": [{"sha256": "document-sha"}]}}
        (run / "report.json").write_text(json.dumps(report), encoding="utf-8")
        (run / "summary.json").write_text(json.dumps({"checkedAt": "2026-10-14", "cases": [{"company": report["company"],
            "periodEnd": "2026-06-30", "report": "report.json", "status": "manual",
            "sourceBackend": {"match": 1}, "backendWebsite": {"manual": 1}}]}), encoding="utf-8")
        return run, cache

    def source(self):
        return {"documents": [{"name": "annual.xhtml", "title": "Tilinpäätös", "sha256": "document-sha",
            "html": '<html><head></head><body><span id="fact-1">5</span><script>unsafe</script></body></html>'}]}

    def test_pack_is_offline_contains_only_curated_html_and_not_stale_or_api_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            run, cache = self.make_run(Path(temporary))
            output = run / "share"
            output.mkdir()
            (output / "stale.env").write_text("SECRET_VALUATUM_API_TOKEN=token")
            with patch.object(share, "read_filing", return_value=self.source()):
                path = share.build_pack(run, cache)
            with zipfile.ZipFile(path) as archive:
                self.assertEqual(set(archive.namelist()), {"index.html", "case-1.html", "case-1-document-1.html", "LUEMINUT.txt"})
                joined = b"\n".join(archive.read(name) for name in archive.namelist()).decode("utf-8")
                self.assertNotIn("SECRET_VALUATUM_API_TOKEN", joined)
                self.assertNotIn("<script>", joined)
                self.assertIn('href="case-1-document-1.html#fact-1"', joined)
                self.assertIn("Tallennettu", joined)

    def test_changed_source_is_not_packed_or_linked_as_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            run, cache = self.make_run(Path(temporary), expected_sha="different-sha")
            with patch.object(share, "read_filing") as parse:
                path = share.build_pack(run, cache)
                parse.assert_not_called()
            with zipfile.ZipFile(path) as archive:
                self.assertNotIn("case-1-document-1.html", archive.namelist())
                html = archive.read("case-1.html").decode("utf-8")
                self.assertNotIn("Näytä lähdeluku", html)
                self.assertIn("tarkistussumma", html)


if __name__ == "__main__":
    unittest.main()
