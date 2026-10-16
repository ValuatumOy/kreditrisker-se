import copy
import unittest
from decimal import Decimal

from compare import compare
from formulas import Amount
from test_compare import SALES, END, NS, fact, filing, bundle


class SourceFormulaTest(unittest.TestCase):
    def row(self, formula, facts, value=0, definitions=None, backend=None, kind="duration", unit="SEK"):
        metric = {**SALES, "variable": "test", "sourceFormula": formula, "kind": kind, "unit": unit}
        config = {"namespacePrefix": NS.rsplit("/", 1)[0] + "/", "metrics": [metric],
                  "sourceDefinitions": definitions or {}}
        return compare(filing(*facts), backend or bundle(test=value / (100 if unit == "percent" else 1e6)),
                       "", END, config)["rows"][0]

    def test_sum_is_source_only_and_preserves_all_anchors(self):
        facts = [fact(10000, localName="A", elementId="a"), fact(2000, localName="B", elementId="b")]
        row = self.row("[A] - [B]", facts, 8000)
        self.assertEqual(row["sourceBackendStatus"], "match")
        self.assertEqual(row["official"]["status"], "calculated")
        self.assertEqual({f["elementId"] for f in row["official"]["selectedFacts"]}, {"a", "b"})
        self.assertEqual(self.row("[A] - [B]", facts, 8002)["sourceBackendStatus"], "difference")
        self.assertEqual(row["official"]["precisionInterval"], [7999, 8001])

    def test_repeated_source_cancels_its_own_rounding_error(self):
        row = self.row("[A] - [A]", [fact(10000, localName="A", decimals=-3)], 1)
        self.assertEqual(row["official"]["precisionInterval"], [0, 0])
        self.assertEqual(row["sourceBackendStatus"], "difference")

    def test_missing_component_is_only_a_visible_manual_example(self):
        row = self.row("[A] + [Absent]", [fact(10000, localName="A")], 10000)
        self.assertEqual(row["official"]["value"], 10000)
        self.assertIn("Absent", " ".join(row["official"]["assumptions"]))
        self.assertEqual(row["sourceBackendStatus"], "manual")
        row = self.row("[Absent] + 0", [], 0)
        self.assertIsNone(row["official"]["value"])
        self.assertEqual(row["sourceBackendStatus"], "unavailable")

    def test_invalid_fact_is_not_treated_as_an_omitted_zero(self):
        for change in ({"unit": "EUR"}, {"entity": "5555555555"}, {"dimensions": {"axis": "group"}},
                       {"namespace": "http://untrusted.example"}, {"error": "nil", "value": None},
                       {"error": "Missing context reference", "contextId": None, "start": None, "end": None},
                       {"reportingScope": "group"}, {"decimals": None}):
            with self.subTest(change=change):
                row = self.row("[A] + [B]", [fact(10, localName="A"), {**fact(2, localName="B"), **change}], 10)
                self.assertEqual(row["sourceBackendStatus"], "manual")
                self.assertIsNone(row["official"]["value"])

    def test_if_only_reads_selected_branch_but_keeps_condition_evidence(self):
        row = self.row("if([A] != 0, [A] - [B], [Absent])",
                       [fact(10, localName="A"), fact(2, localName="B")], 8)
        self.assertEqual(row["sourceBackendStatus"], "match")
        self.assertFalse(row["official"]["assumptions"])
        self.assertEqual(len(row["official"]["selectedFacts"]), 2)

    def test_rounded_zero_condition_is_not_an_exact_zero(self):
        row = self.row("if([A] == 0, 7, 9)", [fact(0, localName="A", decimals=-3)], 7)
        self.assertEqual(row["sourceBackendStatus"], "manual")
        row = self.row("if([A] == 0, 7, [Absent])", [fact(0, localName="A", decimals="INF")], 7)
        self.assertEqual(row["sourceBackendStatus"], "match")

    def test_boolean_short_circuit_and_threshold(self):
        row = self.row("if(([A] == 0) || ([A] - [B] >= 0.99*[C]), [C], 0)",
                       [fact(100, localName="A"), fact(60, localName="B"), fact(30, localName="C")], 30)
        self.assertEqual(row["sourceBackendStatus"], "match")
        row = self.row("if(([A] != 0) && ([Absent] > 2), 8, 0)",
                       [fact(0, localName="A", decimals="INF")], 0)
        self.assertEqual(row["sourceBackendStatus"], "match")

    def test_ratio_precision_and_zero_denominator(self):
        facts = [fact(100, localName="A", decimals="INF"), fact(20, localName="B", decimals="INF")]
        self.assertEqual(self.row("100*[A]/[B]", facts, 500, unit="percent")["sourceBackendStatus"], "match")
        self.assertEqual(self.row("100*[A]/[B]", facts, 501, unit="percent")["sourceBackendStatus"], "difference")
        for denominator in (0, 1):
            row = self.row("[A]/[B]", [fact(10, localName="A"), fact(denominator, localName="B", decimals=-3)])
            self.assertEqual(row["sourceBackendStatus"], "manual")
            self.assertIsNone(row["official"]["value"])

    def test_variable_reference_uses_source_not_api_values(self):
        definitions = {"component": {"concepts": ["A"], "sourceSign": -1}}
        row = self.row('v("component") + [A]', [fact(10, localName="A")], 0, definitions)
        self.assertEqual(row["sourceBackendStatus"], "match")
        self.assertEqual(row["official"]["precisionInterval"], [0, 0])
        unknown = self.row('v("unknown")', [], 0)
        self.assertEqual(unknown["sourceBackendStatus"], "manual")
        self.assertIn("unknown", unknown["official"]["note"])

    def test_prior_year_uses_exact_prior_metadata_and_original_facts(self):
        backend = bundle(test=0.1)
        backend["modeldata"]["dataMap"]["2024"] = {"cr_fiscal_year_end": 20250630, "cr_fiscal_period_length": 12, "a": 9999}
        prior = fact(100, localName="A", start="2024-07-01", end="2025-06-30", elementId="prior", decimals="INF")
        current = fact(110, localName="A", decimals="INF")
        row = self.row('100*([A]/fact("A",-1)-1)', [prior, current], backend=backend, unit="percent")
        self.assertEqual(row["official"]["value"], 10)
        self.assertEqual({f["elementId"] for f in row["official"]["selectedFacts"]}, {"prior", current["elementId"]})
        bad = copy.deepcopy(backend)
        bad["modeldata"]["dataMap"]["2024"]["cr_fiscal_year_end"] = 20240630
        self.assertEqual(self.row('fact("A",-1)', [prior], backend=bad)["sourceBackendStatus"], "manual")

    def test_cycles_unknown_operators_and_code_execution_are_rejected(self):
        row = self.row('v("cycle")', [], definitions={"cycle": {"sourceFormula": 'v("cycle")'}})
        self.assertEqual(row["sourceBackendStatus"], "manual")
        for formula in ('__import__("os")', '(1).__class__', '[x for x in (1,2)]', '2**3', 'lambda:1',
                        'fact("A",1)', 'choose(1,2,3)', 'open("x")'):
            with self.subTest(formula=formula):
                self.assertEqual(self.row(formula, [fact(2, localName="A")])["sourceBackendStatus"], "manual")

    def test_reference_guard_is_not_lost_through_a_previously_cached_variable(self):
        direct = {**SALES, "key": "a", "variable": "a", "sourceCheck": True, "sourceFormula": "[A]"}
        dependent = {**direct, "key": "b", "variable": "b", "sourceFormula": 'v("a")'}
        config = {"metrics": [direct, dependent], "sourceDefinitions": {"a": {
            "sourceFormula": "[A]", "reviewRequired": "Unverified classification"}}}
        rows = compare(filing(fact(10, localName="A")), bundle(a=0.00001, b=0.00001), "", END, config)["rows"]
        self.assertEqual(rows[0]["sourceBackendStatus"], "match")
        self.assertEqual(rows[1]["sourceBackendStatus"], "manual")
        self.assertIn("Unverified classification", " ".join(rows[1]["official"]["assumptions"]))

    def test_interval_arithmetic_contains_all_endpoint_results(self):
        a = Amount.linear(10, {"a": Decimal(1)})
        b = Amount.linear(4, {"b": Decimal("0.5")})
        for operation in (lambda x, y: x.multiply(y), lambda x, y: x.divide(y)):
            out = operation(a, b)
            for x in (a.low, a.high):
                for y in (b.low, b.high):
                    exact = operation(Amount.linear(x), Amount.linear(y)).value
                    self.assertLessEqual(out.low, exact)
                    self.assertGreaterEqual(out.high, exact)


if __name__ == "__main__":
    unittest.main()
