import copy
import json
import unittest
from pathlib import Path

from compare import compare


END = "2026-06-30"
ORGNR = "5561939215"
NS = "http://www.taxonomier.se/se/fr/gen-base/2024-01-01"
SALES = {"key": "netSales", "label": "Nettoomsättning", "variable": "ns", "concepts": ["Nettoomsattning"],
         "kind": "duration", "unit": "SEK", "zeroWhenAbsent": True}
EMPLOYEES = {"key": "employees", "label": "Medelantal anställda", "variable": "cr_employees",
             "concepts": ["MedelantaletAnstallda"], "kind": "duration", "unit": "people", "zeroWhenAbsent": False}


def fact(value=427568195, **kwargs):
    return {"concept": "se:Nettoomsattning", "localName": "Nettoomsattning", "namespace": NS,
            "contextId": "current", "entity": "556193-9215", "start": "2025-07-01", "end": END, "instant": None,
            "dimensions": {}, "unit": "iso4217:SEK", "unitRef": "SEK", "value": value, "decimals": 0,
            "text": str(value), "elementId": "official-fact-1", "documentIndex": 0, **kwargs}


def filing(*facts):
    return {"facts": list(facts), "documents": [{"name": "annual.xhtml", "kind": "annual", "html": ""},
                                               {"name": "audit.xhtml", "kind": "audit", "html": ""}], "warnings": []}


def bundle(**values):
    return {"fid": "52", "retrievedAt": "2026-10-12", "modeldata": {"companyName": "Test AB", "companyCode": ORGNR,
            "companyId": 60, "currency": "SEK", "dataMap": {"2025": {"cr_fiscal_year_end": 20260630,
            "cr_fiscal_period_length": 12, "ns": 427.568195, **values}}}}


def html(value="427 568", label="Nettoomsättning", year="2025/26", group="Resultaträkning, tkr", extra="", months="12 mån"):
    return f'''<figure class="fig ft" data-orgnr="{ORGNR}"><table><thead><tr><th>Post</th>
      <th scope="col" data-period-start="2025-07-01" data-period-end="{END}" data-period-months="12" data-consolidated="false"><span class="ft__y">{year}</span><span class="ft__p">{months}</span></th>
      </tr></thead><tbody><tr><th scope="rowgroup">{group}</th></tr><tr>
      <th scope="row">{label}</th><td><span class="num">{value}</span>{extra}</td></tr></tbody></table></figure>'''


class CompareTest(unittest.TestCase):
    def test_absent_keyed_duplicate_label_remains_unavailable(self):
        other = {**SALES, "key": "other", "label": "Övrigt", "sourceCheck": False}
        another = {**other, "key": "another"}
        site = html().replace('<tr>\n      <th scope="row">', '<tr data-metric-key="netSales">\n      <th scope="row">')
        report = compare(filing(fact()), bundle(), site, END, [SALES, other, another])
        self.assertEqual([r["backendWebsiteStatus"] for r in report["rows"][1:]], ["unavailable", "unavailable"])

    def row(self, source=None, backend=None, site=None, metrics=None):
        result = compare(source if source is not None else filing(fact()), backend if backend is not None else bundle(),
                         site if site is not None else html(), END, metrics if metrics is not None else [SALES])
        self.assertEqual(result["summary"]["total"], len(result["rows"]))
        return result["rows"][0]

    def test_exact_period_backend_millions_site_thousands(self):
        row = self.row()
        self.assertEqual(row["status"], "match")
        self.assertEqual(row["official"]["value"], 427568195)
        self.assertEqual(row["backend"]["value"], 427568195)
        self.assertEqual(row["website"]["value"], 427568000)
        self.assertEqual(row["official"]["facts"][0]["elementId"], "official-fact-1")

    def test_doubled_scale_and_wrong_sign(self):
        for raw in (855.13639, -427.568195, 427568195):
            with self.subTest(raw=raw):
                row = self.row(backend=bundle(ns=raw))
                self.assertEqual(row["sourceBackendStatus"], "difference")
                self.assertEqual(row["status"], "difference")

    def test_expense_sign_conversion_keeps_original_evidence_and_precision(self):
        expense = {**SALES, "key": "interestExpenses", "variable": "cr_interest_expenses",
                   "concepts": ["RantekostnaderLiknandeResultatposter"], "sourceSign": -1}
        for value in (12000, -12000, 0):
            with self.subTest(value=value):
                source = fact(value, localName=expense['concepts'][0], decimals=-3)
                row = self.row(source=filing(source), backend=bundle(cr_interest_expenses=-value / 1_000_000),
                               metrics=[expense])
                self.assertEqual(row['sourceBackendStatus'], 'match')
                self.assertEqual(row['official']['value'], -value)
                self.assertEqual(row['official']['selectedFact']['value'], value)
                self.assertEqual(row['official']['selectedFact']['elementId'], source['elementId'])
                wrong = self.row(source=filing(source), backend=bundle(cr_interest_expenses=(-value + 1000) / 1_000_000),
                                 metrics=[expense])
                self.assertEqual(wrong['sourceBackendStatus'], 'difference')
        missing = self.row(source=filing(), backend=bundle(cr_interest_expenses=0), metrics=[expense])
        self.assertEqual(missing['sourceBackendStatus'], 'unavailable')
        self.assertIsNone(missing['official']['value'])

    def test_wrong_period_entity_dimension_namespace_unit(self):
        for changes in ({"start": "2025-01-01"}, {"end": "2025-06-30"}, {"entity": "5561939216"},
                        {"dimensions": {"axis": "group"}}, {"contextId": None}, {"namespace": ""},
                        {"unit": "iso4217:EUR"}, {"unit": None}):
            with self.subTest(changes=changes):
                self.assertNotEqual(self.row(source=filing(fact(**changes)))["sourceBackendStatus"], "match")

    def test_annual_documents_only(self):
        self.assertEqual(self.row(source=filing(fact(documentIndex=1)))["sourceBackendStatus"], "unavailable")

    def test_company_and_group_same_period_are_separated(self):
        company = fact(reportingScope="company", contextId="jur", elementId="company")
        group = fact(900000000, reportingScope="group", contextId="kon", elementId="group")
        general = fact(123, reportingScope="general", contextId="gem", elementId="general")
        for facts in ((company, group, general), (general, group, company)):
            row = self.row(source=filing(*facts))
            self.assertEqual(row["sourceBackendStatus"], "match")
            self.assertEqual(row["official"]["selectedFact"]["elementId"], "company")
            self.assertEqual(row["official"]["facts"], [company])

    def test_general_group_unknown_and_dimensional_scope_never_match_company(self):
        for changes in ({"reportingScope": "group"}, {"reportingScope": "general"}, {"reportingScope": "unknown"},
                        {"reportingScope": None}, {"reportingScope": "company", "dimensions": {"axis": "value"}}):
            with self.subTest(changes=changes):
                self.assertEqual(self.row(source=filing(fact(**changes)))["sourceBackendStatus"], "manual")

    def test_unsegmented_numbers_in_segmented_document_have_unknown_scope(self):
        unsegmented = fact(reportingScope="unsegmented")
        group = fact(900000000, reportingScope="group", localName="OtherFact")
        self.assertEqual(self.row(source=filing(unsegmented, group))["sourceBackendStatus"], "manual")
        self.assertEqual(self.row(source=filing(unsegmented))["sourceBackendStatus"], "match")

    def test_rounded_summary_and_exact_duplicate_are_consistent(self):
        rounded = fact(427568000, decimals=-3, elementId="rounded-summary")
        exact = fact(elementId="precise-detail")
        for facts in ((rounded, exact), (exact, rounded)):
            row = self.row(source=filing(*facts))
            self.assertEqual(row["status"], "match")
            self.assertEqual(row["official"]["value"], 427568195)
            self.assertEqual(row["official"]["selectedFact"]["elementId"], "precise-detail")
            self.assertEqual(row["official"]["facts"], list(facts))
        row = self.row(source=filing(fact(427568000, decimals=-3)))
        self.assertEqual(row["sourceBackendStatus"], "match")
        self.assertEqual(self.row(source=filing(fact(427568000, decimals=-3)), backend=bundle(ns=427.569))[
            "sourceBackendStatus"], "difference")

    def test_conflicting_duplicate_and_nil_are_manual(self):
        for facts in ((fact(), fact(427568200)), (fact(), fact(427568196)),
                      (fact(100.01), fact(100.02)), (fact(), fact(None)), (fact(error="bad transform"),)):
            self.assertEqual(self.row(source=filing(*facts))["sourceBackendStatus"], "manual")

    def test_unknown_precision_manual_exact_precision_supported(self):
        self.assertEqual(self.row(source=filing(fact(decimals=None)))["sourceBackendStatus"], "manual")
        self.assertEqual(self.row(source=filing(fact(decimals=None, decimalsRaw="INF")))["status"], "match")

    def test_multiple_entities_manual_and_entity_prefix_normalized(self):
        self.assertEqual(self.row(source=filing(fact(entity="165561939215")))["status"], "match")
        self.assertEqual(self.row(source=filing(fact(), fact(entity="5561939216")))["sourceBackendStatus"], "manual")
        backend = bundle()
        backend["modeldata"]["companyCode"] += "K"
        self.assertEqual(self.row(backend=backend)["status"], "manual")

    def test_absent_source_never_becomes_zero(self):
        backend = bundle()
        del backend["modeldata"]["dataMap"]["2025"]["ns"]
        row = self.row(source=filing(), backend=backend, site=html("0"))
        self.assertEqual(row["backend"]["value"], 0)
        self.assertEqual(row["backend"]["status"], "zero_omission")
        self.assertIsNone(row["official"]["value"])
        self.assertEqual(row["sourceBackendStatus"], "unavailable")
        self.assertEqual(row["backendWebsiteStatus"], "match")
        self.assertEqual(row["status"], "unavailable")

    def test_net_sales_missing_with_gross_profit_site_old_zero_manual(self):
        backend = bundle(cr_gross_profit=122.665033)
        del backend["modeldata"]["dataMap"]["2025"]["ns"]
        row = self.row(source=filing(), backend=backend, site=html("0"))
        self.assertIsNone(row["backend"]["value"])
        self.assertEqual(row["backendWebsiteStatus"], "manual")
        self.assertEqual(row["website"]["value"], 0)

    def test_missing_employees_stays_missing(self):
        row = self.row(source=filing(), backend=bundle(), site=html("saknas", EMPLOYEES["label"], group="Nyckeltal"), metrics=[EMPLOYEES])
        self.assertIsNone(row["backend"]["value"])
        self.assertNotEqual(row["status"], "match")

    def test_people_unit_and_rounding(self):
        source = filing(fact(52.2, localName="MedelantaletAnstallda", unit="se-k3-type:AntalPersoner", decimals=1))
        row = self.row(source=source, backend=bundle(cr_employees=52.2),
                       site=html("52", EMPLOYEES["label"], group="Nyckeltal"), metrics=[EMPLOYEES])
        self.assertEqual(row["status"], "match")

    def test_gross_profit_without_direct_fact_is_not_source_zero(self):
        metric = {**SALES, "key": "grossProfit", "variable": "cr_gross_profit", "concepts": ["Bruttoresultat"]}
        row = self.row(source=filing(), backend=bundle(cr_gross_profit=122.665033), metrics=[metric])
        self.assertIsNone(row["official"]["value"])
        self.assertEqual(row["sourceBackendStatus"], "manual")
        metric["concepts"] = []
        self.assertEqual(self.row(source=filing(), metrics=[metric])["sourceBackendStatus"], "manual")

    def test_missing_or_duplicate_rest_metadata_never_infers_year(self):
        for key in ("cr_fiscal_year_end", "cr_fiscal_period_length"):
            backend = bundle()
            del backend["modeldata"]["dataMap"]["2025"][key]
            self.assertNotEqual(self.row(backend=backend)["status"], "match")
        backend = bundle()
        backend["modeldata"]["dataMap"]["2024"] = copy.deepcopy(backend["modeldata"]["dataMap"]["2025"])
        self.assertEqual(self.row(backend=backend)["status"], "manual")

    def test_exact_fiscal_header_and_published_units_required(self):
        for site in (html(year="2025"), html(group="Resultaträkning, Mkr"), html(months="9 mån"),
                     html(months="12 mån · koncern"), html().replace('class="fig ft"', 'class="kpi"')):
            self.assertNotEqual(self.row(site=site)["backendWebsiteStatus"], "match")

    def test_only_financial_table_and_visible_cell_used(self):
        site = '<table><tr><th scope="row">Nettoomsättning</th><td>999</td></tr></table>' + html(
            "427\u00a0568", extra='<span class="visually-hidden">Missing note 999</span><span class="tip">123</span>')
        self.assertEqual(self.row(site=site)["status"], "match")
        self.assertEqual(self.row(site=html("−427 568"))["backendWebsiteStatus"], "difference")

    def test_duplicate_published_rows_and_config_labels_manual(self):
        self.assertEqual(self.row(site=html() + html())["backendWebsiteStatus"], "manual")
        self.assertEqual(self.row(metrics=[SALES, {**SALES, "key": "other"}])["backendWebsiteStatus"], "manual")

    def test_same_label_in_distinct_statement_groups(self):
        income = html(label="Årets resultat", group="Resultaträkning, tkr")
        balance = html("100", label="Årets resultat", group="Balansräkning, tkr")
        metric = {**SALES, "label": "Årets resultat", "websiteGroup": "Resultaträkning"}
        row = self.row(site=income + balance, metrics=[metric])
        self.assertEqual(row["backendWebsiteStatus"], "match")
        self.assertEqual(row["website"]["value"], 427568000)
        balance_metric = {**metric, "key": "balanceProfit", "websiteGroup": "Balansräkning"}
        report = compare(filing(fact()), bundle(), income + balance, END, [metric, balance_metric])
        self.assertEqual(report["rows"][0]["backendWebsiteStatus"], "match")
        self.assertEqual(report["rows"][1]["backendWebsiteStatus"], "difference")
        self.assertEqual(report["rows"][1]["website"]["value"], 100000)
        self.assertEqual(self.row(site=income + balance + income, metrics=[metric])["backendWebsiteStatus"], "manual")
        self.assertEqual(self.row(site=balance, metrics=[metric])["backendWebsiteStatus"], "unavailable")

    def test_missing_header_does_not_shift_column_position(self):
        site = html().replace('<th scope="col" data-period-start=', '<th scope="col">Unknown year</th><th scope="col" data-period-start=')
        site = site.replace('<td><span class="num">', '<td>427 568</td><td><span class="num">')
        self.assertEqual(self.row(site=site)["backendWebsiteStatus"], "manual")

    def test_published_identity_and_exact_fiscal_metadata_required(self):
        attributes = {"data-orgnr": ORGNR, "data-period-start": "2025-07-01", "data-period-end": END,
                      "data-period-months": "12", "data-consolidated": "false"}
        wrong = {"data-orgnr": "5561939216", "data-period-start": "2025-08-01", "data-period-end": "2026-07-31",
                 "data-period-months": "9", "data-consolidated": "true"}
        for attribute, original in attributes.items():
            for replacement in ("", f'{attribute}="{wrong[attribute]}"', f'{attribute}="unknown"', attribute):
                with self.subTest(attribute=attribute, replacement=replacement):
                    site = html().replace(f'{attribute}="{original}"', replacement)
                    row = self.row(site=site)
                    self.assertEqual(row["backendWebsiteStatus"], "manual")
                    self.assertEqual(row["website"]["value"], 427568000)
                    self.assertEqual(row["website"]["text"], "427 568")
        legacy = html()
        for attribute, original in attributes.items():
            legacy = legacy.replace(f'{attribute}="{original}"', "")
        self.assertEqual(self.row(site=legacy)["backendWebsiteStatus"], "manual")
        self.assertEqual(self.row(site=legacy)["website"]["value"], 427568000)
        self.assertEqual(self.row(site=html().replace(ORGNR, "165561939215"))["backendWebsiteStatus"], "match")

    def test_namespace_prefix_currency_and_instant(self):
        config = {"namespacePrefix": "http://www.taxonomier.se/se/fr/gen-base/", "metrics": [SALES]}
        self.assertEqual(self.row(metrics=config)["status"], "match")
        self.assertEqual(self.row(source=filing(fact(namespace="http://other.example/")), metrics=config)["sourceBackendStatus"], "manual")
        backend = bundle()
        backend["modeldata"]["currency"] = "EUR"
        self.assertEqual(self.row(backend=backend)["sourceBackendStatus"], "manual")
        metric = {**SALES, "key": "totalAssets", "concepts": ["Tillgangar"], "kind": "instant"}
        self.assertEqual(self.row(source=filing(fact(localName="Tillgangar", instant=END, start=None, end=None)), metrics=[metric])["status"], "match")

    def test_real_sample_year_key_2025_means_june_2026(self):
        sample = json.loads((Path(__file__).resolve().parents[2] / "data/sample/api-cache/52.json").read_text(encoding="utf-8"))
        self.assertEqual(self.row(backend=sample)["status"], "match")

    def test_unmapped_additional_metric_checks_only_website(self):
        metric = {**SALES, "key": "otherIncome", "concepts": [], "sourceCheck": False}
        row = self.row(metrics=[metric])
        self.assertEqual(row["sourceBackendStatus"], "not_checked")
        self.assertEqual(row["official"]["status"], "not_checked")
        self.assertEqual(row["backendWebsiteStatus"], "match")
        self.assertEqual(row["status"], "manual")
        self.assertEqual(row["unit"], "SEK")
        self.assertIsNone(row["differenceSourceBackend"])

    def test_percent_fraction_conversion_and_display_precision(self):
        metric = {"key": "margin", "label": "Rörelsemarginal", "variable": "margin", "unit": "percent",
                  "kind": "duration", "sourceCheck": False, "concepts": [], "displayDigits": 1,
                  "websiteGroup": "Nyckeltal", "zeroWhenAbsent": False}
        for raw, displayed in ((0.456, "45,6 %"), (0.45561, "45,6 %"), (-0.45561, "−45,6 %"), (0, "0,0 %")):
            with self.subTest(raw=raw):
                row = self.row(backend=bundle(margin=raw), site=html(displayed, metric["label"], group="Nyckeltal"), metrics=[metric])
                self.assertEqual(row["backendWebsiteStatus"], "match")
                self.assertAlmostEqual(row["backend"]["value"], raw * 100)
                self.assertEqual(row["status"], "manual")
                self.assertEqual(row["unit"], "percent")
        self.assertEqual(self.row(backend=bundle(margin=0.45549), site=html("45,6 %", metric["label"], group="Nyckeltal"),
                                  metrics=[metric])["backendWebsiteStatus"], "difference")
        self.assertEqual(self.row(backend=bundle(margin=45.6), site=html("45,6 %", metric["label"], group="Nyckeltal"),
                                  metrics=[metric])["backendWebsiteStatus"], "difference")
        for displayed, group in (("45,6", "Nyckeltal"), ("45,6 kr", "Nyckeltal"), ("45,6 %%", "Nyckeltal")):
            self.assertEqual(self.row(backend=bundle(margin=0.456), site=html(displayed, metric["label"], group=group),
                                      metrics=[metric])["backendWebsiteStatus"], "manual")
        self.assertNotEqual(self.row(backend=bundle(margin=0.456), site=html("45,6 %", metric["label"], group="Resultaträkning, tkr"),
                                     metrics=[metric])["backendWebsiteStatus"], "match")
        metric["displayDigits"] = 0
        self.assertEqual(self.row(backend=bundle(margin=0.456), site=html("46 %", metric["label"], group="Nyckeltal"),
                                  metrics=[metric])["backendWebsiteStatus"], "match")
        self.assertEqual(self.row(backend=bundle(margin=0.4549), site=html("46 %", metric["label"], group="Nyckeltal"),
                                  metrics=[metric])["backendWebsiteStatus"], "difference")

    def test_metric_keys_disambiguate_repeated_statement_labels(self):
        metric = {**SALES, "key": "otherA", "label": "Övrigt", "websiteGroup": "Balansräkning"}
        other_metric = {**metric, "key": "otherB"}
        site = html(label="Övrigt", group="Balansräkning, tkr").replace('<tr>\n      <th scope="row">', '<tr data-metric-key="otherA">\n      <th scope="row">')
        other_site = html("100", label="Övrigt", group="Balansräkning, tkr").replace('<tr>\n      <th scope="row">', '<tr data-metric-key="otherB">\n      <th scope="row">')
        report = compare(filing(fact()), bundle(), site + other_site, END, [metric, other_metric])
        self.assertEqual(report["rows"][0]["backendWebsiteStatus"], "match")
        self.assertEqual(report["rows"][1]["backendWebsiteStatus"], "difference")
        self.assertEqual(report["rows"][1]["website"]["value"], 100000)
        self.assertEqual(self.row(site=site + site, metrics=[metric])["backendWebsiteStatus"], "manual")
        self.assertEqual(self.row(site=site.replace('data-metric-key="otherA"', 'data-metric-key="wrong"'),
                                  metrics=[metric])["backendWebsiteStatus"], "unavailable")
        for changed in (site.replace('scope="row">Övrigt', 'scope="row">Other'),
                        site.replace("Balansräkning, tkr", "Resultaträkning, tkr")):
            self.assertEqual(self.row(site=changed, metrics=[metric])["backendWebsiteStatus"], "manual")
        self.assertEqual(self.row(site=site.replace('data-period-end="2026-06-30"', 'data-period-end="2025-06-30"'),
                                  metrics=[metric])["backendWebsiteStatus"], "manual")

    def test_missing_publication_does_not_pass_unmapped_metric(self):
        metric = {**SALES, "sourceCheck": False, "concepts": []}
        row = self.row(site="", metrics=[metric])
        self.assertEqual(row["website"]["status"], "missing")
        self.assertEqual(row["backendWebsiteStatus"], "unavailable")
        self.assertNotEqual(row["status"], "match")

    def test_coverage_counts_both_legs_separately(self):
        extra = {**SALES, "key": "other", "label": "Other", "sourceCheck": False, "concepts": []}
        report = compare(filing(fact()), bundle(), html() + html(label="Other"), END, [SALES, extra])
        self.assertEqual(report["coverage"]["total"], 2)
        self.assertEqual(report["coverage"]["sourceBackend"]["match"], 1)
        self.assertEqual(report["coverage"]["sourceBackend"]["not_checked"], 1)
        self.assertEqual(report["coverage"]["backendWebsite"]["match"], 2)
        self.assertEqual(sum(report["coverage"]["sourceBackend"].values()), 2)
        self.assertEqual(sum(report["coverage"]["backendWebsite"].values()), 2)


if __name__ == "__main__":
    unittest.main()
