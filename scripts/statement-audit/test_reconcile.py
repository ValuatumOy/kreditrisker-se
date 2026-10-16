import unittest

from compare import compare
from test_compare import SALES, END, fact, filing, bundle


class DifferenceExplanationTest(unittest.TestCase):
    def check(self, metric, facts, api):
        return compare(filing(*facts), bundle(**{metric["variable"]: api}), "", END, [metric])["rows"][0]

    def test_asset_rounding_bridge_does_not_erase_direct_difference(self):
        metric = {**SALES, "key": "totalAssets", "variable": "bs_total_assets", "concepts": ["Tillgangar"], "kind": "instant"}
        facts = [fact(value, localName=concept, instant=END, start=None, end=None, decimals=-3)
                 for concept, value in (("Tillgangar", 22337000), ("Anlaggningstillgangar", 13416000), ("Omsattningstillgangar", 8922000))]
        row = self.check(metric, facts, 22.338)
        self.assertEqual(row["sourceBackendStatus"], "difference")
        self.assertEqual(row["official"]["value"], 22337000)
        self.assertEqual(row["differenceSourceBackend"], 1000)
        self.assertEqual(row["reconciliations"][0]["value"], 22338000)
        self.assertEqual(len(row["reconciliations"][0]["selectedFacts"]), 2)
        self.assertNotIn("reconciliations", self.check(metric, facts, 22.340))
        facts[1]["entity"] = "5555555555"
        self.assertNotIn("reconciliations", self.check(metric, facts, 22.338))

    def test_asset_bridge_can_explain_rounding_one_level_below_a_subtotal(self):
        metric = {**SALES, "key": "totalAssets", "variable": "bs_total_assets", "concepts": ["Tillgangar"], "kind": "instant"}
        facts = [fact(value, localName=concept, instant=END, decimals=-3) for concept, value in (
            ("Tillgangar", 20682000), ("Anlaggningstillgangar", 16560000), ("Omsattningstillgangar", 4122000),
            ("MateriellaAnlaggningstillgangar", 2607000), ("FinansiellaAnlaggningstillgangar", 13954000))]
        row = self.check(metric, facts, 20.683)
        self.assertEqual(row["sourceBackendStatus"], "difference")
        self.assertEqual(row["reconciliations"][0]["value"], 20683000)
        self.assertEqual(len(row["reconciliations"][0]["selectedFacts"]), 3)

    def test_rounded_alternative_explains_but_retains_precise_difference(self):
        metric = {**SALES, "key": "profitForTheYear", "variable": "cr_profit_for_fy", "concepts": ["AretsResultatEgetKapital"], "kind": "instant"}
        precise = fact(8429503, localName=metric["concepts"][0], instant=END, decimals=0)
        rounded = {**precise, "value": 8430000, "decimals": -3, "elementId": "rounded"}
        row = self.check(metric, [precise, rounded], 8.43)
        self.assertEqual(row["sourceBackendStatus"], "difference")
        self.assertEqual(row["differenceSourceBackend"], 497)
        self.assertEqual(row["official"]["selectedFact"]["value"], 8429503)
        self.assertEqual(row["reconciliations"][0]["selectedFacts"][0]["elementId"], "rounded")
        rounded["value"] = 8500000
        self.assertNotIn("reconciliations", self.check(metric, [precise, rounded], 8.43))

    def test_profit_components_explain_rounding_without_changing_tolerance(self):
        metric = {**SALES, "key": "netProfit", "variable": "cr_net_earnings", "concepts": ["AretsResultat"]}
        facts = [fact(value, localName=concept, decimals=-3) for concept, value in (
            ("AretsResultat", 2583000), ("ResultatEfterFinansiellaPoster", 3032000),
            ("Bokslutsdispositioner", -263000), ("ResultatForeSkatt", 2770000))]
        row = self.check(metric, facts, 2.582)
        self.assertEqual(row["sourceBackendStatus"], "difference")
        self.assertEqual(row["official"]["value"], 2583000)
        self.assertEqual(row["reconciliations"][0]["value"], 2582000)
        self.assertEqual(len(row["reconciliations"][0]["selectedFacts"]), 4)
        facts[1]["value"] = 3031000
        self.assertNotIn("reconciliations", self.check(metric, facts, 2.581))

    def test_rounded_expense_alternative_uses_the_converted_sign(self):
        metric = {**SALES, "key": "expense", "variable": "expense", "concepts": ["Expense"], "sourceSign": -1}
        precise = fact(8429503, localName="Expense", decimals=0)
        rounded = {**precise, "value": 8430000, "decimals": -3, "elementId": "rounded"}
        row = self.check(metric, [precise, rounded], -8.43)
        self.assertEqual(row["sourceBackendStatus"], "difference")
        self.assertEqual(row["reconciliations"][0]["value"], -8430000)
        self.assertEqual(row["reconciliations"][0]["selectedFacts"][0]["value"], 8430000)
        self.assertNotIn("reconciliations", self.check(metric, [precise, rounded], 8.43))


if __name__ == "__main__":
    unittest.main()
