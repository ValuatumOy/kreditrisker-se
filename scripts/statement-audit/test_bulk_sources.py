import hashlib
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import urllib.parse

from bulk_sources import BulkFilings, SourceError
import official
from test_filing import archive, document, numeric
from test_official import BulkServer, ORGNR, PERIOD, NAME, outer_zip


NEWER_PERIOD = "2027-06-30"
OTHER = "5560000000"


def payload(periods=(PERIOD,), orgnr=ORGNR, value="100"):
    contexts, facts = [], []
    for index, end in enumerate(periods):
        contexts.append(f'<xbrli:context id="p{index}"><xbrli:entity><xbrli:identifier scheme="test">{orgnr}</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:startDate>{int(end[:4]) - 1}-07-01</xbrli:startDate><xbrli:endDate>{end}</xbrli:endDate></xbrli:period></xbrli:context>')
        facts.append(numeric(value, contextRef=f"p{index}"))
    return archive([("annual.xhtml", document("".join(facts), contexts="".join(contexts)))])


def leap_document(*, end="2024-02-29", start="2023-03-01", orgnr=ORGNR):
    def context(identifier, period):
        return (f'<xbrli:context id="{identifier}"><xbrli:entity><xbrli:identifier scheme="test">{orgnr}</xbrli:identifier>'
                f'</xbrli:entity><xbrli:period>{period}</xbrli:period></xbrli:context>')
    contexts = context("current", f"<xbrli:startDate>{start}</xbrli:startDate><xbrli:endDate>{end}</xbrli:endDate>")
    contexts += context("balance", f"<xbrli:instant>{end}</xbrli:instant>")
    body = "".join(f'<ix:nonNumeric name="se-cd-base:{name}" contextRef="current">{text}</ix:nonNumeric>'
                   for name, text in (("Organisationsnummer", orgnr), ("RakenskapsarForstaDag", start), ("RakenskapsarSistaDag", end)))
    body += numeric("100", contextRef="current") + numeric("200", contextRef="balance", name="se-gen-base:Tillgangar")
    for year in (2018, 2019, 2021):
        contexts += context(f"prior{year}", f"<xbrli:startDate>{year - 1}-03-01</xbrli:startDate><xbrli:endDate>{year}-02-28</xbrli:endDate>")
        body += numeric(str(year), contextRef=f"prior{year}")
    return document(body, contexts=contexts, extra='xmlns:se-cd-base="http://www.taxonomier.se/se/fr/cd-base/2021-10-31"')


class BulkTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.cache = Path(self.temporary.name)
        self.key = "arsredovisningar/2026/40_1.zip"
        self.data = payload()
        self.server = BulkServer({self.key: outer_zip([(NAME, self.data)])})
        self.patcher = patch("official.urllib.request.urlopen", side_effect=self.server)
        self.patcher.start()
        self.reader = BulkFilings(self.cache, [ORGNR])

    def tearDown(self):
        self.patcher.stop()
        self.temporary.cleanup()

    def assert_code(self, code, call):
        with self.assertRaises(SourceError) as caught:
            call()
        self.assertEqual(caught.exception.code, code)

    def test_one_complete_scan_serves_multiple_periods_and_ignores_other_company(self):
        newer = "arsredovisningar/2027/40_1.zip"
        new_name = f"{ORGNR}_{NEWER_PERIOD}.zip"
        self.server.archives[newer] = outer_zip([(new_name, payload((NEWER_PERIOD, PERIOD))),
                                               (f"{OTHER}_{PERIOD}.zip", payload(orgnr=OTHER))])
        with patch.object(self.reader, "_index", wraps=self.reader._index) as index:
            manifest = self.reader.prepare()
            self.reader.fetch(ORGNR, PERIOD)
            self.reader.fetch(ORGNR, NEWER_PERIOD)
            self.reader.fetch_comparative(ORGNR, PERIOD)
            self.reader.prepare()
        self.assertEqual(index.call_count, 2)
        self.assertEqual(manifest["targetCount"], 2)
        self.assertTrue(manifest["scanComplete"])
        self.assertEqual(sum(bool(urllib.parse.urlsplit(r.full_url).query) for r in self.server.requests), 1)

    def test_newest_archive_selected_despite_completion_order_and_older_duplicates(self):
        newest = "arsredovisningar/2026/41_1.zip"
        correction = payload(value="200")
        self.server.archives[newest] = outer_zip([(NAME, correction)])
        with patch("warnings.warn"):
            self.server.archives[self.key] = outer_zip([(NAME, self.data), (NAME, self.data)])
        completed = threading.Event()
        original = self.reader._index
        def index(archive):
            if archive["key"] == newest:
                self.assertTrue(completed.wait(2))
            result = original(archive)
            if archive["key"] == self.key:
                completed.set()
            return result
        with patch.object(self.reader, "_index", side_effect=index):
            self.reader.prepare()
        result = self.reader.fetch(ORGNR, PERIOD)
        self.assertEqual(result["data"], correction)
        self.assertTrue(result["url"].endswith(newest))

    def test_duplicate_newest_target_is_ambiguous(self):
        with patch("warnings.warn"):
            self.server.archives[self.key] = outer_zip([(NAME, self.data), (NAME, self.data)])
        self.reader.prepare()
        self.assert_code("ambiguous", lambda: self.reader.fetch(ORGNR, PERIOD))

    def test_failed_newer_index_never_becomes_not_found_or_older_match(self):
        newest = "arsredovisningar/2026/41_1.zip"
        self.server.archives[newest] = outer_zip([])
        original = self.reader._index
        def index(archive):
            if archive["key"] == newest:
                raise ValueError("broken index")
            return original(archive)
        with patch.object(self.reader, "_index", side_effect=index):
            manifest = self.reader.prepare()
        self.assertFalse(manifest["scanComplete"])
        self.assertEqual(manifest["scanErrorCount"], 1)
        self.assert_code("index_incomplete", lambda: self.reader.fetch(ORGNR, PERIOD))
        self.assert_code("index_incomplete", lambda: self.reader.fetch(ORGNR, "2025-06-30"))
        self.assert_code("index_incomplete", lambda: self.reader.fetch_comparative(ORGNR, "2025-06-30"))
        self.assertFalse((self.cache / NAME).exists())
        records = list(manifest["archives"].values())
        self.assertEqual(next(r["error"] for r in records if r["status"] == "error"), "broken index")

    def test_failed_older_index_does_not_hide_verified_newer_exact_match(self):
        old = "arsredovisningar/2025/40_1.zip"
        self.server.archives[old] = outer_zip([])
        original = self.reader._index
        def index(archive):
            if archive["key"] == old:
                raise ValueError("broken old index")
            return original(archive)
        with patch.object(self.reader, "_index", side_effect=index):
            self.reader.prepare()
        self.assertEqual(self.reader.fetch(ORGNR, PERIOD)["data"], self.data)

    def test_missing_exact_period_records_listing_provenance(self):
        manifest = self.reader.prepare()
        self.assert_code("not_found", lambda: self.reader.fetch(ORGNR, "2025-06-30"))
        event = json.loads(self.reader.request_log.read_text().splitlines()[-1])
        self.assertEqual(event["status"], "not_found")
        self.assertEqual(event["periodEnd"], "2025-06-30")
        self.assertEqual(event["listingFingerprint"], manifest["listingFingerprint"])

    def test_cached_bytes_hash_revalidated_even_with_parsed_cache(self):
        self.reader.prepare()
        first = self.reader.fetch(ORGNR, PERIOD)
        self.assertFalse(first["fromCache"])
        self.assertEqual(first["sha256"], hashlib.sha256(self.data).hexdigest())
        self.assertTrue(self.reader.fetch(ORGNR, PERIOD)["fromCache"])
        (self.cache / NAME).write_bytes(b"corrupt")
        with patch.object(self.reader, "_download", wraps=self.reader._download) as download:
            result = self.reader.fetch(ORGNR, PERIOD)
        self.assertEqual(download.call_count, 1)
        self.assertEqual(result["data"], self.data)
        self.assertFalse(result["fromCache"])

    def test_resume_reuses_only_matching_fresh_identities(self):
        self.reader.prepare()
        self.reader.fetch(ORGNR, PERIOD)
        resumed = BulkFilings(self.cache, [ORGNR])
        with patch.object(resumed, "_index", wraps=resumed._index) as index:
            resumed.prepare()
        self.assertEqual(index.call_count, 0)
        correction = payload(value="123456789")
        self.server.archives[self.key] = outer_zip([(NAME, correction)])
        changed = BulkFilings(self.cache, [ORGNR])
        with patch.object(changed, "_index", wraps=changed._index) as index:
            changed.prepare()
        self.assertEqual(index.call_count, 1)
        result = changed.fetch(ORGNR, PERIOD)
        self.assertFalse(result["fromCache"])
        self.assertEqual(result["data"], correction)

    def test_failed_indexes_are_retried_when_resuming(self):
        with patch.object(self.reader, "_index", side_effect=ValueError("temporary failure")):
            self.reader.prepare()
        resumed = BulkFilings(self.cache, [ORGNR])
        with patch.object(resumed, "_index", wraps=resumed._index) as index:
            resumed.prepare()
        self.assertEqual(index.call_count, 1)
        self.assertTrue(resumed.manifest["scanComplete"])

    def test_fresh_listing_detects_correction_despite_unexpired_listing_cache(self):
        official.OfficialFilings(self.cache)._listing()
        newest = "arsredovisningar/2026/41_1.zip"
        correction = payload(value="999")
        self.server.archives[newest] = outer_zip([(NAME, correction)])
        self.reader.prepare()
        self.assertEqual(self.reader.fetch(ORGNR, PERIOD)["data"], correction)

    def test_comparative_returns_newer_source_with_exact_target_facts(self):
        newest = "arsredovisningar/2028/40_1.zip"
        middle = "arsredovisningar/2027/40_1.zip"
        self.server.archives[newest] = outer_zip([(f"{ORGNR}_2028-06-30.zip", payload(("2028-06-30", "2027-06-30")))])
        self.server.archives[middle] = outer_zip([(f"{ORGNR}_{NEWER_PERIOD}.zip", payload((NEWER_PERIOD, PERIOD)))])
        self.reader.prepare()
        result = self.reader.fetch_comparative(ORGNR, PERIOD)
        self.assertEqual(result["sourceKind"], "comparative")
        self.assertEqual(result["sourcePeriodEnd"], NEWER_PERIOD)
        self.assertEqual(result["requestedPeriodEnd"], PERIOD)
        self.assertEqual(result["name"], f"{ORGNR}_{NEWER_PERIOD}.zip")
        self.assertEqual({f["end"] for f in result["filing"]["facts"]}, {NEWER_PERIOD, PERIOD})

    def test_comparative_never_relabels_same_filing_or_wrong_period(self):
        self.server.archives["arsredovisningar/2027/40_1.zip"] = outer_zip([
            (f"{ORGNR}_{NEWER_PERIOD}.zip", payload((NEWER_PERIOD, "2025-06-30")))])
        self.reader.prepare()
        self.assert_code("not_found", lambda: self.reader.fetch_comparative(ORGNR, PERIOD))
        self.assert_code("not_found", lambda: self.reader.fetch_comparative(ORGNR, NEWER_PERIOD))
        self.assertEqual(self.reader.fetch(ORGNR, PERIOD)["sourceKind"], "original")

    def test_comparative_company_mismatch_remains_error_not_absence(self):
        self.server.archives["arsredovisningar/2027/40_1.zip"] = outer_zip([
            (f"{ORGNR}_{NEWER_PERIOD}.zip", payload((NEWER_PERIOD, PERIOD), orgnr=OTHER))])
        self.reader.prepare()
        self.assert_code("identity_mismatch", lambda: self.reader.fetch_comparative(ORGNR, PERIOD))

    def test_group_or_ambiguous_unsegmented_context_cannot_prove_company_period(self):
        fact = {"entity": ORGNR, "documentIndex": 0, "value": 100, "start": "2025-07-01", "end": PERIOD,
                "dimensions": {}, "reportingScope": "group"}
        self.assertFalse(self.reader._has_period([fact], ORGNR, PERIOD))
        unsegmented = {**fact, "reportingScope": "unsegmented"}
        self.assertFalse(self.reader._has_period([fact, unsegmented], ORGNR, PERIOD))
        company = {**fact, "reportingScope": "company"}
        self.assertTrue(self.reader._has_period([fact, company], ORGNR, PERIOD))

    def test_filename_does_not_override_company_or_period_identity(self):
        self.server.archives[self.key] = outer_zip([(NAME, payload(orgnr=OTHER))])
        self.reader.prepare()
        self.assert_code("identity_mismatch", lambda: self.reader.fetch(ORGNR, PERIOD))
        other = BulkFilings(self.cache / "other", [ORGNR])
        self.server.archives[self.key] = outer_zip([(NAME, payload(("2025-06-30",)))])
        other.prepare()
        self.assert_code("period_mismatch", lambda: other.fetch(ORGNR, PERIOD))

    def prepare_leap(self, content=None, *, filename_end="2024-02-28"):
        name = f"{ORGNR}_{filename_end}.zip"
        data = archive([("annual.xhtml", content if content is not None else leap_document())])
        self.server.archives = {self.key: outer_zip([(name, data)])}
        self.reader.prepare()
        return name, data

    def test_leap_filename_discrepancy_is_explicit_and_preserves_source_bytes(self):
        name, data = self.prepare_leap()
        result = self.reader.fetch(ORGNR, "2024-02-29")
        self.assertEqual(result["name"], name)
        self.assertEqual(result["data"], data)
        self.assertEqual(result["sha256"], hashlib.sha256(data).hexdigest())
        self.assertEqual(result["sourcePeriodEnd"], "2024-02-29")
        self.assertEqual(result["filenamePeriodEnd"], "2024-02-28")
        self.assertEqual(result["sourceDeclaredPeriodEnd"], "2024-02-29")
        warning = result["sourceDateWarning"]
        self.assertEqual(warning["code"], "filename_leap_day_discrepancy")
        self.assertEqual(warning["sourceDeclaredPeriodStart"], "2023-03-01")
        self.assertEqual(warning["verifiedContextCount"], 5)
        self.assertEqual(warning["documentSha256"], result["filing"]["documents"][0]["sha256"])
        self.assertFalse((self.cache / f"{ORGNR}_2024-02-29.zip").exists())
        meta = json.loads((self.cache / (name + ".json")).read_text())
        self.assertNotIn("sourceDateWarning", meta)
        event = json.loads(self.reader.request_log.read_text().splitlines()[-1])
        self.assertEqual(event["sourceDateWarning"], warning)
        self.assert_code("period_mismatch", lambda: self.reader.fetch(ORGNR, "2024-02-28"))

    def test_leap_file_can_supply_only_exact_older_comparative_periods(self):
        self.prepare_leap()
        for year in (2018, 2019, 2021):
            result = self.reader.fetch_comparative(ORGNR, f"{year}-02-28")
            self.assertEqual(result["sourcePeriodEnd"], "2024-02-29")
            self.assertEqual(result["requestedPeriodEnd"], f"{year}-02-28")
            self.assertEqual(result["sourceKind"], "comparative")
            self.assertIn("sourceDateWarning", result)
        self.assert_code("not_found", lambda: self.reader.fetch_comparative(ORGNR, "2020-02-28"))
        self.assert_code("not_found", lambda: self.reader.fetch_comparative(ORGNR, "2024-02-29"))

    def test_leap_validation_preserves_utf16_and_utf32_source_encoding_evidence(self):
        for encoding in ("utf-16", "utf-32"):
            with self.subTest(encoding=encoding):
                html = leap_document().decode("utf-8").replace('encoding="UTF-8"', f'encoding="{encoding.upper()}"')
                content = html.encode(encoding)
                self.reader = BulkFilings(self.cache / encoding, [ORGNR])
                name, data = self.prepare_leap(content)
                result = self.reader.fetch(ORGNR, "2024-02-29")
                self.assertEqual(result["name"], name)
                self.assertEqual(result["data"], data)
                self.assertEqual(result["sha256"], hashlib.sha256(data).hexdigest())
                self.assertEqual(result["filing"]["documents"][0]["html"], html)
                self.assertEqual(result["sourceDateWarning"]["documentSha256"], hashlib.sha256(content).hexdigest())
                self.assertEqual(result["sourcePeriodEnd"], "2024-02-29")

    def test_exact_29_filename_is_preferred_and_invalid_exact_file_never_falls_back(self):
        adjacent, _ = self.prepare_leap()
        exact = f"{ORGNR}_2024-02-29.zip"
        self.reader._targets[exact] = {**self.reader._targets[adjacent], "entries": [{"name": exact}]}
        with patch.object(self.reader, "_load", side_effect=SourceError("period_mismatch", "invalid exact source")) as load:
            self.assert_code("period_mismatch", lambda: self.reader.fetch(ORGNR, "2024-02-29"))
        self.assertEqual(load.call_args_list[0].args, (ORGNR, exact))
        self.assertEqual(load.call_count, 1)

    def test_adjacent_filename_requires_verified_absence_of_exact_name(self):
        adjacent, _ = self.prepare_leap()
        self.reader.scan_errors = [{"rank": 99, "archive": {"key": "arsredovisningar/2025/1_1.zip"}}]
        with patch.object(self.reader, "_load", wraps=self.reader._load) as load:
            self.assert_code("index_incomplete", lambda: self.reader.fetch(ORGNR, "2024-02-29"))
        self.assertEqual(load.call_count, 0)

    def test_leap_exception_rejects_ambiguous_invalid_or_noncompany_evidence(self):
        source = leap_document().decode("utf-8")
        cases = {
            "missingHeader": source.replace('se-cd-base:RakenskapsarSistaDag', 'se-cd-base:UnknownDate'),
            "duplicateHeader": source.replace('</body>', '<ix:nonNumeric name="se-cd-base:RakenskapsarSistaDag" contextRef="current">2024-02-29</ix:nonNumeric></body>'),
            "wrongHeaderEntity": source.replace('>5561939215</ix:nonNumeric>', '>5560000000</ix:nonNumeric>'),
            "wrongHeaderContext": source.replace('name="se-cd-base:RakenskapsarSistaDag" contextRef="current"', 'name="se-cd-base:RakenskapsarSistaDag" contextRef="prior2021"'),
            "wrongStartHeader": source.replace('>2023-03-01</ix:nonNumeric>', '>2023-03-02</ix:nonNumeric>'),
            "wrongContextStart": source.replace('<xbrli:startDate>2023-03-01</xbrli:startDate>', '<xbrli:startDate>2023-03-02</xbrli:startDate>'),
            "wrongInstant": source.replace('<xbrli:instant>2024-02-29</xbrli:instant>', '<xbrli:instant>2024-02-28</xbrli:instant>'),
            "headerParseError": source.replace('name="se-cd-base:RakenskapsarSistaDag" contextRef="current"', 'name="se-cd-base:RakenskapsarSistaDag" contextRef="missing"'),
            "monetaryParseError": source.replace('>100</ix:nonFraction>', '>bad</ix:nonFraction>'),
            "noInstantFact": source.replace('contextRef="balance"', 'contextRef="current"'),
            "group": source.replace('</xbrli:identifier>', '</xbrli:identifier><xbrli:segment><se-gen-base:RedovisningInformationKoncernSegment/></xbrli:segment>'),
            "dimensions": source.replace('</xbrli:identifier>', '</xbrli:identifier><xbrli:segment><xbrldi:explicitMember dimension="test:scope">test:company</xbrldi:explicitMember></xbrli:segment>'),
            "unknownScope": source.replace('</xbrli:identifier>', '</xbrli:identifier><xbrli:segment><test:unknown/></xbrli:segment>'),
        }
        cases["mixedScope"] = source.replace('<xbrli:identifier scheme="test">'+ORGNR+'</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:instant>', '<xbrli:identifier scheme="test">'+ORGNR+'</xbrli:identifier><xbrli:segment><se-gen-base:RedovisningInformationJuridiskPersonSegment/></xbrli:segment></xbrli:entity><xbrli:period><xbrli:instant>')
        unused = '<xbrli:context id="unused"><xbrli:entity><xbrli:identifier scheme="test">OTHER</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:instant>2021-02-28</xbrli:instant></xbrli:period></xbrli:context>'
        cases["unusedWrongCompany"] = source.replace('</ix:resources>', unused.replace('OTHER', OTHER) + '</ix:resources>')
        duplicate = unused.replace('OTHER', ORGNR)
        cases["duplicateUnusedContext"] = source.replace('</ix:resources>', duplicate + duplicate + '</ix:resources>')
        cases["unknownHeaderNamespace"] = source.replace('http://www.taxonomier.se/se/fr/cd-base/2021-10-31', 'https://unknown.invalid/cd-base/2021-10-31')
        for label, content in cases.items():
            with self.subTest(label=label):
                self.reader = BulkFilings(self.cache / label, [ORGNR])
                self.prepare_leap(content.encode("utf-8"))
                self.assert_code("identity_mismatch" if label == "unknownScope" else "period_mismatch",
                                 lambda: self.reader.fetch(ORGNR, "2024-02-29"))

    def test_nonleap_other_day_or_actual_february28_are_never_normalized(self):
        for label, filename_end, content, expected in (
                ("nonleap", "2023-02-28", leap_document(), "period_mismatch"),
                ("otherDay", "2024-02-27", leap_document(), "period_mismatch"),
                ("actual28", "2020-02-28", leap_document(end="2020-02-28", start="2019-03-01"), None)):
            with self.subTest(label=label):
                self.reader = BulkFilings(self.cache / label, [ORGNR])
                self.prepare_leap(content, filename_end=filename_end)
                if expected:
                    self.assert_code(expected, lambda: self.reader.fetch(ORGNR, filename_end))
                else:
                    result = self.reader.fetch(ORGNR, filename_end)
                    self.assertEqual(result["sourcePeriodEnd"], "2020-02-28")
                    self.assertNotIn("sourceDateWarning", result)
                    self.assert_code("not_found", lambda: self.reader.fetch(ORGNR, "2020-02-29"))

    def test_valid_adjacent_28_does_not_block_exact_newer_29_comparative(self):
        adjacent = f"{ORGNR}_2024-02-28.zip"
        later = f"{ORGNR}_2025-02-28.zip"
        actual28 = archive([("annual.xhtml", leap_document(end="2024-02-28"))])
        self.server.archives = {self.key: outer_zip([(adjacent, actual28),
                                                   (later, payload(("2025-02-28", "2024-02-29")))])}
        self.reader.prepare()
        self.assertEqual(self.reader.fetch(ORGNR, "2024-02-28")["sourcePeriodEnd"], "2024-02-28")
        self.assert_code("not_found", lambda: self.reader.fetch(ORGNR, "2024-02-29"))
        result = self.reader.fetch_comparative(ORGNR, "2024-02-29")
        self.assertEqual(result["sourceKind"], "comparative")
        self.assertEqual(result["name"], later)
        self.assertEqual(result["sourcePeriodEnd"], "2025-02-28")
        self.assertEqual(result["requestedPeriodEnd"], "2024-02-29")

    def test_leap_cached_hash_is_revalidated_and_wrong_entity_cannot_pass(self):
        name, data = self.prepare_leap()
        self.reader.fetch(ORGNR, "2024-02-29")
        (self.cache / name).write_bytes(b"tampered")
        with patch.object(self.reader, "_download", wraps=self.reader._download) as download:
            result = self.reader.fetch(ORGNR, "2024-02-29")
        self.assertEqual(download.call_count, 1)
        self.assertEqual(result["data"], data)
        self.reader = BulkFilings(self.cache / "wrong", [ORGNR])
        self.prepare_leap(leap_document(orgnr=OTHER))
        self.assert_code("identity_mismatch", lambda: self.reader.fetch(ORGNR, "2024-02-29"))

    def test_archive_year_filter_matches_existing_provider(self):
        self.server.archives = {"arsredovisningar/2025/40_1.zip": outer_zip([(NAME, self.data)])}
        self.reader.prepare()
        self.assert_code("not_found", lambda: self.reader.fetch(ORGNR, PERIOD))

    def test_errors_in_ineligible_old_year_do_not_hide_confirmed_absence(self):
        self.server.archives = {"arsredovisningar/2025/40_1.zip": outer_zip([])}
        with patch.object(self.reader, "_index", side_effect=ValueError("old failure")):
            self.reader.prepare()
        self.assert_code("not_found", lambda: self.reader.fetch(ORGNR, PERIOD))
        self.assert_code("not_found", lambda: self.reader.fetch_comparative(ORGNR, PERIOD))

    def test_parsed_cache_has_two_files_and_resets_for_next_company(self):
        self.reader = BulkFilings(self.cache, [ORGNR, OTHER])
        ends = ("2024-06-30", "2025-06-30", PERIOD)
        self.server.archives[self.key] = outer_zip([(f"{ORGNR}_{end}.zip", payload((end,))) for end in ends]
                                                    + [(f"{OTHER}_{PERIOD}.zip", payload(orgnr=OTHER))])
        self.reader.prepare()
        for end in ends:
            self.reader.fetch(ORGNR, end)
        self.assertEqual(len(self.reader._parsed.files), 2)
        self.reader.fetch(OTHER, PERIOD)
        self.assertEqual(self.reader._parsed.orgnr, OTHER)
        self.assertEqual(len(self.reader._parsed.files), 1)

    def test_parallel_company_fetches_keep_parsed_caches_isolated(self):
        self.reader = BulkFilings(self.cache, [ORGNR, OTHER])
        self.server.archives[self.key] = outer_zip([(NAME, self.data),
                                                   (f"{OTHER}_{PERIOD}.zip", payload(orgnr=OTHER))])
        self.reader.prepare()
        barrier = threading.Barrier(2)
        def fetch(orgnr):
            result = self.reader.fetch(orgnr, PERIOD)
            barrier.wait(timeout=2)
            return result["filing"]["facts"][0]["entity"], self.reader._parsed.orgnr
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(fetch, orgnr) for orgnr in (ORGNR, OTHER)]
            results = [future.result() for future in futures]
        self.assertEqual(results, [(ORGNR, ORGNR), (OTHER, OTHER)])
        events = [json.loads(line) for line in self.reader.request_log.read_text().splitlines()]
        self.assertEqual({event["orgnr"] for event in events}, {ORGNR, OTHER})

    def test_progress_cancellation_joins_workers_and_does_not_mark_scan_complete(self):
        started = threading.Event()
        completed = []
        def slow_index(archive):
            started.set()
            time.sleep(0.03)
            completed.append(archive["key"])
            return []
        def progress(message):
            if message.startswith("Luetaan"):
                self.assertTrue(started.wait(2))
                raise ValueError("cancelled")
        with patch.object(self.reader, "_index", side_effect=slow_index), self.assertRaisesRegex(ValueError, "cancelled"):
            self.reader.prepare(progress)
        self.assertEqual(completed, [self.key])
        self.assertFalse(self.reader._prepared)
        self.assertFalse(json.loads(self.reader.manifest_path.read_text())["scanComplete"])

    def test_scan_concurrency_and_progress_are_bounded(self):
        self.server.archives = {f"arsredovisningar/2026/{week}_1.zip": outer_zip([]) for week in range(1, 10)}
        lock = threading.Lock()
        active = maximum = 0
        def index(archive):
            nonlocal active, maximum
            with lock:
                active += 1
                maximum = max(maximum, active)
            time.sleep(0.01)
            with lock:
                active -= 1
            return []
        main_thread = threading.get_ident()
        threads = []
        with patch.object(self.reader, "_index", side_effect=index) as indexed:
            self.reader.prepare(lambda _: threads.append(threading.get_ident()))
        self.assertEqual(indexed.call_count, 9)
        self.assertEqual(maximum, 4)
        self.assertEqual(active, 0)
        self.assertEqual(set(threads), {main_thread})

    def test_unselected_company_and_unprepared_fetch_do_not_access_network(self):
        for call in (lambda: self.reader.fetch(ORGNR, PERIOD), lambda: self.reader.fetch(OTHER, PERIOD),
                     lambda: self.reader.fetch(ORGNR, "20260630")):
            with self.assertRaises(ValueError):
                call()
        self.assertEqual(self.server.requests, [])


if __name__ == "__main__":
    unittest.main()
