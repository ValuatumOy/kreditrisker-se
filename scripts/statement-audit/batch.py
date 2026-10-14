"""Audit explicitly selected companies and exact fiscal ends without a browser."""
import argparse
from datetime import date, datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import unicodedata

from compare import compare
from filing import read_filing
from official import OfficialFilings
from server import fetch_website

MISSING_FILING = "Yrityksen ja tilikauden digitaalista tilinpäätöstä ei löytynyt Bolagsverketin julkisista viikkopaketeista. Kaikkia tilinpäätöksiä ei ole tässä aineistossa; alkuperäisen tiedoston voi edelleen tuoda käsin."

ROOT = Path(__file__).resolve().parents[2]
STATUSES = ("match", "difference", "manual", "unavailable", "not_checked")


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def organisation(value):
    text = re.sub(r"[\s-]", "", str(value or ""))
    if re.fullmatch(r"16\d{10}", text):
        text = text[2:]
    return text if re.fullmatch(r"\d{10}", text) else None


def fiscal_end(value):
    text = str(value or "")
    if re.fullmatch(r"\d{8}(?:\.0)?", text):
        text = f"{text[:4]}-{text[4:6]}-{text[6:8]}"
    try:
        parsed = date.fromisoformat(text)
        return parsed.isoformat() if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text) else None
    except ValueError:
        return None


def select_company(candidates, query):
    if not isinstance(candidates, list):
        raise ValueError("Yrityshaku ei palauttanut yritysluetteloa.")
    code = organisation(query)
    matches = [c for c in candidates if organisation(c.get("orgnr")) == code] if code else [
        c for c in candidates if str(c.get("name", "")).casefold() == query.casefold()]
    if not code and not matches and len(candidates) == 1:
        matches = candidates
    if (len(matches) != 1 or not organisation(matches[0].get("orgnr"))
            or not re.fullmatch(r"\d+", str(matches[0].get("fid", "")))
            or not isinstance(matches[0].get("name"), str) or not matches[0]["name"].strip()):
        raise ValueError("Yrityshaku ei yksilöinyt yhtä tuontimallia. Käytä tarkkaa yritystunnusta.")
    return {**matches[0], "orgnr": organisation(matches[0]["orgnr"]), "fid": str(matches[0]["fid"])}


def verify_bundle(bundle, expected):
    md = bundle.get("modeldata", {})
    if (organisation(md.get("companyCode")) != expected["orgnr"]
            or str(bundle.get("fid")) != expected["fid"]
            or str(md.get("followedModelId")) != expected["fid"]
            or not isinstance(md.get("dataMap"), dict)):
        raise ValueError("API:n yritystunnus tai tuontimalli ei vastaa valittua yritystä.")
    accounts = {s.strip().casefold() for s in os.environ.get(
        "SE_AUDIT_MODEL_ACCOUNTS", "Data Import,Bolagsverket data import").split(",")}
    companies = [c for c in bundle.get("companies", [])
                 if organisation(c.get("companyCode")) == expected["orgnr"]
                 and str(c.get("companyId")) == str(md.get("companyId"))]
    models = [m for c in companies for m in c.get("models", [])
              if str(m.get("analystName", "")).casefold() in accounts]
    if len(companies) != 1 or len(models) != 1 or str(models[0].get("followedModelId")) != expected["fid"]:
        raise ValueError("API-vastauksessa ei ole yhtä valitun yrityksen tuontimallia.")


def select_periods(bundle, latest=2, requested=None):
    periods = {end for row in bundle["modeldata"]["dataMap"].values()
               if isinstance(row, dict) and (end := fiscal_end(row.get("cr_fiscal_year_end")))}
    if requested:
        result = list(dict.fromkeys(requested))
        if any(fiscal_end(end) != end or end not in periods for end in result):
            raise ValueError("Valittua päättymispäivää ei löydy API:n täsmällisistä tilikausitiedoista.")
        return result
    if not periods:
        raise ValueError("API:ssa ei ole täsmällistä tilikauden päättymispäivää.")
    return sorted(periods, reverse=True)[:latest]


def valuatum(mode, query, cache_dir):
    try:
        response = subprocess.run(["node", "--env-file-if-exists=.env",
            str(Path(__file__).with_name("valuatum.ts")), mode, str(query)], cwd=ROOT,
            capture_output=True, timeout=300, env={**os.environ, "SE_AUDIT_REST_CACHE": str(cache_dir)})
        data = json.loads(response.stdout)
    except (OSError, subprocess.TimeoutExpired, ValueError, UnicodeDecodeError) as exc:
        raise ValueError("Valuatumin API-hakua ei voitu suorittaa. Tarkista paikalliset asetukset.") from exc
    if response.returncode or isinstance(data, dict) and data.get("error"):
        # Raw helper errors may contain server response bodies; never emit them.
        raise ValueError("Valuatumin API-haku epäonnistui. Tarkista osoite, tunnus ja käyttöoikeus.")
    return data


def website_url(origin, company):
    name = company["name"].lower().replace("ø", "o").replace("æ", "ae")
    name = "".join(c for c in unicodedata.normalize("NFKD", name) if not unicodedata.combining(c))
    slug = re.sub(r"[^a-z0-9]+", "-", name).strip("-")[:80].rstrip("-") or "foretag"
    return f"{origin.rstrip('/')}/foretag/{company['orgnr']}/{slug}/"


def counts(report, field):
    return {status: sum(r.get(field) == status for r in report["rows"]) for status in STATUSES}


def report_status(report):
    return next((s for s in ("difference", "manual", "unavailable")
                 if any(r["status"] == s for r in report["rows"])),
                "manual" if any(r["status"] == "not_checked" for r in report["rows"]) else "match") if report["rows"] else "unavailable"


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")


def comparative_evidence(report, bundle, config, newer_sources):
    metrics = config.get("metrics", []) if isinstance(config, dict) else config
    by_key = {metric["key"]: metric for metric in metrics}
    for row in report["rows"]:
        if row["sourceBackendStatus"] != "difference":
            continue
        for newer_end, source, downloaded in newer_sources:
            if newer_end <= report["periodEnd"]:
                continue
            checked = compare(source, bundle, "", report["periodEnd"], [by_key[row["key"]]])["rows"][0]
            if checked["sourceBackendStatus"] != "match":
                continue
            row["newerComparativeEvidence"] = {"filingName": downloaded["name"],
                "filingSha256": hashlib.sha256(downloaded["data"]).hexdigest(),
                "periodEnd": newer_end, "fact": checked["official"]["selectedFact"]}
            note = f"{row['label']}: API vastaa uudemman ({newer_end}) tilinpäätöksen vertailulukua ({checked['official']['value']}), mutta valitun alkuperäisen tilinpäätöksen luku on {row['official']['value']}. Ero säilytetään lähdeversioiden erona."
            row["note"] += " " + note
            report["warnings"].append(note)
            break


def run_batch(queries, config, output, latest=2, requested=None,
              site_origin="https://d3po43lod2ykoc.cloudfront.net", filings=None, progress=None):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    shared = ROOT / "data" / "statement-audit"
    filings = filings if filings is not None else OfficialFilings(shared / "official")
    cases, selected = [], set()
    for query in queries:
        if progress:
            progress(f"Haetaan yritys ja Valuatumin luvut: {query}")
        expected = None
        stage = "company_search"
        try:
            expected = select_company(valuatum("search", query, shared / "rest"), query)
            if expected["orgnr"] in selected:
                continue
            selected.add(expected["orgnr"])
            stage = "backend_fetch"
            bundle = valuatum("bundle", expected["fid"], shared / "rest")
            stage = "backend_identity"
            verify_bundle(bundle, expected)
            stage = "period_selection"
            periods = select_periods(bundle, latest, requested)
        except Exception as error:
            cases.append({"query": query, "company": expected, "periodEnd": None, "status": "error",
                          "errorStage": stage, "errorType": type(error).__name__,
                          "error": "Yrityksen tai tilikausien haku/varmistus epäonnistui. Tallennettuja lukuja ei käytetty."})
            continue
        newer_sources = []
        for end in periods:
            if progress:
                progress(f"Verrataan {expected['orgnr']} / {end}")
            url = website_url(site_origin, expected)
            case = {"company": expected, "periodEnd": end, "websiteUrl": url, "backendMode": "live"}
            filename = f"{expected['orgnr']}_{end}.report.json"
            stage = "official_fetch"
            try:
                try:
                    downloaded = filings.fetch(expected["orgnr"], end)
                except ValueError as error:
                    if str(error) != MISSING_FILING:
                        raise
                    downloaded = None
                stage = "filing_parse"
                source = read_filing(downloaded["data"], downloaded["name"]) if downloaded else {
                    "documents": [], "facts": [], "periods": [], "warnings": [MISSING_FILING]}
                warning = None
                try:
                    html, final_url = fetch_website(url)
                except Exception:
                    html, final_url = "", url
                    warning = "Yrityssivua ei voitu lukea; verkkosivun lukujen vastaavuutta ei vahvistettu."
                stage = "comparison"
                report = compare(source, bundle, html, end, config)
                if warning:
                    report["warnings"].append(warning)
                comparative_evidence(report, bundle, config, newer_sources)
                if downloaded:
                    newer_sources.append((end, source, downloaded))
                report["provenance"] = {"checkedAt": utc_now(), "backendMode": "live",
                    "backendRetrievedAt": bundle.get("retrievedAt"), "filingName": downloaded["name"] if downloaded else None,
                    "filingSha256": hashlib.sha256(downloaded["data"]).hexdigest() if downloaded else None,
                    "officialArchiveUrl": downloaded["url"] if downloaded else None, "officialRetrievedAt": downloaded["retrievedAt"] if downloaded else None,
                    "documents": [{"name": d["name"], "sha256": d["sha256"]} for d in source["documents"]],
                    "websiteUrl": final_url}
                write_json(output / filename, report)
                case.update(status=report_status(report), report=filename, total=len(report["rows"]), sourceAvailable=bool(downloaded),
                    sourceBackend=counts(report, "sourceBackendStatus"),
                    backendWebsite=counts(report, "backendWebsiteStatus"), overall=counts(report, "status"),
                    warnings=report["warnings"], websiteUrl=final_url)
            except Exception as error:
                case.update(status="error", report=filename, errorStage=stage, errorType=type(error).__name__,
                            error="Tilinpäätöksen haku tai vertailu epäonnistui; tämän tapauksen lukuja ei vahvistettu.")
                write_json(output / filename, case)
            cases.append(case)
            if progress:
                progress(f"{expected['orgnr']} / {end}: {case['status']}")
            write_json(output / "summary.json", {"checkedAt": utc_now(), "cases": cases})
    summary = {"checkedAt": utc_now(), "cases": cases,
               "counts": {s: sum(c["status"] == s for c in cases) for s in (*STATUSES, "error")}}
    write_json(output / "summary.json", summary)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--company", action="append", required=True, help="Exact organisation number or unambiguous name; repeat for multiple companies")
    parser.add_argument("--latest", type=int, default=2)
    parser.add_argument("--period", action="append", help="Exact fiscal end YYYY-MM-DD; repeat, applies to every selected company")
    parser.add_argument("--site-origin", default="https://d3po43lod2ykoc.cloudfront.net")
    parser.add_argument("--config", type=Path, default=ROOT / "data/statement-audit/config.json")
    parser.add_argument("--output", type=Path, default=ROOT / "data/statement-audit/runs" / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ"))
    parser.add_argument("--share", action="store_true", help="Build an offline review ZIP after verification")
    args = parser.parse_args()
    if not 1 <= args.latest <= 20 or len(args.company) > 100:
        parser.error("Use 1–20 periods and at most 100 explicitly selected companies.")
    if args.period and (len(args.period) > 20 or any(fiscal_end(end) != end for end in args.period)):
        parser.error("Use at most 20 exact YYYY-MM-DD fiscal ends.")
    try:
        config = json.loads(args.config.read_text(encoding="utf-8"))
        result = run_batch(args.company, config, args.output, args.latest, args.period, args.site_origin,
                           progress=lambda message: print(message, file=sys.stderr, flush=True))
        if args.share:
            from share import build_pack
            build_pack(args.output, ROOT / "data/statement-audit/official")
    except (OSError, ValueError):
        parser.exit(2, "Batch configuration/output could not be read or written.\n")
    print(json.dumps({"output": str(args.output), "counts": result["counts"]}))
    return 1 if result["counts"]["error"] or result["counts"]["difference"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
