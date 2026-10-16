"""Read-only, bounded reconciliation of filing facts, REST data and published HTML."""

import calendar
import math
import re
from datetime import date, timedelta
from decimal import Decimal
from html.parser import HTMLParser

from formulas import Amount, FormulaError, calculate


def _number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


def _date(value):
    text = str(value or "")
    if re.fullmatch(r"\d{8}(?:\.0)?", text):
        text = text[:8]
        text = f"{text[:4]}-{text[4:6]}-{text[6:]}"
    try:
        return date.fromisoformat(text).isoformat()
    except ValueError:
        return None


def _orgnr(value):
    text = re.sub(r"[\s-]", "", str(value or ""))
    if re.fullmatch(r"16\d{10}", text):
        text = text[2:]
    return text if re.fullmatch(r"\d{10}", text) else None


def _period(bundle, end):
    matches = [(key, raw) for key, raw in bundle.get("modeldata", {}).get("dataMap", {}).items()
               if _date(raw.get("cr_fiscal_year_end")) == end]
    if len(matches) != 1:
        return None, None, None, "manual" if matches else "missing", (
            "Multiple REST rows have this fiscal end." if matches else "No REST row with an explicit matching fiscal end; year keys are not evidence.")
    key, raw = matches[0]
    months = _number(raw.get("cr_fiscal_period_length"))
    if months is None or months != int(months) or not 1 <= months <= 36:
        return raw, None, None, "manual", "REST fiscal period length is missing or invalid."
    end_date = date.fromisoformat(end)
    year, month0 = divmod(end_date.year * 12 + end_date.month - int(months), 12)
    if end_date.day != calendar.monthrange(end_date.year, end_date.month)[1]:
        return raw, None, int(months), "manual", "Non-month-end REST period requires a verified start date."
    return raw, date(year, month0 + 1, 1).isoformat(), int(months), "reported", f"REST row {key}; explicit fiscal end and length."


class _Node:
    def __init__(self, tag="", attrs=()):
        self.tag, self.attrs, self.children = tag, dict(attrs), []

    def has_class(self, name):
        return name in (self.attrs.get("class") or "").split()

    def all(self, tag=None):
        for child in self.children:
            if isinstance(child, _Node):
                if tag is None or child.tag == tag:
                    yield child
                yield from child.all(tag)

    def text(self):
        classes = (self.attrs.get("class") or "").split()
        if self.tag in ("script", "style") or "hidden" in self.attrs or self.attrs.get("aria-hidden") == "true" or any(
                token in ("visually-hidden", "sr-only", "tip", "tooltip") or token.startswith("tip__") for token in classes):
            return ""
        return "".join(child.text() if isinstance(child, _Node) else child for child in self.children)


class _HTML(HTMLParser):
    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.root = _Node()
        self.stack = [self.root]
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        node = _Node(tag, attrs)
        self.stack[-1].children.append(node)
        if tag not in {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.stack[-1].children.append(_Node(tag, attrs))

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                break

    def handle_data(self, text):
        self.stack[-1].children.append(text)


def _text(value):
    return " ".join(value.split())


def _website_rows(html, label):
    result = []
    for figure in _HTML(html or "").root.all("figure"):
        if not figure.has_class("ft"):
            continue
        for table in figure.all("table"):
            headers = []
            header_rows = []
            for head in table.all("thead"):
                header_rows.extend(head.all("tr"))
                for header_row in head.all("tr"):
                    header_cells = [n for n in header_row.children if isinstance(n, _Node) and n.tag == "th"]
                    for cell in header_cells[1:]:
                        years = [n for n in cell.all() if n.has_class("ft__y")]
                        period_text = " ".join(n.text() for n in cell.all() if n.has_class("ft__p"))
                        headers.append((_text(years[0].text()) if years else None, _text(period_text), len(years), cell.attrs))
            indexes = [i for i, h in enumerate(headers) if h[0] == label]
            group = ""
            for row in table.all("tr"):
                cells = [n for n in row.children if isinstance(n, _Node) and n.tag in ("th", "td")]
                groups = [n for n in cells if n.attrs.get("scope") == "rowgroup"]
                if groups:
                    group = _text(groups[0].text())
                labels = [n for n in cells if n.tag == "th" and n.attrs.get("scope") == "row"]
                if not labels:
                    continue
                values = [n for n in cells if n.tag == "td"]
                if len(indexes) != 1 or len(labels) != 1:
                    if indexes:
                        result.append((_text(labels[0].text()), None, group, "Ambiguous website period headers or row label.",
                                       "", {}, row.attrs.get("data-metric-key")))
                    continue
                index = indexes[0]
                header = headers[index]
                note = "" if len(header_rows) == 1 and all(h[2] == 1 for h in headers) and len(values) == len(headers) else "Ambiguous website fiscal labels or cell order."
                result.append((_text(labels[0].text()), _text(values[index].text()) if index < len(values) else None, group,
                               note, header[1], {**header[3], "data-orgnr": figure.attrs.get("data-orgnr")},
                               row.attrs.get("data-metric-key")))
    return result


def _website(metric, rows, months, orgnr, start, end):
    group_prefix = _text(metric.get("websiteGroup", ""))
    keyed = any(r[6] is not None for r in rows)
    matches = ([r for r in rows if r[6] == metric["key"]] if keyed else
               [r for r in rows if r[0] == _text(metric["label"]) and (not group_prefix or r[2].startswith(group_prefix))])
    out = {"value": None, "status": "missing", "note": "Published FinancialTable row or exact fiscal column is absent.", "text": None}
    if not matches:
        return out
    if len(matches) != 1 or matches[0][3]:
        return {**out, "status": "manual", "note": matches[0][3] or "Multiple published rows have this label and period."}
    visible_label, text, group, _, header, metadata, metric_key = matches[0]
    if keyed and (visible_label != _text(metric["label"]) or (group_prefix and not group.startswith(group_prefix))):
        return {**out, "status": "manual", "note": "Published metric key has a different visible label or statement group."}
    out["keyVerified"] = keyed
    out["text"] = text
    metadata_notes = []
    if not orgnr or _orgnr(metadata.get("data-orgnr")) != orgnr:
        metadata_notes.append("Published table company identity is missing, unknown or different.")
    if not start or _date(metadata.get("data-period-start")) != start or _date(metadata.get("data-period-end")) != end:
        metadata_notes.append("Published exact fiscal start/end metadata is missing, unknown or different.")
    period_months = metadata.get("data-period-months") or ""
    if not re.fullmatch(r"[1-9]\d?", period_months) or int(period_months) != months:
        metadata_notes.append("Published fiscal length metadata is missing, unknown or different.")
    if metadata.get("data-consolidated") != "false" or "koncern" in header.lower():
        metadata_notes.append("Published consolidation scope is unknown or consolidated.")
    header_months = re.search(r"(\d+)\s*mån", header)
    if header_months and int(header_months[1]) != months:
        metadata_notes.append("Website visible fiscal duration differs from REST.")
    if text is None or text.lower() in ("saknas", "–", "—", "-", "ej jämförbar", "ej tillämpligt"):
        return {**out, "status": "manual" if metadata_notes else "missing", "note": " ".join(metadata_notes) or "Published value is missing or not comparable."}
    if metric["unit"] == "SEK" and not re.search(r"\btkr\b", group, re.I):
        return {**out, "status": "manual", "note": "Published monetary group does not declare tkr."}
    if metric["unit"] == "people" and group != "Nyckeltal":
        return {**out, "status": "manual", "note": "Published employee count is not in Nyckeltal."}
    if metric["unit"] == "percent" and group != "Nyckeltal":
        return {**out, "status": "manual", "note": "Published percentage is not in Nyckeltal."}
    number = re.sub(r"[\s\u00a0\u202f]", "", text).replace("−", "-").replace(",", ".")
    if metric["unit"] == "percent":
        if not number.endswith("%"):
            return {**out, "status": "manual", "note": "Published percentage cell does not declare %."}
        number = number[:-1]
    if not re.fullmatch(r"[+-]?\d+(?:\.\d+)?", number):
        return {**out, "status": "manual", "note": "Published cell is not an unambiguous Swedish number."}
    value = float(number) * (1000 if metric["unit"] == "SEK" else 1)
    if not math.isfinite(value):
        return {**out, "status": "manual", "note": "Published cell exceeds the supported numeric range."}
    return {**out, "value": value, "status": "manual" if metadata_notes else "reported",
            "note": " ".join(metadata_notes) or "Parsed from published FinancialTable HTML; exact company and fiscal metadata verified."}


def _unit(unit, expected):
    if not isinstance(unit, str):
        return False
    if expected == "SEK":
        return unit == "SEK" or unit == "iso4217:SEK" or (unit.startswith("{") and unit.endswith("}SEK") and "iso4217" in unit)
    return unit in ("people", "pure", "xbrli:pure", "{http://www.xbrl.org/2003/instance}pure", "se-k3-type:AntalPersoner") or (
        unit.startswith("{http://www.taxonomier.se/") and unit.endswith("}AntalPersoner"))


def _tolerance(fact):
    decimals = fact.get("decimals")
    if isinstance(decimals, int) and not isinstance(decimals, bool) and -100 <= decimals <= 100:
        return Decimal(10) ** -decimals / 2
    if decimals == "INF" or fact.get("decimalsRaw") == "INF" or fact.get("decimalsExact") is True:
        return Decimal(0)
    return None


def _official(metric, facts, documents, orgnr, start, end, metadata_ok, consolidated):
    out = {"value": None, "unit": metric["unit"], "facts": [], "selectedFact": None, "status": "missing", "note": "No eligible official fact; absence does not establish zero."}
    if metric.get("sourceCheck") is False:
        return {**out, "status": "not_checked", "note": metric.get("sourceUnresolved") or "Original filing mapping is not verified for this metric; only REST to website is checked."}, None
    if not metric.get("concepts"):
        return {**out, "status": "manual", "note": "No direct official concept configured; a calculated subtotal needs manual review."}, None
    relevant = [f for f in facts if f.get("localName") in metric["concepts"]]
    annual = [f for f in relevant if isinstance(f.get("documentIndex"), int) and 0 <= f["documentIndex"] < len(documents)
              and documents[f["documentIndex"]].get("kind") == "annual"]
    out["facts"] = annual
    if any(f.get("error") and not (f.get("instant") or (f.get("start") and f.get("end"))) for f in annual):
        return {**out, "status": "manual", "note": "Official fact has an invalid or missing context; its fiscal period cannot be established."}, None
    if consolidated or not orgnr:
        return {**out, "status": "manual", "note": "Consolidated or unknown backend entity requires manual review."}, None
    if metric["kind"] == "duration" and not metadata_ok:
        return {**out, "status": "manual", "note": "Cannot select an exact official duration without explicit REST period metadata."}, None
    period_facts = [f for f in annual if (f.get("instant") == end if metric["kind"] == "instant"
                                         else f.get("start") == start and f.get("end") == end and not f.get("instant"))]
    segmented_documents = {f.get("documentIndex") for f in facts if f.get("reportingScope") in {"company", "group", "general"}}
    eligible = [f for f in period_facts if _orgnr(f.get("entity")) == orgnr and not f.get("dimensions") and f.get("contextId")
                and (f.get("reportingScope", "unsegmented") == "company" or
                     (f.get("reportingScope", "unsegmented") == "unsegmented" and f.get("documentIndex") not in segmented_documents))]
    if not eligible:
        if period_facts:
            return {**out, "status": "manual", "note": "Matching-period facts have the wrong/unknown entity, company/group scope, dimensions or unknown context."}, None
        if metric["key"] == "grossProfit":
            return {**out, "status": "manual", "note": "Gross profit has no direct official fact; the backend subtotal may be calculated."}, None
        return out, None
    out["facts"] = eligible
    entity_facts = [f for f in facts if isinstance(f.get("documentIndex"), int) and 0 <= f["documentIndex"] < len(documents)
                    and documents[f["documentIndex"]].get("kind") == "annual"]
    entities = {_orgnr(f.get("entity")) for f in entity_facts if _orgnr(f.get("entity"))}
    if len(entities) > 1:
        return {**out, "status": "manual", "note": "Annual documents contain multiple entities."}, None
    if any(not f.get("namespace") or (metric.get("namespacePrefix") and not f["namespace"].startswith(metric["namespacePrefix"]))
           or not _unit(f.get("unit"), metric["unit"]) for f in eligible):
        return {**out, "status": "manual", "note": "Official namespace or unit is unknown or mismatched."}, None
    if any(f.get("error") or _number(f.get("value")) is None for f in eligible):
        return {**out, "status": "manual", "note": "Official fact is nil or failed numeric parsing."}, None
    if len({(f.get("namespace"), f.get("localName")) for f in eligible}) > 1:
        return {**out, "status": "manual", "note": "Multiple official concepts match this metric; their equivalence is unverified."}, None
    intervals = []
    for f in eligible:
        tolerance = _tolerance(f)
        if tolerance is None:
            return {**out, "status": "manual", "note": "Official decimal precision is undeclared; no rounding tolerance is assumed."}, None
        value = Decimal(str(f["value"]))
        intervals.append((value - tolerance, value + tolerance, tolerance, f))
    if max(i[0] for i in intervals) > min(i[1] for i in intervals):
        return {**out, "status": "manual", "note": "Duplicate official facts conflict outside their declared rounding intervals."}, None
    best_precision = min(i[2] for i in intervals)
    if len({Decimal(str(i[3]["value"])) for i in intervals if i[2] == best_precision}) > 1:
        return {**out, "status": "manual", "note": "Equally precise official duplicates disagree; fact order cannot resolve them."}, None
    selected = min(intervals, key=lambda i: i[2])
    sign = metric.get("sourceSign", 1)
    if sign not in (1, -1):
        raise ValueError("Source sign must be 1 or -1")
    note = "Exact entity and period; most precise consistent official fact."
    if sign == -1:
        note += " Official expense sign reversed to the CV signed statement convention; original fact retained."
    return {**out, "value": sign * selected[3]["value"], "sourceSign": sign,
            "selectedFact": selected[3], "status": "reported", "note": note}, selected[2]


def _backend(metric, raw, state, note, currency):
    value = raw.get(metric["variable"]) if raw else None
    out = {"value": None, "status": "missing", "note": note, "raw": value}
    if state != "reported":
        return {**out, "status": state}
    if metric["unit"] == "SEK" and currency != "SEK":
        return {**out, "status": "manual", "note": "Backend currency is not confirmed SEK; no currency conversion is assumed."}
    if value is not None and _number(value) is None:
        return {**out, "status": "manual", "note": "Backend variable is not a finite number."}
    if value is None:
        if metric["unit"] == "people" or not metric.get("zeroWhenAbsent"):
            return {**out, "note": "Backend variable is absent; no zero convention applies."}
        if metric["key"] == "netSales" and (_number(raw.get("cr_gross_profit")) or 0) != 0:
            return {**out, "note": "Net sales is absent with nonzero gross profit; net sales is not verified."}
        return {**out, "value": 0, "status": "zero_omission", "note": "Backend omitted variable interpreted as zero using the CV statement convention."}
    multiplier = {"SEK": 1_000_000, "percent": 100}.get(metric["unit"], 1)
    note = {"SEK": "REST monetary value converted from millions to SEK.",
            "percent": "REST fraction converted to percentage points."}.get(metric["unit"], "REST employee count.")
    return {**out, "value": float(value) * multiplier, "status": "reported", "note": note}


class SourceReader:
    def __init__(self, filing, bundle, metrics, definitions, orgnr, consolidated):
        self.filing, self.bundle = filing, bundle
        self.metrics = {metric["variable"]: metric for metric in metrics}
        self.definitions, self.orgnr, self.consolidated = definitions, orgnr, consolidated
        self.cache, self.active = {}, set()

    def read(self, metric, end):
        cache_key = (metric["key"], metric["variable"], end, metric["unit"], metric["kind"],
                     metric.get("sourceFormula"), tuple(metric.get("concepts", [])),
                     metric.get("sourceSign", 1), metric.get("sourceCheck"), metric.get("namespacePrefix"),
                     metric.get("reviewRequired"), metric.get("sourceUnresolved"))
        if cache_key in self.cache:
            return self.cache[cache_key]
        if cache_key in self.active:
            raise FormulaError("Lähdekaavan riippuvuuksissa on kehä.")
        self.active.add(cache_key)
        try:
            result = self._read(metric, end)
            self.cache[cache_key] = result
            return result
        finally:
            self.active.remove(cache_key)

    def _read(self, metric, end):
        _, start, _, state, _ = _period(self.bundle, end)
        direct_args = (self.filing.get("facts", []), self.filing.get("documents", []), self.orgnr,
                       start, end, state == "reported", self.consolidated)
        formula = metric.get("sourceFormula") if metric.get("sourceCheck") is not False else None
        if not formula:
            out, tolerance = _official(metric, *direct_args)
            amount = None
            if out["value"] is not None and tolerance is not None:
                evidence = out["selectedFact"]
                key = (evidence["documentIndex"], evidence.get("contextId"), evidence.get("namespace"),
                       evidence.get("localName"), evidence.get("elementId"))
                amount = Amount.linear(out["value"], {key: tolerance * metric.get("sourceSign", 1)})
            return out, tolerance, amount
        out = {"value": None, "unit": metric["unit"], "facts": [], "selectedFact": None,
               "selectedFacts": [], "status": "manual", "formula": formula, "assumptions": []}
        if state != "reported" or self.consolidated or not self.orgnr:
            return {**out, "note": "Lähdelaskenta vaatii varmennetun yrityksen ja tarkan tilikauden."}, None, None
        used, issues = {}, set()
        if metric.get("reviewRequired"):
            issues.add(metric["reviewRequired"])

        def period(offset):
            if not offset:
                return end
            previous = (date.fromisoformat(start) - timedelta(days=1)).isoformat()
            if _period(self.bundle, previous)[3] != "reported":
                raise FormulaError("Edeltävän peräkkäisen tilikauden metatietoja ei ole varmistettu.")
            return previous

        def consume(result):
            official, _, amount = result
            for evidence in official.get("selectedFacts") or ([official["selectedFact"]] if official.get("selectedFact") else []):
                key = (evidence.get("documentIndex"), evidence.get("elementId"), evidence.get("contextId"), evidence.get("localName"))
                used[key] = evidence
            issues.update(official.get("assumptions", []))
            if official["status"] == "missing":
                issues.add("Puuttuva lähde-erä vain laskentaesimerkissä nollana: " + ", ".join(official.get("missingConcepts", [])))
                return Amount.linear(0)
            if official["status"] == "manual" and amount is not None:
                issues.add(official["note"])
                return amount
            if official["status"] not in ("reported", "calculated") or amount is None:
                raise FormulaError(official["note"])
            return amount

        def fact(concept, offset):
            target_end = period(offset)
            _, target_start, _, target_state, _ = _period(self.bundle, target_end)
            leaf = {**metric, "key": concept, "concepts": [concept], "unit": "SEK", "sourceSign": 1}
            official, tolerance = _official(leaf, self.filing.get("facts", []), self.filing.get("documents", []),
                self.orgnr, target_start, target_end, target_state == "reported", self.consolidated)
            official["missingConcepts"] = [concept + (" (edeltävä kausi)" if offset else "")]
            amount = None
            if official["value"] is not None and tolerance is not None:
                evidence = official["selectedFact"]
                key = (evidence["documentIndex"], evidence.get("contextId"), evidence.get("namespace"),
                       evidence.get("localName"), evidence.get("elementId"))
                amount = Amount.linear(official["value"], {key: tolerance})
            return consume((official, tolerance, amount))

        def variable(name, offset):
            base = self.metrics.get(name)
            rule = self.definitions.get(name)
            if base is None and rule is None:
                raise FormulaError("Muuttujan lähdemääritelmä puuttuu: " + name)
            dependency = {"key": name, "label": name, "variable": name, "sourceSign": 1, "sourceCheck": True,
                          "namespacePrefix": metric.get("namespacePrefix"), "kind": metric["kind"],
                          "concepts": [], "unit": "SEK", **(base or {}), **(rule or {})}
            if rule:
                dependency["sourceCheck"] = rule.get("sourceCheck", True)
            result = self.read(dependency, period(offset))
            result[0].setdefault("missingConcepts", dependency.get("concepts") or [name])
            return consume(result)

        try:
            amount = calculate(formula, fact, variable, issues.add)
            out.update(selectedFacts=list(used.values()), assumptions=sorted(issues))
            if not used:
                return {**out, "status": "missing", "note": "Laskelmalle ei löytynyt yhtään varmennettua lähdelukua; nollaa ei vahvistettu."}, None, None
            out.update(value=float(amount.value), precisionInterval=[float(amount.low), float(amount.high)],
                       status="manual" if issues else "calculated",
                       note="Laskettu alkuperäisistä lähdeluvuista; osalukujen ilmoitettu tarkkuus säilytetty." + (
                           " Oletuksia tai epävarma ehto: " + " ".join(sorted(issues)) if issues else ""))
            return out, None, amount
        except FormulaError as error:
            return {**out, "selectedFacts": list(used.values()), "assumptions": sorted(issues), "note": str(error)}, None, None


def _leg(left, right, tolerance):
    if left["status"] == "not_checked" or right["status"] == "not_checked":
        return "not_checked", None
    if left["status"] == "manual" or right["status"] == "manual":
        return "manual", None
    if left["value"] is None or right["value"] is None:
        return "unavailable", None
    difference = Decimal(str(right["value"])) - Decimal(str(left["value"]))
    if left.get("status") == "calculated":
        low, high = map(lambda n: Decimal(str(n)), left["precisionInterval"])
        matches = low - Decimal("0.000001") <= Decimal(str(right["value"])) <= high + Decimal("0.000001")
    else:
        matches = abs(difference) <= tolerance + Decimal("0.000001")
    return ("match" if matches else "difference"), float(difference)


def _explain_difference(row, metric, reader, end):
    if row["sourceBackendStatus"] != "difference" or row["official"]["status"] != "reported":
        return
    original, backend = row["official"], row["backend"]["value"]
    _, _, original_amount = reader.read(metric, end)
    tolerance = _tolerance(original["selectedFact"])
    for alternative in original.get("facts", []):
        alternative_tolerance = _tolerance(alternative)
        normalized_alternative = metric.get("sourceSign", 1) * alternative["value"]
        if alternative_tolerance is not None and alternative_tolerance > tolerance and (
                abs(Decimal(str(backend)) - Decimal(str(normalized_alternative))) <= Decimal("0.000001")):
            row.setdefault("reconciliations", []).append({"title": "Pyöristetty rinnakkaisluku",
                "formula": ("-" if metric.get("sourceSign", 1) == -1 else "") + "[" + alternative["localName"] + "]",
                "selectedFacts": [alternative], "value": normalized_alternative,
                "note": "API vastaa asiakirjan karkeammin pyöristettyä rinnakkaislukua. Tarkemman lähdeluvun ero säilyy; API:n lähdevalintaa tämä ei yksin todista."})
            break
    bridges = {
        "totalAssets": ["[Anlaggningstillgangar] + [Omsattningstillgangar]",
                        "[MateriellaAnlaggningstillgangar] + [FinansiellaAnlaggningstillgangar] + [Omsattningstillgangar]"],
        "totalEquityAndLiabilities": ["[EgetKapital] + [ObeskattadeReserver] + [LangfristigaSkulder] + [KortfristigaSkulder]"],
        "netProfit": ["[ResultatEfterFinansiellaPoster] + [Bokslutsdispositioner] + ([AretsResultat] - [ResultatForeSkatt])"],
    }
    for formula in bridges.get(row["key"], []):
        check = {**metric, "key": "bridge_" + metric["key"], "variable": "bridge_" + metric["variable"],
                 "concepts": [], "sourceFormula": formula, "sourceSign": 1, "sourceCheck": True}
        bridge, _, bridge_amount = reader.read(check, end)
        if bridge["status"] == "calculated" and abs(bridge["value"] - backend) <= 0.000001:
            residual = bridge_amount.add(original_amount.scaled(-1))
            if residual.low <= 0 <= residual.high:
                row.setdefault("reconciliations", []).append({**bridge, "title": "Pyöristykseen sopiva osalukulaskelma",
                    "note": "Ilmoitettujen osalukujen laskelma vastaa API:a, ja lähteen pyöristysvälit sopivat suoraan lähdelukuun. Tämä voi selittää eron; se ei vahvista backendin sisäistä kaavaa. Alkuperäinen ero säilyy."})
                break
    for explanation in row.get("reconciliations", []):
        row["note"] += " " + explanation["note"]


def compare(filing, bundle, website_html, period_end, config):
    """Return native SEK/people values and conservative statuses for both comparison legs."""
    definitions = config.get("sourceDefinitions", {}) if isinstance(config, dict) else {}
    if isinstance(config, dict):
        config = [{"namespacePrefix": config.get("namespacePrefix"), **metric} for metric in config["metrics"]]
    md = bundle.get("modeldata", {})
    end = _date(period_end)
    if not end:
        raise ValueError("period_end must be a valid ISO date")
    raw, start, months, state, period_note = _period(bundle, end)
    company_code = md.get("companyCode")
    if company_code is None:
        companies = [c for c in bundle.get("companies", []) if str(c.get("companyId")) == str(md.get("companyId"))]
        company_code = companies[0].get("companyCode") if len(companies) == 1 else None
    consolidated = str(company_code or "").endswith("K")
    orgnr = _orgnr(company_code[:-1] if consolidated else company_code)
    label = end[:4] if not start or start[:4] == end[:4] else f"{start[:4]}/{end[2:4]}"
    website_rows = _website_rows(website_html, label) if start else []
    warnings = list(filing.get("warnings", []))
    if state != "reported":
        warnings.append(period_note)
    if consolidated:
        warnings.append("Backend company code has consolidation suffix K; manual review required.")
    reader = SourceReader(filing, bundle, config, definitions, orgnr, consolidated)
    rows = []
    for metric in config:
        official, tolerance, _ = reader.read(metric, end)
        backend = _backend(metric, raw, state, period_note, md.get("currency"))
        if consolidated:
            backend.update(status="manual", note="Consolidated backend scope requires manual review.")
        website = _website(metric, website_rows, months, orgnr, start, end)
        group_prefix = _text(metric.get("websiteGroup", ""))
        same_scope = [m for m in config if _text(m["label"]) == _text(metric["label"]) and (
            not group_prefix or not m.get("websiteGroup") or group_prefix.startswith(_text(m["websiteGroup"]))
            or _text(m["websiteGroup"]).startswith(group_prefix))]
        if len(same_scope) > 1 and not website.get("keyVerified") and website["status"] != "missing":
            website.update(value=None, status="manual", note="Configured website label is not unique within its statement group.")
        if not start:
            website["note"] = "Cannot verify published fiscal column without explicit REST period metadata."
        source_status, source_difference = _leg(official, backend, tolerance or Decimal(0))
        website_tolerance = (Decimal("0.5") * Decimal(10) ** -metric.get("displayDigits", 1)
                             if metric["unit"] == "percent" else Decimal(500 if metric["unit"] == "SEK" else "0.5"))
        website_status, website_difference = _leg(backend, website, website_tolerance)
        if backend["value"] is None and website["value"] is not None:
            website_status = "manual"
            website["note"] += " Published numeric value has no verified backend counterpart."
        statuses = (source_status, website_status)
        overall = next((s for s in ("difference", "manual", "unavailable") if s in statuses),
                       "manual" if "not_checked" in statuses else "match")
        note = "Both comparison legs match." if overall == "match" else "; ".join(dict.fromkeys(
            item["note"] for item in (official, backend, website) if item["note"]))
        rows.append({"key": metric["key"], "label": metric["label"], "variable": metric["variable"], "unit": metric["unit"],
                     "sourceReviewRequired": metric.get("reviewRequired"),
                     "concepts": metric.get("concepts", []), "official": official, "backend": backend, "website": website,
                     "sourceBackendStatus": source_status, "backendWebsiteStatus": website_status,
                     "differenceSourceBackend": source_difference, "differenceBackendWebsite": website_difference,
                     "status": overall, "note": note})
        _explain_difference(rows[-1], metric, reader, end)
    summary = {status: sum(r["status"] == status for r in rows) for status in ("match", "difference", "manual", "unavailable")}
    summary["total"] = len(rows)
    coverage = {leg: {status: sum(r[field] == status for r in rows)
                     for status in ("match", "difference", "manual", "unavailable", "not_checked")}
                for leg, field in (("sourceBackend", "sourceBackendStatus"), ("backendWebsite", "backendWebsiteStatus"))}
    coverage["total"] = len(rows)
    return {"company": {"name": md.get("companyName"), "orgnr": orgnr, "fid": bundle.get("fid", md.get("followedModelId")),
                        "currency": md.get("currency"), "retrievedAt": bundle.get("retrievedAt")},
            "periodEnd": end, "rows": rows, "summary": summary, "coverage": coverage, "warnings": warnings}
