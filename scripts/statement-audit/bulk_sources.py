"""One bounded official archive scan shared by an explicitly selected company set."""

from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from datetime import date
import hashlib
import json
from pathlib import Path
import re
import threading

from filing import XBRLI, _context, _xml, read_filing
from official import (BASE_URL, ENTRY_PATTERN, INDEX_WORKERS, KEY_PATTERN, MAX_FILING,
                      OfficialFilings, _read_json, _utc_now, _write_bytes, _write_json)


MISSING_FILING = "Yrityksen ja tilikauden digitaalista tilinpäätöstä ei löytynyt Bolagsverketin julkisista viikkopaketeista. Kaikkia tilinpäätöksiä ei ole tässä aineistossa; alkuperäisen tiedoston voi edelleen tuoda käsin."


class SourceError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _orgnr(value):
    text = re.sub(r"[\s-]", "", str(value or ""))
    if re.fullmatch(r"16\d{10}", text):
        text = text[2:]
    if not re.fullmatch(r"\d{10}", text):
        raise ValueError("Anna ruotsalainen 10-numeroinen yritystunnus.")
    return text


def _period(value):
    try:
        if date.fromisoformat(value).isoformat() != value:
            raise ValueError()
    except (TypeError, ValueError) as exc:
        raise ValueError("Anna tilikauden päättymispäivä muodossa VVVV-KK-PP.") from exc
    return value


def _order(archive):
    return tuple(int(value) for value in KEY_PATTERN.fullmatch(archive["key"]).groups())


def _leap_end(filename_end):
    if filename_end[5:] == "02-28":
        try:
            return date(int(filename_end[:4]), 2, 29).isoformat()
        except ValueError:
            pass
    return None


def _leap_date_evidence(parsed, annual, orgnr, filename_end):
    declared_end = _leap_end(filename_end)
    if declared_end is None:
        raise ValueError("Filename is not leap-year February 28")
    documents = [(index, doc) for index, doc in enumerate(parsed["documents"]) if doc.get("kind") == "annual"]
    if len(documents) != 1:
        raise ValueError("A unique annual document is required")
    document_index, document = documents[0]
    names = ("Organisationsnummer", "RakenskapsarForstaDag", "RakenskapsarSistaDag")
    headers = {name: [f for f in annual if f.get("localName") == name] for name in names}
    if any(len(matches) != 1 for matches in headers.values()):
        raise ValueError("Missing or ambiguous annual identity/date headers")
    headers = {name: matches[0] for name, matches in headers.items()}
    identity, first, last = (headers[name] for name in names)
    namespace = identity.get("namespace", "")
    if not re.fullmatch(r"http://www\.taxonomier\.se/se/fr/cd-base/\d{4}-\d{2}-\d{2}", namespace):
        raise ValueError("Unsupported annual header namespace")
    start = _period(first.get("text"))
    if _period(last.get("text")) != declared_end or start >= declared_end or _orgnr(identity.get("text")) != orgnr:
        raise ValueError("Annual identity/date header values do not establish the leap-day period")
    for header in headers.values():
        if (header.get("error") or header.get("namespace") != namespace or header.get("unitRef") is not None
                or "decimalsRaw" in header or header.get("value") is not None
                or header.get("documentIndex") != document_index or header.get("contextId") != identity.get("contextId")
                or _orgnr(header.get("entity")) != orgnr or header.get("dimensions")
                or header.get("reportingScope") not in {"company", "unsegmented"}
                or (header.get("start"), header.get("end"), header.get("instant")) != (start, declared_end, None)):
            raise ValueError("Annual headers do not share an exact company duration context")
    # HTML is already decoded; its original encoding declaration belongs to the source bytes.
    parse_html = re.sub(r"\A\ufeff?<\?xml[^?]*\?>", "", document["html"], count=1)
    _, root, scopes = _xml(parse_html.encode("utf-8"))
    elements = list(root.iter(f"{{{XBRLI}}}context"))
    identifiers = [element.get("id") for element in elements]
    if None in identifiers or "" in identifiers or len(set(identifiers)) != len(identifiers):
        raise ValueError("Missing or ambiguous annual context identifiers")
    contexts = [_context(element, scopes) for element in elements]
    if not contexts:
        raise ValueError("Annual document has no verified contexts")
    if len({context.get("reportingScope") for context in contexts}) != 1:
        raise ValueError("Annual contexts mix reporting scopes")
    for context in contexts:
        if (_orgnr(context.get("entity")) != orgnr or context.get("dimensions")
                or context.get("reportingScope") not in {"company", "unsegmented"}):
            raise ValueError("Annual contexts contain another company or unsupported scope")
        end = context.get("end") or context.get("instant")
        if end and end > start and (end != declared_end or (context.get("start") and context["start"] != start)):
            raise ValueError("Current annual contexts disagree with the declared full fiscal period")
    if any(_orgnr(f.get("entity")) != orgnr for f in annual):
        raise ValueError("Annual facts contain an unverified company identity")
    monetary = [f for f in annual if f.get("unit") == "iso4217:SEK"]
    if any(f.get("error") for f in monetary):
        raise ValueError("Monetary fact parse errors prevent fiscal-period verification")
    company = [f for f in monetary if f.get("value") is not None and not f.get("dimensions")
               and f.get("reportingScope") in {"company", "unsegmented"}
               and re.fullmatch(r"http://www\.taxonomier\.se/se/fr/gen-base/\d{4}-\d{2}-\d{2}", f.get("namespace", ""))]
    if not (any((f.get("start"), f.get("end")) == (start, declared_end) for f in company)
            and any(f.get("instant") == declared_end for f in company)):
        raise ValueError("Both full company duration and instant facts must establish the declared period")
    def provenance(fact):
        return {key: fact.get(key) for key in ("localName", "namespace", "text", "entity", "contextId", "start", "end",
                                               "instant", "documentIndex", "elementId", "error")}
    return {"code": "filename_leap_day_discrepancy", "filenamePeriodEnd": filename_end,
            "sourceDeclaredPeriodEnd": declared_end, "sourceDeclaredPeriodStart": start,
            "documentIndex": document_index, "documentSha256": document["sha256"],
            "verifiedContextCount": len(contexts), "headers": {name: provenance(f) for name, f in headers.items()},
            "unrelatedFactErrors": [provenance(f) for f in annual if f.get("error")]}


class BulkFilings(OfficialFilings):
    """Call prepare once before concurrent fetches; preparation never downloads filings.

    A fresh listing validates resumed archive identities. Each worker retains parsed
    filings for its current company only, with at most two parsed files per worker.
    """

    def __init__(self, cache_dir, orgnrs, manifest_path=None):
        super().__init__(Path(cache_dir))
        self.orgnrs = frozenset(_orgnr(value) for value in orgnrs)
        if not self.orgnrs:
            raise ValueError("Select at least one company.")
        self.manifest_path = Path(manifest_path) if manifest_path else self.cache_dir / "bulk-manifest.json"
        self.manifest_path.parent.mkdir(parents=True, exist_ok=True)
        self.request_log = self.manifest_path.with_suffix(".requests.jsonl")
        self._lock = threading.Lock()
        self._parsed = threading.local()
        self._prepared = False

    def prepare(self, progress=None):
        if self._prepared:
            return self.manifest
        if progress:
            progress("Haetaan Bolagsverketin viikkopakettien tuore luettelo…")
        archives = sorted(self._listing(refresh=True), key=_order, reverse=True)
        previous = _read_json(self.manifest_path)
        reusable = previous.get("archives", {}) if (isinstance(previous, dict)
                    and previous.get("version") == 1 and previous.get("orgnrs") == sorted(self.orgnrs)) else {}
        self.manifest = {
            "version": 1, "orgnrs": sorted(self.orgnrs), "listingVerifiedAt": _utc_now(),
            "listingFingerprint": hashlib.sha256(json.dumps(archives, sort_keys=True).encode()).hexdigest(),
            "archives": {}, "requestLog": str(self.request_log.resolve()), "scanComplete": False,
        }
        records = self.manifest["archives"]
        pending = []
        for archive in archives:
            identity = self._identity(archive)
            old = reusable.get(identity)
            if isinstance(old, dict) and old.get("status") == "indexed" and old.get("archive") == archive:
                records[identity] = old
            else:
                pending.append(archive)
        _write_json(self.manifest_path, self.manifest)
        with ThreadPoolExecutor(max_workers=INDEX_WORKERS) as executor:
            for begin in range(0, len(pending), INDEX_WORKERS):
                batch = pending[begin:begin + INDEX_WORKERS]
                futures = [executor.submit(self._index, archive) for archive in batch]
                for offset, (archive, future) in enumerate(zip(batch, futures), begin + 1):
                    while True:
                        if progress:
                            progress(f"Luetaan viikkopakettien hakemistoja ({offset}/{len(pending)}): {archive['key']}")
                        try:
                            entries = future.result(timeout=0.5)
                            selected = []
                            for entry in entries:
                                name = entry["name"]
                                if ENTRY_PATTERN.fullmatch(name) and name[:10] in self.orgnrs:
                                    try:
                                        _period(name[11:-4])
                                    except ValueError:
                                        continue
                                    selected.append(entry)
                            record = {"archive": archive, "status": "indexed", "entries": selected}
                            break
                        except FutureTimeout:
                            if not future.done():
                                continue
                            record = {"archive": archive, "status": "error", "error": "Archive index timed out."}
                            break
                        except Exception as exc:
                            record = {"archive": archive, "status": "error", "error": str(exc), "errorType": type(exc).__name__}
                            break
                    records[self._identity(archive)] = record
                _write_json(self.manifest_path, self.manifest)
        self._targets, self.scan_errors = {}, []
        for rank, archive in enumerate(archives):
            record = records[self._identity(archive)]
            if record["status"] == "error":
                self.scan_errors.append({"rank": rank, **record})
                continue
            grouped = {}
            for entry in record["entries"]:
                if _order(archive)[0] < max(2020, date.fromisoformat(entry["name"][11:-4]).year):
                    continue
                grouped.setdefault(entry["name"], []).append(entry)
            for name, entries in grouped.items():
                if name not in self._targets:
                    self._targets[name] = {"archive": archive, "entries": entries, "rank": rank}
        self.manifest["scanComplete"] = not self.scan_errors
        self.manifest["scanFinishedAt"] = _utc_now()
        self.manifest["scanErrorCount"] = len(self.scan_errors)
        self.manifest["targetCount"] = len(self._targets)
        _write_json(self.manifest_path, self.manifest)
        self._prepared = True
        return self.manifest

    def _validate(self, orgnr, period_end):
        orgnr, period_end = _orgnr(orgnr), _period(period_end)
        if orgnr not in self.orgnrs:
            raise ValueError("Company was not selected for this bulk scan.")
        if not self._prepared:
            raise ValueError("Call prepare() before fetching bulk sources.")
        return orgnr, period_end

    def _record(self, orgnr, end, kind, status, result=None, error=None):
        event = {"at": _utc_now(), "listingFingerprint": self.manifest["listingFingerprint"],
                 "orgnr": orgnr, "periodEnd": end, "sourceKind": kind, "status": status}
        if result:
            event.update({key: result[key] for key in ("name", "url", "archiveIdentity", "sha256", "sourcePeriodEnd")})
            event.update({key: result[key] for key in ("filenamePeriodEnd", "sourceDeclaredPeriodEnd", "sourceDateWarning") if key in result})
        if error:
            event["error"] = str(error)
        with self._lock, self.request_log.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, ensure_ascii=False) + "\n")

    def _load(self, orgnr, name):
        selected = self._targets[name]
        if any(error["rank"] < selected["rank"] for error in self.scan_errors):
            raise SourceError("index_incomplete", "Newer archive indexes failed; the newest exact filing cannot be verified.")
        if len(selected["entries"]) != 1:
            raise SourceError("ambiguous", "Samassa viikkopaketissa on useita saman yrityksen ja tilikauden tilinpäätöksiä. Lähde pitää tarkistaa käsin.")
        archive, entry = selected["archive"], selected["entries"][0]
        identity = self._identity(archive)
        data_path, meta_path = self.cache_dir / name, self.cache_dir / (name + ".json")
        meta, data, from_cache = _read_json(meta_path), b"", False
        if isinstance(meta, dict) and meta.get("archiveIdentity") == identity and data_path.is_file():
            data = data_path.read_bytes() if data_path.stat().st_size <= MAX_FILING else b""
            from_cache = bool(data and hashlib.sha256(data).hexdigest() == meta.get("sha256")
                              and meta.get("name") == name and meta.get("url") == BASE_URL + "/" + archive["key"]
                              and meta.get("retrievedAt"))
        if not from_cache:
            data = self._download(archive, entry)
            meta = {"name": name, "url": BASE_URL + "/" + archive["key"], "retrievedAt": _utc_now(),
                    "archiveIdentity": identity, "sha256": hashlib.sha256(data).hexdigest()}
            _write_bytes(data_path, data)
            _write_json(meta_path, meta)
        if getattr(self._parsed, "orgnr", None) != orgnr:
            self._parsed.orgnr, self._parsed.files = orgnr, OrderedDict()
        key = (name, identity, meta["sha256"])
        parsed = self._parsed.files.get(key)
        if parsed is None:
            parsed = read_filing(data, name)
            self._parsed.files[key] = parsed
            if len(self._parsed.files) > 2:
                self._parsed.files.popitem(last=False)
        self._parsed.files.move_to_end(key)
        annual = [fact for fact in parsed["facts"]
                  if isinstance(fact.get("documentIndex"), int) and 0 <= fact["documentIndex"] < len(parsed["documents"])
                  and parsed["documents"][fact["documentIndex"]].get("kind") == "annual"]
        entities = set()
        for fact in annual:
            try:
                entities.add(_orgnr(fact.get("entity")))
            except ValueError:
                pass
        if entities != {orgnr}:
            raise SourceError("identity_mismatch", "Annual filing facts do not establish the exact selected company identity.")
        source_end = name[11:-4]
        warning = None
        leap_end = _leap_end(source_end)
        leap_header = leap_end and any(f.get("localName") == "RakenskapsarSistaDag" and f.get("text") == leap_end for f in annual)
        if leap_header or not self._has_period(annual, orgnr, source_end):
            try:
                warning = _leap_date_evidence(parsed, annual, orgnr, source_end)
            except (ValueError, TypeError, KeyError) as exc:
                raise SourceError("period_mismatch", "Filing facts do not establish the fiscal period in the source filename: " + str(exc)) from exc
            source_end = warning["sourceDeclaredPeriodEnd"]
        return {"data": data, "name": name, "url": meta["url"], "retrievedAt": meta["retrievedAt"],
                "archiveIdentity": identity, "sha256": meta["sha256"], "fromCache": from_cache,
                "sourcePeriodEnd": source_end, "filenamePeriodEnd": name[11:-4], "filing": parsed,
                **({"sourceDeclaredPeriodEnd": source_end, "sourceDateWarning": warning} if warning else {})}

    @staticmethod
    def _has_period(facts, orgnr, end):
        segmented = {fact.get("documentIndex") for fact in facts
                     if fact.get("reportingScope") in {"company", "group", "general"}}
        for fact in facts:
            try:
                same_company = _orgnr(fact.get("entity")) == orgnr
            except ValueError:
                continue
            if (same_company and not fact.get("error") and fact.get("value") is not None
                    and not fact.get("dimensions")
                    and (fact.get("reportingScope") == "company" or
                         (fact.get("reportingScope") == "unsegmented" and fact.get("documentIndex") not in segmented))
                    and (fact.get("instant") == end or (fact.get("start") and fact.get("end") == end))):
                return True
        return False

    def _fetch(self, orgnr, end, comparative, progress):
        kind = "comparative" if comparative else "original"
        relevant_errors = [error for error in self.scan_errors if _order(error["archive"])[0] >= max(2020, date.fromisoformat(end).year)]
        try:
            if comparative:
                if relevant_errors:
                    raise SourceError("index_incomplete", "Archive indexes failed; newest comparative source coverage is incomplete.")
                candidates = sorted((name for name in self._targets if name[:10] == orgnr
                                     and (name[11:-4] > end or (name[11:-4] == end and _leap_end(end)))), reverse=True)
            else:
                name = f"{orgnr}_{end}.zip"
                if name not in self._targets and end[5:] == "02-29":
                    if relevant_errors:
                        raise SourceError("index_incomplete", "Archive index failures prevent verifying absence of the exact leap-day filename.")
                    adjacent = f"{orgnr}_{end[:4]}-02-28.zip"
                    if adjacent in self._targets:
                        name = adjacent
                candidates = [name] if name in self._targets else []
            for name in candidates:
                if progress:
                    progress(f"Haetaan tilinpäätöstä {name}")
                result = self._load(orgnr, name)
                if comparative:
                    if result["sourcePeriodEnd"] <= end:
                        continue
                    parsed = result["filing"]
                    annual = [fact for fact in parsed["facts"] if isinstance(fact.get("documentIndex"), int)
                              and 0 <= fact["documentIndex"] < len(parsed["documents"])
                              and parsed["documents"][fact["documentIndex"]].get("kind") == "annual"]
                    if not self._has_period(annual, orgnr, end):
                        continue
                elif result["sourcePeriodEnd"] != end:
                    adjacent_end = end[:4] + "-02-28"
                    if (end[5:] == "02-29" and name == f"{orgnr}_{adjacent_end}.zip"
                            and result["sourcePeriodEnd"] == result["filenamePeriodEnd"] == adjacent_end
                            and not result.get("sourceDateWarning")):
                        continue
                    raise SourceError("period_mismatch", "Declared source fiscal period differs from the requested original filing period.")
                result.update({"sourceKind": kind, "requestedPeriodEnd": end})
                self._record(orgnr, end, kind, "found", result)
                return result
            if relevant_errors:
                raise SourceError("index_incomplete", "Archive indexes failed; absence of the requested filing cannot be verified.")
            raise SourceError("not_found", MISSING_FILING)
        except Exception as exc:
            self._record(orgnr, end, kind, getattr(exc, "code", "source_error"), error=exc)
            raise

    def fetch(self, orgnr, period_end, progress=None):
        orgnr, end = self._validate(orgnr, period_end)
        return self._fetch(orgnr, end, False, progress)

    def fetch_comparative(self, orgnr, period_end, progress=None):
        orgnr, end = self._validate(orgnr, period_end)
        return self._fetch(orgnr, end, True, progress)
