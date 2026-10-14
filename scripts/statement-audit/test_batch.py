import copy
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

import batch


COMPANY = {"name": "Åkeri & Söner AB", "orgnr": "5561939215", "fid": "52"}


def bundle():
    return {"fid": "52", "retrievedAt": "2026-10-14", "modeldata": {
        "companyCode": "556193-9215", "companyId": 60, "followedModelId": 52,
        "dataMap": {"2025": {"cr_fiscal_year_end": 20260630.0},
                    "2024": {"cr_fiscal_year_end": 20250630}, "2026": {"ns": 12},
                    "2023": {"cr_fiscal_year_end": 20230230}, "2022": {"cr_fiscal_year_end": "2022-12-31"}}},
        "companies": [{"companyCode": "5561939215", "companyId": 60,
            "models": [{"followedModelId": 52, "analystName": "Data Import"}]}]}


def comparison():
    return {"rows": [{"status": "manual", "sourceBackendStatus": "match", "backendWebsiteStatus": "manual"},
                     {"status": "match", "sourceBackendStatus": "match", "backendWebsiteStatus": "match"}],
            "warnings": []}


class BatchSelectionTest(unittest.TestCase):
    def test_exact_periods_not_calendar_keys(self):
        self.assertEqual(batch.select_periods(bundle()), ["2026-06-30", "2025-06-30"])
        with self.assertRaises(ValueError):
            batch.select_periods(bundle(), requested=["2026-12-31"])

    def test_explicit_periods_preserve_selection_and_deduplicate(self):
        self.assertEqual(batch.select_periods(bundle(), requested=["2022-12-31", "2022-12-31"]), ["2022-12-31"])
        for invalid in ("20250630", "2025-6-30", "2025"):
            with self.assertRaises(ValueError):
                batch.select_periods(bundle(), requested=[invalid])

    def test_no_explicit_period_never_falls_back(self):
        obj = bundle()
        obj["modeldata"]["dataMap"] = {"2026": {"ns": 10}}
        with self.assertRaises(ValueError):
            batch.select_periods(obj)

    def test_company_search_must_be_unique(self):
        self.assertEqual(batch.select_company([COMPANY], "556193-9215"), COMPANY)
        with self.assertRaises(ValueError):
            batch.select_company([COMPANY, COMPANY], COMPANY["orgnr"])
        with self.assertRaises(ValueError):
            batch.select_company([COMPANY], "5561939216")

    def test_matching_fid_and_entity_are_required(self):
        batch.verify_bundle(bundle(), COMPANY)
        for section, key, value in ((None, "fid", "99"), ("modeldata", "followedModelId", 99),
                                    ("modeldata", "companyCode", "5561939216"),
                                    ("modeldata", "companyCode", "5561939215K")):
            obj = bundle()
            (obj if section is None else obj[section])[key] = value
            with self.assertRaises(ValueError):
                batch.verify_bundle(obj, COMPANY)

    def test_one_import_company_model_required(self):
        for mutate in (lambda b: b["companies"].append(copy.deepcopy(b["companies"][0])),
                       lambda b: b["companies"][0]["models"].append({"followedModelId": 88, "analystName": "Data Import"}),
                       lambda b: b["companies"][0].update(companyId=99),
                       lambda b: b["companies"][0]["models"][0].update(analystName="Another Analyst")):
            obj = bundle()
            mutate(obj)
            with self.assertRaises(ValueError):
                batch.verify_bundle(obj, COMPANY)

    def test_leg_counts_never_mark_manual_overall_as_passed(self):
        report = comparison()
        self.assertEqual(batch.counts(report, "sourceBackendStatus")["match"], 2)
        self.assertEqual(batch.counts(report, "backendWebsiteStatus")["match"], 1)
        self.assertEqual(batch.counts(report, "status")["match"], 1)
        self.assertEqual(batch.report_status(report), "manual")
        self.assertEqual(batch.report_status({"rows": []}), "unavailable")

    def test_unmapped_source_rows_are_counted_separately(self):
        report = {"rows": [{"status": "manual", "sourceBackendStatus": "not_checked", "backendWebsiteStatus": "match"}]}
        self.assertEqual(batch.counts(report, "sourceBackendStatus")["not_checked"], 1)
        self.assertEqual(sum(batch.counts(report, "sourceBackendStatus").values()), 1)
        self.assertEqual(batch.report_status(report), "manual")

    def test_slug_matches_swedish_site_convention(self):
        self.assertEqual(batch.website_url("https://site.example/", COMPANY),
                         "https://site.example/foretag/5561939215/akeri-soner-ab/")


class BatchExecutionTest(unittest.TestCase):
    def test_newer_comparative_explains_but_never_erases_original_difference(self):
        row = {"key": "sales", "label": "Liikevaihto", "sourceBackendStatus": "difference", "status": "difference", "note": "Original mismatch", "official": {"value": 100}}
        report = {"periodEnd": "2025-06-30", "rows": [row], "warnings": []}
        checked = {"rows": [{"sourceBackendStatus": "match", "official": {"value": 110, "selectedFact": {"elementId": "new-fact"}}}]}
        newer = [("2026-06-30", {}, {"name": "new.zip", "data": b"new"})]
        with patch.object(batch, "compare", return_value=checked):
            batch.comparative_evidence(report, {}, [{"key": "sales"}], newer)
        self.assertEqual(row["status"], "difference")
        self.assertEqual(row["official"]["value"], 100)
        self.assertEqual(row["newerComparativeEvidence"]["fact"]["elementId"], "new-fact")
        self.assertTrue(report["warnings"])
        report["warnings"] = []
        row.pop("newerComparativeEvidence")
        checked["rows"][0]["sourceBackendStatus"] = "manual"
        with patch.object(batch, "compare", return_value=checked):
            batch.comparative_evidence(report, {}, [{"key": "sales"}], newer)
        self.assertNotIn("newerComparativeEvidence", row)
        self.assertEqual(report["warnings"], [])

    def api(self, mode, query, cache):
        if query == "missing":
            raise ValueError("secret raw error")
        return [COMPANY] if mode == "search" else bundle()

    def source(self):
        return {"documents": [{"name": "original.xhtml", "sha256": "original-sha"}]}

    def downloaded(self):
        return {"data": b"filing", "name": "original.zip", "url": "https://official.example/part.zip",
                "retrievedAt": "2026-10-14T00:00:00Z"}

    def test_case_failure_continues_periods_and_companies(self):
        filings = Mock()
        filings.fetch.side_effect = [ValueError("secret"), self.downloaded()]
        with tempfile.TemporaryDirectory() as directory, patch.object(batch, "valuatum", side_effect=self.api), \
                patch.object(batch, "read_filing", return_value=self.source()), \
                patch.object(batch, "fetch_website", return_value=("html", "https://site.example/company")), \
                patch.object(batch, "compare", return_value=comparison()):
            result = batch.run_batch(["missing", COMPANY["orgnr"]], [], directory, filings=filings)
            self.assertEqual([c["status"] for c in result["cases"]], ["error", "error", "manual"])
            self.assertEqual(result["counts"]["error"], 2)
            self.assertNotIn("secret", json.dumps(result))
            report_path = Path(directory) / "5561939215_2025-06-30.report.json"
            report = json.loads(report_path.read_text(encoding="utf-8"))
            self.assertEqual(report["provenance"]["filingSha256"], hashlib.sha256(b"filing").hexdigest())
            self.assertEqual(report["provenance"]["backendMode"], "live")
            self.assertEqual(report["provenance"]["documents"][0]["sha256"], "original-sha")
            self.assertTrue((Path(directory) / "5561939215_2026-06-30.report.json").exists())

    def test_api_failure_has_no_saved_fallback(self):
        filings = Mock()
        with tempfile.TemporaryDirectory() as directory, patch.object(batch, "valuatum", side_effect=ValueError("token")):
            result = batch.run_batch([COMPANY["orgnr"]], [], directory, filings=filings)
            self.assertEqual(result["counts"]["error"], 1)
            filings.fetch.assert_not_called()

    def test_missing_official_keeps_website_check_without_source_approval(self):
        filings = Mock()
        filings.fetch.side_effect = ValueError(batch.MISSING_FILING)
        with tempfile.TemporaryDirectory() as directory, patch.object(batch, "valuatum", side_effect=self.api), \
                patch.object(batch, "fetch_website", return_value=("html", "https://site.example/company")), \
                patch.object(batch, "compare", return_value=comparison()) as check:
            result = batch.run_batch([COMPANY["orgnr"]], [], directory, latest=1, filings=filings)
            self.assertFalse(result["cases"][0]["sourceAvailable"])
            self.assertEqual(check.call_args.args[0]["facts"], [])
            self.assertEqual(check.call_args.args[2], "html")
            report = json.loads((Path(directory) / result["cases"][0]["report"]).read_text(encoding="utf-8"))
            self.assertIsNone(report["provenance"]["filingSha256"])

    def test_website_failure_retains_source_leg_and_marks_warning(self):
        filings = Mock()
        filings.fetch.return_value = self.downloaded()
        report = comparison()
        report["rows"][0].update(status="unavailable", backendWebsiteStatus="unavailable")
        with tempfile.TemporaryDirectory() as directory, patch.object(batch, "valuatum", side_effect=self.api), \
                patch.object(batch, "read_filing", return_value=self.source()), \
                patch.object(batch, "fetch_website", side_effect=OSError("raw server body")), \
                patch.object(batch, "compare", return_value=report) as compare_mock:
            result = batch.run_batch([COMPANY["orgnr"]], [], directory, latest=1, filings=filings)
            self.assertEqual(compare_mock.call_args.args[2], "")
            case = result["cases"][0]
            self.assertEqual(case["status"], "unavailable")
            self.assertEqual(case["sourceBackend"]["match"], 2)
            self.assertTrue(case["warnings"])
            self.assertNotIn("raw server body", json.dumps(result))

    def test_node_errors_are_sanitised_and_env_file_loaded(self):
        response = subprocess.CompletedProcess([], 1, stdout=b'{"error":"secret backend body"}', stderr=b"token")
        with patch.object(batch.subprocess, "run", return_value=response) as run:
            with self.assertRaises(ValueError) as error:
                batch.valuatum("search", "test", Path("cache"))
            self.assertNotIn("secret", str(error.exception))
            self.assertIn("--env-file-if-exists=.env", run.call_args.args[0])
            self.assertEqual(run.call_args.kwargs["cwd"], batch.ROOT)


if __name__ == "__main__":
    unittest.main()
