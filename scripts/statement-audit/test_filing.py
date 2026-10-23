import hashlib
import io
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET
import zipfile

import filing
from compare import SourceReader, _official


CONTEXT = '''<xbrli:context id="duration"><xbrli:entity><xbrli:identifier scheme="test">556193-9215</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:startDate>2025-07-01</xbrli:startDate><xbrli:endDate>2026-06-30</xbrli:endDate></xbrli:period></xbrli:context>'''
INSTANT = '''<xbrli:context id="balance"><xbrli:entity><xbrli:identifier scheme="test">556193-9215</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:instant>2026-06-30</xbrli:instant></xbrli:period></xbrli:context>'''
UNITS = '''<xbrli:unit id="SEK"><xbrli:measure>iso4217:SEK</xbrli:measure></xbrli:unit><xbrli:unit id="people"><xbrli:measure>se-k3-type:AntalPersoner</xbrli:measure></xbrli:unit>'''


def document(body="", contexts=CONTEXT + INSTANT, units=UNITS, title="Årsredovisning", extra=""):
    return f'''<?xml version="1.0" encoding="UTF-8"?><html xmlns="{filing.XHTML}" xmlns:ix="{filing.IX}" xmlns:xbrli="{filing.XBRLI}" xmlns:xbrldi="{filing.XBRLDI}" xmlns:xsi="{filing.XSI}" xmlns:iso4217="http://www.xbrl.org/2003/iso4217" xmlns:ixt="{filing.TRANSFORM_BASE}2010-04-20" xmlns:ixt4="{filing.TRANSFORM_BASE}2020-02-12" xmlns:ixt5="{filing.TRANSFORM_BASE}2022-02-16" xmlns:se-gen-base="http://www.taxonomier.se/se/fr/gen-base/2020-12-01" xmlns:se-k3-type="http://www.taxonomier.se/se/fr/k3/datatype" xmlns:test="urn:test" {extra}><head><title>{title}</title><style>p {{ color: red }}</style></head><body><ix:header><ix:resources>{contexts}{units}</ix:resources></ix:header>{body}</body></html>'''.encode("utf-8")


def numeric(text, **attrs):
    base = {"name": "se-gen-base:Nettoomsattning", "contextRef": "duration", "unitRef": "SEK", "decimals": "0"}
    base.update(attrs)
    return '<ix:nonFraction ' + " ".join(f'{key}="{value}"' for key, value in base.items() if value is not None) + f'>{text}</ix:nonFraction>'


def archive(entries):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as zip_file:
        for name, content in entries:
            zip_file.writestr(name, content)
    return stream.getvalue()


class FilingTests(unittest.TestCase):
    def read(self, body="", **kwargs):
        return filing.read_filing(document(body, **kwargs), "sample.xhtml")

    def test_sweden_context_units_and_both_precision_values(self):
        result = self.read(numeric("427 568", format="ixt:numspacecomma", decimals="-3", scale="3") + numeric("427 568 195", format="ixt:numspacecomma") + numeric("52", unitRef="people"))
        self.assertEqual([fact["value"] for fact in result["facts"]], [427568000, 427568195, 52])
        first = result["facts"][0]
        self.assertEqual(first["namespace"], "http://www.taxonomier.se/se/fr/gen-base/2020-12-01")
        self.assertEqual((first["entity"], first["start"], first["end"], first["instant"]), ("556193-9215", "2025-07-01", "2026-06-30", None))
        self.assertEqual(first["decimals"], -3)
        self.assertEqual(result["facts"][2]["unit"], "se-k3-type:AntalPersoner")
        self.assertEqual(result["warnings"], [])

    def test_gross_profit_label_invalidates_sales_semantics_after_numeric_parsing(self):
        for label in ("Bruttoresultat", "Bruttoresultat, tkr"):
            for value in ("123", "0"):
                with self.subTest(label=label, value=value):
                    body = f'<table><tr><td><p>{label}</p></td><td>{numeric(value, id="sales")}</td></tr></table>'
                    result = self.read(body)
                    fact = result["facts"][0]
                    self.assertEqual(fact["value"], int(value))
                    self.assertEqual(fact["text"], value)
                    self.assertEqual(fact["elementId"], "sales")
                    self.assertEqual(fact["contextId"], "duration")
                    self.assertEqual(fact["entity"], "556193-9215")
                    self.assertEqual(fact["end"], "2026-06-30")
                    self.assertEqual(fact["documentIndex"], 0)
                    self.assertEqual(fact["literalSourceLabel"], label)
                    self.assertEqual(fact["error"], fact["semanticIssue"])
                    self.assertIn("gross-profit", fact["semanticIssue"])
                    self.assertEqual(len(result["warnings"]), 1)

    def test_sales_label_check_uses_only_the_first_literal_label_cell(self):
        bodies = [
            f'<tr><td>Nettoomsättning</td><td>{numeric("123")}</td></tr>',
            f'<tr><td>Nettoomsättning, inklusive Bruttoresultat</td><td>{numeric("123")}</td></tr>',
            f'<tr><td>Bruttoresultat och övrigt</td><td>{numeric("123")}</td></tr>',
            f'<tr><td></td><td>Bruttoresultat</td><td>{numeric("123")}</td></tr>',
            f'<tr><td>Nettoomsättning</td><td>Bruttoresultat {numeric("123")}</td></tr>',
            f'<tr><td>Bruttoresultat {numeric("123")}</td></tr>',
            f'<tr><td>Bruttoresultat</td><td>10</td></tr><tr><td>Nettoomsättning</td><td>{numeric("123")}</td></tr>',
        ]
        for body in bodies:
            with self.subTest(body=body):
                fact = self.read('<table>' + body + '</table>')["facts"][0]
                self.assertEqual(fact["value"], 123)
                self.assertNotIn("error", fact)
                self.assertNotIn("literalSourceLabel", fact)

    def test_tagged_gross_profit_label_is_not_a_literal_label(self):
        label = '<ix:nonNumeric name="test:Label" contextRef="duration">Bruttoresultat</ix:nonNumeric>'
        fact = self.read(f'<table><tr><td>{label}</td><td>{numeric("123")}</td></tr></table>')["facts"][1]
        self.assertEqual(fact["value"], 123)
        self.assertNotIn("error", fact)

    def test_nested_tables_do_not_supply_an_outer_gross_profit_label(self):
        bodies = [
            f'<tr><td><table><tr><td>Bruttoresultat</td></tr></table></td><td>{numeric("123")}</td></tr>',
            f'<tr><td>Bruttoresultat</td><td><table><tr><td>{numeric("123")}</td></tr></table></td></tr>',
            f'<tr><td>Bruttoresultat</td><td><table><tr><td>Nettoomsättning</td><td>{numeric("123")}</td></tr></table></td></tr>',
        ]
        for body in bodies:
            with self.subTest(body=body):
                fact = self.read('<table>' + body + '</table>')["facts"][0]
                self.assertEqual(fact["value"], 123)
                self.assertNotIn("error", fact)

    def test_semantic_sales_error_makes_direct_and_growth_references_manual(self):
        prior = CONTEXT.replace('id="duration"', 'id="prior"').replace("2025-07-01", "2024-07-01").replace("2026-06-30", "2025-06-30")
        source = self.read(f'<table><tr><td>Bruttoresultat</td><td>{numeric("123")}</td><td>{numeric("100", contextRef="prior")}</td></tr></table>', contexts=CONTEXT + prior)
        sales = {"key": "netSales", "variable": "ns", "concepts": ["Nettoomsattning"], "kind": "duration", "unit": "SEK"}
        official, tolerance = _official(sales, source["facts"], source["documents"], "5561939215", "2025-07-01", "2026-06-30", True, False)
        self.assertEqual(official["status"], "manual")
        self.assertIsNone(official["value"])
        self.assertIsNone(tolerance)
        self.assertIn("semanticIssue", official["facts"][0])
        self.assertNotIn("invalid or missing context", official["note"])
        bundle = {"modeldata": {"dataMap": {
            "2026": {"cr_fiscal_year_end": 20260630, "cr_fiscal_period_length": 12},
            "2025": {"cr_fiscal_year_end": 20250630, "cr_fiscal_period_length": 12},
        }}}
        growth = {"key": "revenueGrowth", "variable": "ns_growth", "kind": "duration", "unit": "percent", "sourceFormula": '100*(v("ns") / v("ns",-1) - 1)'}
        computed, _, amount = SourceReader(source, bundle, [sales], {}, "5561939215", False).read(growth, "2026-06-30")
        self.assertEqual(computed["status"], "manual")
        self.assertIsNone(computed["value"])
        self.assertIsNone(amount)
        self.assertEqual([fact["value"] for fact in source["facts"]], [123, 100])

    def test_semantic_error_with_valid_context_does_not_poison_other_periods(self):
        prior = CONTEXT.replace('id="duration"', 'id="prior"').replace("2025-07-01", "2024-07-01").replace("2026-06-30", "2025-06-30")
        body = f'<table><tr><td>Bruttoresultat</td><td>{numeric("123")}</td></tr><tr><td>Nettoomsättning</td><td>{numeric("100", contextRef="prior")}</td></tr></table>'
        source = self.read(body, contexts=CONTEXT + prior)
        metric = {"key": "netSales", "concepts": ["Nettoomsattning"], "kind": "duration", "unit": "SEK"}
        official, _ = _official(metric, source["facts"], source["documents"], "5561939215", "2024-07-01", "2025-06-30", True, False)
        self.assertEqual(official["status"], "reported")
        self.assertEqual(official["value"], 100)

    def test_decimal_transformation_registry(self):
        cases = [
            ("ixt:numspacecomma", "1\u00a0234,56", 1234.56),
            ("ixt:numspacecomma", "1 234 567", 1234567),
            ("ixt:numcomma", "1234,56", 1234.56),
            ("ixt:numdot", "1234.56", 1234.56),
            ("ixt:numdotcomma", "1.234,56", 1234.56),
            ("ixt:numcommadot", "1,234.56", 1234.56),
            ("ixt4:num-comma-decimal", "1.234,56", 1234.56),
            ("ixt5:num-dot-decimal", "1,234.56", 1234.56),
            ("ixt4:num-comma-decimal", ",56", 0.56),
            ("ixt5:num-dot-decimal", ".56", 0.56),
            (None, "-1234.56", -1234.56),
        ]
        for format_name, text, expected in cases:
            with self.subTest(format=format_name, text=text):
                fact = self.read(numeric(text, format=format_name))["facts"][0]
                self.assertNotIn("error", fact)
                self.assertEqual(fact["value"], expected)

    def test_scale_sign_and_decimal_exactness(self):
        cases = [("0.1", "1", "-", -1), ("123", "-2", None, 1.23), ("12345678901234567890123456789", "3", None, 12345678901234567890123456789000)]
        for text, scale, sign, expected in cases:
            with self.subTest(text=text):
                fact = self.read(numeric(text, scale=scale, sign=sign, decimals="INF"))["facts"][0]
                self.assertEqual(fact["value"], expected)
                self.assertIsNone(fact["decimals"])
                self.assertEqual(fact["decimalsRaw"], "INF")

    def test_invalid_transform_and_numeric_text_never_becomes_zero(self):
        cases = [
            numeric("-", format="ixt:numspacecomma"),
            numeric("1234", format="ixt:invented"),
            numeric("1234", format="test:numcomma"),
            numeric("1,234.50"), numeric(""), numeric("NaN"), numeric("1e3"),
            numeric("12 34", format="ixt:numspacecomma"),
            numeric("1.234", format="ixt:numcomma"),
            numeric("-1", format="ixt:numdot"),
            numeric("1", sign="+"), numeric("-1", sign="-"),
            numeric("1", scale="1001"), numeric("1", decimals="bad"),
            numeric("0.01", scale="-1000"),
        ]
        for body in cases:
            with self.subTest(body=body):
                fact = self.read(body)["facts"][0]
                self.assertIsNone(fact["value"])
                self.assertIn("error", fact)

    def test_nil_is_none_and_real_zero_is_zero(self):
        result = self.read(numeric("", **{"xsi:nil": "true"}) + numeric("0"))
        self.assertIsNone(result["facts"][0]["value"])
        self.assertNotIn("error", result["facts"][0])
        self.assertEqual(result["facts"][1]["value"], 0)

    def test_missing_and_unknown_units(self):
        for ref, units in [("missing", UNITS), ("SEK", '<xbrli:unit id="SEK"><xbrli:measure>test:SEK</xbrli:measure></xbrli:unit>'), ("SEK", UNITS + UNITS), ("SEK", '<xbrli:unit id="SEK"><xbrli:divide/></xbrli:unit>'), ("SEK", UNITS.replace("iso4217:SEK", "iso4217:ABC"))]:
            with self.subTest(ref=ref, units=units):
                fact = self.read(numeric("123", unitRef=ref), units=units)["facts"][0]
                self.assertIsNone(fact["value"])
                self.assertIn("unit", fact["error"].lower())

    def test_context_errors_do_not_retain_numeric_values(self):
        cases = ["", CONTEXT + CONTEXT, CONTEXT.replace("2026-06-30", "2026-02-30"), CONTEXT.replace("2025-07-01", "2027-07-01"), CONTEXT.replace("<xbrli:endDate>", "<xbrli:instant>").replace("</xbrli:endDate>", "</xbrli:instant>")]
        for contexts in cases:
            with self.subTest(contexts=contexts):
                fact = self.read(numeric("123"), contexts=contexts)["facts"][0]
                self.assertIsNone(fact["value"])
                self.assertIn("error", fact)

    def test_instant_context(self):
        fact = self.read(numeric("123", contextRef="balance"))["facts"][0]
        self.assertEqual(fact["instant"], "2026-06-30")
        self.assertIsNone(fact["start"])
        self.assertIsNone(fact["end"])

    def test_explicit_and_typed_dimensions_are_preserved(self):
        dimensions = '<xbrli:scenario><xbrldi:explicitMember dimension="test:Group">test:Parent</xbrldi:explicitMember><xbrldi:typedMember dimension="test:Region"><test:Code>SE</test:Code></xbrldi:typedMember></xbrli:scenario>'
        fact = self.read(numeric("123"), contexts=CONTEXT.replace("</xbrli:context>", dimensions + "</xbrli:context>"))["facts"][0]
        self.assertEqual(fact["dimensions"]["{urn:test}Group"], "{urn:test}Parent")
        self.assertIn("SE", fact["dimensions"]["{urn:test}Region"])
        self.assertEqual(fact["value"], 123)
        duplicate = dimensions.replace('</xbrli:scenario>', '<xbrldi:explicitMember dimension="test:Group">test:Other</xbrldi:explicitMember></xbrli:scenario>')
        fact = self.read(numeric("123"), contexts=CONTEXT.replace("</xbrli:context>", duplicate + "</xbrli:context>"))["facts"][0]
        self.assertIsNone(fact["value"])
        self.assertIn("Duplicate", fact["error"])

    def test_known_company_group_general_segments_preserve_scope(self):
        for version in ("2020-12-01", "2021-10-31"):
            for name, expected in (("JuridiskPerson", "company"), ("Koncern", "group"), ("Generell", "general")):
                canonical = f"RedovisningInformation{name}Segment"
                for local_name in (canonical, canonical.lower()):
                    with self.subTest(version=version, scope=expected, local_name=local_name):
                        contexts = CONTEXT.replace('</xbrli:entity>', f'<xbrli:segment><se-gen-base:{local_name}/></xbrli:segment></xbrli:entity>')
                        xml = document(numeric("123"), contexts=contexts).replace(b"gen-base/2020-12-01", f"gen-base/{version}".encode())
                        fact = filing.read_filing(xml, "scope.xhtml")["facts"][0]
                        self.assertEqual(fact["reportingScope"], expected)
                        self.assertEqual(fact["entity"], "556193-9215")
                        self.assertEqual(fact["value"], 123)
                        self.assertEqual(fact["dimensions"], {})
                        self.assertNotIn("error", fact)

    def test_lowercase_scope_aliases_require_exact_known_namespaces_and_names(self):
        for name in ("juridiskperson", "koncern", "generell"):
            local_name = f"redovisninginformation{name}segment"
            for namespace in ("urn:test", "http://www.taxonomier.se/se/fr/gen-base/2017-09-30",
                              "http://www.taxonomier.se/se/fr/gen-base/2024-09-12"):
                with self.subTest(name=local_name, namespace=namespace):
                    marker = f'<alias:{local_name} xmlns:alias="{namespace}"/>'
                    contexts = CONTEXT.replace('</xbrli:entity>', f'<xbrli:segment>{marker}</xbrli:segment></xbrli:entity>')
                    fact = self.read(numeric("123"), contexts=contexts)["facts"][0]
                    self.assertIsNone(fact["value"])
                    self.assertIsNone(fact["reportingScope"])
                    self.assertIn("Unsupported context", fact["error"])
        for name in ("redovisninginformationunknownsegment", "REDOVISNINGINFORMATIONJURIDISKPERSONSEGMENT",
                     "redovisningInformationJuridiskPersonSegment"):
            with self.subTest(name=name):
                contexts = CONTEXT.replace('</xbrli:entity>', f'<xbrli:segment><se-gen-base:{name}/></xbrli:segment></xbrli:entity>')
                self.assertIn("error", self.read(numeric("123"), contexts=contexts)["facts"][0])

    def test_lowercase_scope_aliases_reject_mixed_or_ambiguous_segments(self):
        for version in ("2020-12-01", "2021-10-31"):
            marker = '<se-gen-base:redovisninginformationjuridiskpersonsegment/>'
            members = [
                marker + '<se-gen-base:redovisninginformationkoncernsegment/>',
                marker + '<se-gen-base:RedovisningInformationJuridiskPersonSegment/>',
                marker + marker,
                marker + '<xbrldi:explicitMember dimension="test:Group">test:Parent</xbrldi:explicitMember>',
                'unknown scope' + marker, marker + 'unknown scope',
                '<se-gen-base:redovisninginformationjuridiskpersonsegment test:extra="company"/>',
                '<se-gen-base:redovisninginformationjuridiskpersonsegment><test:Child/></se-gen-base:redovisninginformationjuridiskpersonsegment>',
                '<se-gen-base:redovisninginformationjuridiskpersonsegment>company</se-gen-base:redovisninginformationjuridiskpersonsegment>',
            ]
            for member in members:
                with self.subTest(version=version, member=member):
                    contexts = CONTEXT.replace('</xbrli:entity>', f'<xbrli:segment>{member}</xbrli:segment></xbrli:entity>')
                    xml = document(numeric("123"), contexts=contexts).replace(b"gen-base/2020-12-01", f"gen-base/{version}".encode())
                    fact = filing.read_filing(xml, "scope.xhtml")["facts"][0]
                    self.assertIsNone(fact["value"])
                    self.assertIsNone(fact["reportingScope"])
                    self.assertIn("error", fact)
            for contexts in (
                    CONTEXT.replace('</xbrli:context>', f'<xbrli:scenario>{marker}</xbrli:scenario></xbrli:context>'),
                    CONTEXT.replace('</xbrli:entity>', f'<xbrli:segment>{marker}</xbrli:segment><xbrli:segment>{marker}</xbrli:segment></xbrli:entity>')):
                with self.subTest(version=version, contexts=contexts):
                    xml = document(numeric("123"), contexts=contexts).replace(b"gen-base/2020-12-01", f"gen-base/{version}".encode())
                    fact = filing.read_filing(xml, "scope.xhtml")["facts"][0]
                    self.assertIsNone(fact["value"])
                    self.assertIn("error", fact)

    def test_unknown_mixed_and_ambiguous_scope_segments_are_excluded(self):
        marker = '<se-gen-base:RedovisningInformationJuridiskPersonSegment/>'
        members = [
            '<test:RedovisningInformationJuridiskPersonSegment/>',
            '<se-gen-base:RedovisningInformationUnknownSegment/>',
            marker + '<se-gen-base:RedovisningInformationKoncernSegment/>',
            marker + marker,
            'unknown scope' + marker,
            marker + 'unknown scope',
            marker + '<xbrldi:explicitMember dimension="test:Group">test:Parent</xbrldi:explicitMember>',
            '<se-gen-base:RedovisningInformationJuridiskPersonSegment>company</se-gen-base:RedovisningInformationJuridiskPersonSegment>',
            '<se-gen-base:RedovisningInformationJuridiskPersonSegment test:extra="company"/>',
            '<se-gen-base:RedovisningInformationJuridiskPersonSegment><test:Child/></se-gen-base:RedovisningInformationJuridiskPersonSegment>',
            '',
        ]
        for member in members:
            with self.subTest(member=member):
                contexts = CONTEXT.replace('</xbrli:entity>', f'<xbrli:segment>{member}</xbrli:segment></xbrli:entity>')
                fact = self.read(numeric("123"), contexts=contexts)["facts"][0]
                self.assertIsNone(fact["reportingScope"])
                self.assertIn("error", fact)
        scenario = CONTEXT.replace('</xbrli:context>', f'<xbrli:scenario>{marker}</xbrli:scenario></xbrli:context>')
        self.assertIn("error", self.read(numeric("123"), contexts=scenario)["facts"][0])

    def test_continuations_exclude_text_and_do_not_double_count(self):
        body = '<ix:nonNumeric name="test:Description" contextRef="duration" continuedAt="one">Hello <ix:exclude>skip</ix:exclude><span>world</span></ix:nonNumeric><ix:continuation id="one" continuedAt="two"> and </ix:continuation><ix:continuation id="two">Sweden.</ix:continuation>'
        result = self.read(body)
        self.assertEqual(len(result["facts"]), 1)
        self.assertEqual(result["facts"][0]["text"], "Hello world and Sweden.")

    def test_missing_duplicate_cyclic_continuations(self):
        for continuations in ["", '<ix:continuation id="one">text</ix:continuation>' * 2, '<ix:continuation id="one" continuedAt="one">text</ix:continuation>']:
            with self.subTest(continuations=continuations):
                fact = self.read('<ix:nonNumeric name="test:Description" contextRef="duration" continuedAt="one">Hello</ix:nonNumeric>' + continuations)["facts"][0]
                self.assertIn("error", fact)

    def test_numeric_continuations_and_fractions_are_explicitly_unsupported(self):
        fact = self.read(numeric("1", continuedAt="one") + '<ix:continuation id="one">23</ix:continuation>')["facts"][0]
        self.assertIsNone(fact["value"])
        self.assertIn("continuation", fact["error"])
        fact = self.read(numeric("123").replace("nonFraction", "fraction"))["facts"][0]
        self.assertIsNone(fact["value"])
        self.assertIn("fraction", fact["error"])

    def test_local_namespace_rebinding(self):
        result = self.read(numeric("10") + '<span xmlns:se-gen-base="urn:other">' + numeric("20") + '</span>' + numeric("30"))
        self.assertEqual([fact["namespace"] for fact in result["facts"]], ["http://www.taxonomier.se/se/fr/gen-base/2020-12-01", "urn:other", "http://www.taxonomier.se/se/fr/gen-base/2020-12-01"])
        fact = self.read(numeric("1", name="undeclared:Amount"))["facts"][0]
        self.assertIsNone(fact["value"])
        self.assertIn("QName", fact["error"])

    def test_zip_keeps_annual_and_audit_provenance(self):
        data = archive([("audit.xhtml", document(numeric("99"), title="Revisionsberättelse")), ("annual.xhtml", document(numeric("123")))])
        result = filing.read_filing(data, "company.zip")
        self.assertEqual([doc["kind"] for doc in result["documents"]], ["audit", "annual"])
        self.assertEqual([fact["documentIndex"] for fact in result["facts"]], [0, 1])
        self.assertEqual(len(result["periods"]), 1)

    def test_unknown_document_stays_unknown(self):
        data = document(numeric("123"), title="Statement").replace(b'xmlns:se-gen-base="http://www.taxonomier.se/se/fr/gen-base/2020-12-01"', b'xmlns:se-gen-base="urn:unknown"')
        result = filing.read_filing(data, "unknown.xhtml")
        self.assertEqual(result["documents"][0]["kind"], "unknown")
        self.assertTrue(result["warnings"])

    def test_document_kind_uses_facts_not_unused_namespace_declarations(self):
        data = document(numeric("123"), extra='xmlns:far="http://www.far.se/se/fr/ar/2017-09-30"')
        self.assertEqual(filing.read_filing(data, "annual.xhtml")["documents"][0]["kind"], "annual")

    def test_audit_fact_wins_over_annual_title(self):
        body = '<ix:nonNumeric name="far:Revisionsberattelse" contextRef="duration">Opinion</ix:nonNumeric>'
        data = document(body, title="Årsredovisning", extra='xmlns:far="http://www.far.se/se/fr/ar/2017-09-30"')
        self.assertEqual(filing.read_filing(data, "report.xhtml")["documents"][0]["kind"], "audit")

    def test_combined_annual_statement_with_audit_facts_uses_gaap_and_gen_base_evidence(self):
        body = (numeric("123")
                + '<ix:nonNumeric name="far:Revisionsberattelse" contextRef="duration">Opinion</ix:nonNumeric>'
                + '<link:schemaRef xlink:type="simple" xlink:href="http://xbrl.taxonomier.se/se/fr/gaap/k2/risbs/2021-10-31/test.xsd"/>')
        data = document(body, title="Company", extra=(
            'xmlns:far="http://www.far.se/se/fr/ar/2017-09-30" '
            'xmlns:link="http://www.xbrl.org/2003/linkbase" '
            'xmlns:xlink="http://www.w3.org/1999/xlink"'))
        self.assertEqual(filing.read_filing(data, "combined.xhtml")["documents"][0]["kind"], "annual")

    def test_audit_facts_with_gaap_reference_but_no_gen_base_facts_stay_audit(self):
        body = ('<ix:nonNumeric name="far:Revisionsberattelse" contextRef="duration">Opinion</ix:nonNumeric>'
                + '<link:schemaRef xlink:type="simple" xlink:href="http://xbrl.taxonomier.se/se/fr/gaap/k2/risbs/2021-10-31/test.xsd"/>')
        data = document(body, title="Årsredovisning", extra=(
            'xmlns:far="http://www.far.se/se/fr/ar/2017-09-30" '
            'xmlns:link="http://www.xbrl.org/2003/linkbase" '
            'xmlns:xlink="http://www.w3.org/1999/xlink"'))
        self.assertEqual(filing.read_filing(data, "audit.xhtml")["documents"][0]["kind"], "audit")

    def test_stray_gen_base_fact_without_gaap_schema_stays_audit(self):
        body = (numeric("123")
                + '<ix:nonNumeric name="far:Revisionsberattelse" contextRef="duration">Opinion</ix:nonNumeric>')
        data = document(body, title="Company", extra='xmlns:far="http://www.far.se/se/fr/ar/2017-09-30"')
        self.assertEqual(filing.read_filing(data, "audit.xhtml")["documents"][0]["kind"], "audit")

    def test_explicit_audit_title_wins_over_annual_facts_and_gaap_schema(self):
        body = (numeric("123")
                + '<ix:nonNumeric name="far:Revisionsberattelse" contextRef="duration">Opinion</ix:nonNumeric>'
                + '<link:schemaRef xlink:type="simple" xlink:href="http://xbrl.taxonomier.se/se/fr/gaap/k2/risbs/2021-10-31/test.xsd"/>')
        data = document(body, title="Revisionsberättelse", extra=(
            'xmlns:far="http://www.far.se/se/fr/ar/2017-09-30" '
            'xmlns:link="http://www.xbrl.org/2003/linkbase" '
            'xmlns:xlink="http://www.w3.org/1999/xlink"'))
        self.assertEqual(filing.read_filing(data, "audit.xhtml")["documents"][0]["kind"], "audit")

    def test_audit_title_remains_audit_without_audit_facts(self):
        self.assertEqual(self.read(numeric("123"), title="Revisionsberättelse")["documents"][0]["kind"], "audit")

    def test_original_html_and_inserted_evidence_ids(self):
        body = '<!-- <ix:nonFraction>fake</ix:nonFraction> --><script><![CDATA["<ix:nonFraction>"]]></script>' + numeric("123", id="existing") + numeric("456") + numeric("789", id="")
        data = document(body)
        result = filing.read_filing(data, "sample.xhtml")
        doc = result["documents"][0]
        self.assertEqual(doc["html"], data.decode("utf-8"))
        self.assertEqual(doc["sha256"], hashlib.sha256(data).hexdigest())
        self.assertEqual(result["facts"][0]["elementId"], "existing")
        parsed_viewer = ET.fromstring(doc["viewerHtml"])
        self.assertEqual([element.get("id") for element in parsed_viewer.iter(f"{{{filing.IX}}}nonFraction")], [fact["elementId"] for fact in result["facts"]])
        for fact in result["facts"][1:]:
            identifier = fact["elementId"]
            self.assertIn(f'id="{identifier}"', doc["viewerHtml"])
        restored = doc["viewerHtml"].replace(' id="statement-audit-0-1"', '').replace('id="statement-audit-0-2"', 'id=""')
        self.assertEqual(restored, doc["html"])

    def test_viewer_handles_custom_ix_prefix_and_self_closing_nil(self):
        data = document(numeric("", **{"xsi:nil": "true"})).replace(b"ix:", b"inline:").replace(b"xmlns:ix=", b"xmlns:inline=").replace(b'></inline:nonFraction>', b'/>')
        result = filing.read_filing(data, "sample.xhtml")
        self.assertIn(result["facts"][0]["elementId"], result["documents"][0]["viewerHtml"])
        ET.fromstring(result["documents"][0]["viewerHtml"])

    def test_dtd_entity_expansion_rejected_in_utf8_and_utf16(self):
        for declaration in ['<!DOCTYPE html SYSTEM "https://example.invalid/xhtml.dtd">', '<!DOCTYPE html [<!ENTITY a "boom">]>']:
            text = document().decode("utf-8").replace('<html ', declaration + '<html ', 1)
            for encoding in ["utf-8", "utf-16"]:
                with self.subTest(declaration=declaration, encoding=encoding):
                    with self.assertRaisesRegex(ValueError, "DTD"):
                        filing.read_filing(text.encode(encoding), "sample.xhtml")

    def test_plain_html_doctype_in_prolog_preserves_original_evidence_and_facts(self):
        plain = document(numeric("123"))
        original = plain.decode("utf-8").replace('<html ', '<!DOCTYPE html>\n<html ', 1)
        expected = filing.read_filing(plain, "sample.xhtml")["facts"]
        for encoding in ("utf-8", "utf-8-sig", "utf-16", "utf-32"):
            with self.subTest(encoding=encoding):
                data = original.encode(encoding)
                with patch.object(filing.ET, "iterparse", wraps=filing.ET.iterparse) as parser:
                    result = filing.read_filing(data, "sample.xhtml")
                self.assertNotIn("<!DOCTYPE", parser.call_args.args[0].getvalue())
                doc = result["documents"][0]
                self.assertEqual(doc["html"], filing._decode(data))
                self.assertEqual(doc["sha256"], hashlib.sha256(data).hexdigest())
                self.assertIn("<!DOCTYPE html>", doc["viewerHtml"])
                self.assertEqual(result["facts"], expected)

    def test_plain_html_doctype_without_xml_declaration_is_supported(self):
        data = document(numeric("123")).split(b"?>", 1)[1]
        result = filing.read_filing(b'<!DOCTYPE html>\n' + data, "sample.xhtml")
        self.assertEqual(result["facts"][0]["value"], 123)

    def test_doctype_allowlist_never_allows_subsets_external_ids_or_entity_declarations(self):
        declarations = [
            '<!DOCTYPE html []>', '<!DOCTYPE html [<!ENTITY a "boom">]>',
            '<!DOCTYPE html SYSTEM "file:///secret">',
            '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "https://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">',
            '<!DOCTYPE html>\n<!ENTITY a "boom">', '<!DOCTYPE html>\n<!DOCTYPE html>',
            '<!DOCTYPE html>\n<!DOCTYPE html [<!ENTITY % a SYSTEM "https://example.invalid/evil">%a;]>',
            '<!doctype html>', '<!DOCTYPE HTML>', '<!DOCTYPE html SYSTEM "about:legacy-compat">',
        ]
        for declaration in declarations:
            text = document().decode("utf-8").replace('<html ', declaration + '<html ', 1)
            for encoding in ("utf-8", "utf-16"):
                with self.subTest(declaration=declaration, encoding=encoding), patch.object(filing.ET, "iterparse") as parser:
                    with self.assertRaisesRegex(ValueError, "DTD"):
                        filing.read_filing(text.encode(encoding), "sample.xhtml")
                    parser.assert_not_called()

    def test_plain_doctype_inside_document_is_rejected(self):
        for body in ('<!DOCTYPE html>', '<!-- <!DOCTYPE html> -->', '<![CDATA[<!DOCTYPE html>]]>'):
            with self.subTest(body=body), self.assertRaisesRegex(ValueError, "DTD"):
                self.read(body)

    def test_plain_doctype_does_not_enable_html_named_entities(self):
        for entity in ("&nbsp;", "&unknown;"):
            data = document(numeric("123") + f'<p>{entity}</p>').replace(b'<html ', b'<!DOCTYPE html><html ', 1)
            with self.subTest(entity=entity), self.assertRaisesRegex(ValueError, "Invalid XHTML"):
                filing.read_filing(data, "sample.xhtml")

    def test_malformed_xml_and_non_xhtml_are_rejected(self):
        for data in [b"<html>", b"<html/>", document().replace(b"</html>", b""), b"<html xmlns='urn:bad'/>" ]:
            with self.subTest(data=data[:30]):
                with self.assertRaises(ValueError):
                    filing.read_filing(data, "sample.xhtml")

    def test_xml_depth_and_namespace_bounds(self):
        with self.assertRaisesRegex(ValueError, "depth limits"):
            self.read("<div>" * 260 + "text" + "</div>" * 260)
        with self.assertRaisesRegex(ValueError, "namespace scope limit"):
            self.read(extra=" ".join(f'xmlns:prefix{i}="urn:ns{i}"' for i in range(130)))

    def test_upload_and_expanded_bounds(self):
        with patch.object(filing, "MAX_UPLOAD", 10):
            with self.assertRaisesRegex(ValueError, "20 MB"):
                filing.read_filing(document(), "sample.xhtml")
        with patch.object(filing, "MAX_EXPANDED", 10):
            with self.assertRaisesRegex(ValueError, "50 MB"):
                filing.read_filing(archive([("sample.xhtml", document())]), "company.zip")
        with patch.object(filing, "MAX_FILES", 1):
            with self.assertRaisesRegex(ValueError, "100 entry"):
                filing.read_filing(archive([("a.xhtml", document()), ("b.xhtml", document())]), "company.zip")

    def test_nested_zip_and_unsafe_paths_rejected(self):
        for name, match in [("company.zip", "inner ZIP"), ("../sample.xhtml", "unsafe"), ("/sample.xhtml", "unsafe"), ("C:/sample.xhtml", "unsafe"), ("..\\sample.xhtml", "unsafe")]:
            with self.subTest(name=name):
                with self.assertRaisesRegex(ValueError, match):
                    filing.read_filing(archive([(name, document())]), "company.zip")

    def test_ignored_entries_and_empty_bad_zip(self):
        result = filing.read_filing(archive([("readme.txt", "hello"), ("accounts.xhtml", document())]), "company.zip")
        self.assertIn("readme.txt", result["warnings"][0])
        for data in [b"not a zip", archive([("a.txt", "text")]), b""]:
            with self.subTest(data=data[:20]):
                with self.assertRaises(ValueError):
                    filing.read_filing(data, "company.zip")


if __name__ == "__main__":
    unittest.main()
