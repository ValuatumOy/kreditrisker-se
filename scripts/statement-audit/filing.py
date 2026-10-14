"""Bounded, local-only Inline XBRL reading. No taxonomy/network resolution."""

import codecs
from collections import defaultdict
from datetime import date
from decimal import Decimal, InvalidOperation, localcontext
import io
import hashlib
import math
from pathlib import PurePosixPath
import re
import xml.etree.ElementTree as ET
import zipfile


MAX_UPLOAD = 20 * 1024 * 1024
MAX_EXPANDED = 50 * 1024 * 1024
MAX_FILES = 100
XHTML = "http://www.w3.org/1999/xhtml"
IX = "http://www.xbrl.org/2013/inlineXBRL"
XBRLI = "http://www.xbrl.org/2003/instance"
XBRLDI = "http://xbrl.org/2006/xbrldi"
XSI = "http://www.w3.org/2001/XMLSchema-instance"
TRANSFORM_BASE = "http://www.xbrl.org/inlineXBRL/transformation/"
REPORTING_SCOPES = {
    f"{{http://www.taxonomier.se/se/fr/gen-base/{version}}}RedovisningInformation{name}Segment": scope
    for version in ("2020-12-01", "2021-10-31")
    for name, scope in (("JuridiskPerson", "company"), ("Koncern", "group"), ("Generell", "general"))
}
TRANSFORMS = {
    "2010-04-20": {"numspacecomma", "numspacedot", "numcomma", "numdot", "numdotcomma", "numcommadot"},
    "2011-07-31": {"numcommadecimal", "numdotdecimal"},
    "2015-02-26": {"numcommadecimal", "numdotdecimal"},
    "2020-02-12": {"num-comma-decimal", "num-dot-decimal"},
    "2022-02-16": {"num-comma-decimal", "num-dot-decimal"},
}
NS = {"x": XHTML, "i": XBRLI}


def _decode(data):
    if data.startswith((codecs.BOM_UTF32_LE, codecs.BOM_UTF32_BE)):
        encoding = "utf-32"
    elif data.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        encoding = "utf-16"
    elif data.startswith(b"\x00<\x00?"):
        encoding = "utf-16-be"
    elif data.startswith(b"<\x00?\x00"):
        encoding = "utf-16-le"
    else:
        declaration = re.match(br"(?:\xef\xbb\xbf)?<\?xml[^?]*encoding\s*=\s*['\"]([^'\"]+)['\"]", data[:512], re.I)
        encoding = declaration[1].decode("ascii") if declaration else "utf-8"
    try:
        canonical = codecs.lookup(encoding).name
        if canonical not in {"utf-8", "utf-16", "utf-16-le", "utf-16-be", "utf-32", "utf-32-le", "utf-32-be", "iso8859-1", "cp1252", "ascii"}:
            raise ValueError("Unsupported XML encoding")
        return data.decode(encoding)
    except (LookupError, UnicodeError) as exc:
        raise ValueError("Cannot decode filing XML") from exc


def _xml(data):
    html = _decode(data)
    if re.search(r"<!\s*(?:DOCTYPE|ENTITY)\b", html, re.I):
        raise ValueError("DTD and entity declarations are not allowed")
    scopes, stack, pending = {}, [], {}
    try:
        parser = ET.iterparse(io.StringIO(html), events=("start", "end", "start-ns"))
        count = 0
        for event, item in parser:
            if event == "start-ns":
                pending[item[0]] = item[1]
            elif event == "start":
                scope = dict(stack[-1]) if stack else {}
                scope.update(pending)
                pending.clear()
                if len(scope) > 128:
                    raise ValueError("XML exceeds namespace scope limit")
                scopes[item] = scope
                stack.append(scope)
                count += 1
                if len(stack) > 256 or count > 200000:
                    raise ValueError("XML exceeds element/depth limits")
            else:
                stack.pop()
        root = parser.root
    except ET.ParseError as exc:
        raise ValueError(f"Invalid XHTML: {exc}") from exc
    if root.tag != f"{{{XHTML}}}html":
        raise ValueError("Expected a namespace-qualified XHTML html root")
    return html, root, scopes


def _qname(text, scope):
    parts = text.strip().split(":")
    if len(parts) == 1:
        prefix, local = "", parts[0]
    elif len(parts) == 2:
        prefix, local = parts
    else:
        raise ValueError(f"Invalid QName: {text}")
    if not local or prefix not in scope or not re.fullmatch(r"[^\W\d][\w.-]*", local, re.UNICODE):
        raise ValueError(f"Unbound or invalid QName: {text}")
    return scope[prefix], local


def _text(element):
    parts = [element.text or ""]
    for child in element:
        if child.tag != f"{{{IX}}}exclude":
            parts.append(_text(child))
        parts.append(child.tail or "")
    return "".join(parts)


def _fact_text(element, ids):
    parts, seen = [_text(element)], set()
    current = element
    while current.get("continuedAt"):
        ref = current.get("continuedAt")
        if ref in seen or len(seen) >= 256:
            raise ValueError("Cyclic or excessive continuation chain")
        seen.add(ref)
        matches = ids.get(ref, [])
        if len(matches) != 1 or matches[0].tag != f"{{{IX}}}continuation":
            raise ValueError(f"Missing or ambiguous continuation: {ref}")
        current = matches[0]
        parts.append(_text(current))
        if sum(map(len, parts)) > MAX_EXPANDED:
            raise ValueError("Continuation text exceeds size limit")
    return "".join(parts).strip()


def _one_text(element, path):
    nodes = element.findall(path, NS)
    if len(nodes) != 1 or not (nodes[0].text or "").strip():
        raise ValueError(f"Missing or ambiguous context field: {path}")
    return nodes[0].text.strip()


def _context(element, scopes):
    result = {"entity": None, "start": None, "end": None, "instant": None, "dimensions": {}, "reportingScope": "unsegmented"}
    result["entity"] = _one_text(element, "i:entity/i:identifier")
    periods = element.findall("i:period", NS)
    if len(periods) != 1:
        raise ValueError("Missing or ambiguous context period")
    period = periods[0]
    if [child.tag for child in period] == [f"{{{XBRLI}}}instant"]:
        result["instant"] = _one_text(period, "i:instant")
    elif [child.tag for child in period] == [f"{{{XBRLI}}}startDate", f"{{{XBRLI}}}endDate"]:
        result["start"] = _one_text(period, "i:startDate")
        result["end"] = _one_text(period, "i:endDate")
    else:
        raise ValueError("Unsupported or ambiguous context period")
    for key in ("start", "end", "instant"):
        if result[key]:
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", result[key]):
                raise ValueError("Only ISO date context periods are supported")
            date.fromisoformat(result[key])
    if result["start"] and result["start"] > result["end"]:
        raise ValueError("Context start date is after end date")
    containers = element.findall("i:entity/i:segment", NS) + element.findall("i:scenario", NS)
    for container in containers:
        if not len(container):
            raise ValueError("Empty context segment/scenario has unknown reporting scope")
        if (container.text or "").strip() or any((member.tail or "").strip() for member in container):
            raise ValueError("Mixed context segment/scenario text has unknown reporting scope")
        for member in container:
            if member.tag in REPORTING_SCOPES:
                if (container.tag != f"{{{XBRLI}}}segment" or len(containers) != 1 or len(container) != 1
                        or len(member) or member.attrib or (member.text or "").strip()):
                    raise ValueError("Mixed or ambiguous reporting scope segment")
                result["reportingScope"] = REPORTING_SCOPES[member.tag]
                continue
            if member.tag not in {f"{{{XBRLDI}}}explicitMember", f"{{{XBRLDI}}}typedMember"}:
                raise ValueError("Unsupported context segment/scenario content")
            dimension = member.get("dimension", "")
            dim_ns, dim_local = _qname(dimension, scopes[member])
            key = f"{{{dim_ns}}}{dim_local}"
            if key in result["dimensions"]:
                raise ValueError("Duplicate context dimension")
            if member.tag.endswith("explicitMember"):
                value_ns, value_local = _qname((member.text or "").strip(), scopes[member])
                result["dimensions"][key] = f"{{{value_ns}}}{value_local}"
            else:
                if len(member) != 1:
                    raise ValueError("Ambiguous typed dimension")
                result["dimensions"][key] = ET.tostring(member[0], encoding="unicode")
    return result


def _unit(element, scopes):
    children = list(element)
    if len(children) != 1 or children[0].tag != f"{{{XBRLI}}}measure":
        raise ValueError("Only simple units with one measure are supported")
    measure = children[0]
    text = (measure.text or "").strip()
    namespace, local = _qname(text, scopes[measure])
    recognized = (
        namespace == "http://www.xbrl.org/2003/iso4217" and local == "SEK"
        or namespace == XBRLI and local in {"pure", "shares"}
        or namespace == "http://www.taxonomier.se/se/fr/k3/datatype" and local == "AntalPersoner"
    )
    if not recognized:
        raise ValueError(f"Unsupported unit measure: {text}")
    return text


def _number(text, element, scope):
    transformation = element.get("format")
    normalized = re.sub(r"[\t\r\n ]+", " ", text).strip()
    if transformation:
        namespace, name = _qname(transformation, scope)
        version = namespace.removeprefix(TRANSFORM_BASE)
        if not namespace.startswith(TRANSFORM_BASE) or name not in TRANSFORMS.get(version, set()):
            raise ValueError(f"Unsupported numeric transformation: {transformation}")
        normalized = normalized.replace("\u00a0", " ")
        if name in {"numcomma", "numdot"}:
            separator = "," if name == "numcomma" else "."
            pattern = r"[0-9]+(?:" + re.escape(separator) + r"[0-9]+)?"
            if not re.fullmatch(pattern, normalized):
                raise ValueError("Invalid transformed decimal")
            normalized = normalized.replace(separator, ".")
        elif name in {"numspacecomma", "numspacedot", "numdotcomma", "numcommadot"}:
            separator = "," if name in {"numspacecomma", "numdotcomma"} else "."
            group = " " if name.startswith("numspace") else ("." if name == "numdotcomma" else ",")
            pattern = r"(?:[0-9]+|[0-9]{1,3}(?:" + re.escape(group) + r"[0-9]{3})+)(?:" + re.escape(separator) + r"[0-9]+)?"
            if not re.fullmatch(pattern, normalized):
                raise ValueError("Invalid transformed grouped decimal")
            normalized = normalized.replace(group, "").replace(separator, ".")
        else:
            separator = "," if name in {"numcommadecimal", "num-comma-decimal"} else "."
            group = "." if separator == "," else ","
            pattern = r"[" + re.escape(group) + r" 0-9]*(?:" + re.escape(separator) + r"[ 0-9]+)?"
            if not re.fullmatch(pattern, normalized):
                raise ValueError("Invalid transformed decimal")
            normalized = normalized.replace(group, "").replace(" ", "").replace(separator, ".")
    if not re.fullmatch(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)", normalized):
        raise ValueError("Invalid numeric text (no guessing separators or dash zero)")
    if len(normalized) > 1000:
        raise ValueError("Numeric text exceeds precision limit")
    scale_text = element.get("scale", "0")
    if not re.fullmatch(r"[+-]?[0-9]{1,4}", scale_text) or abs(int(scale_text)) > 1000:
        raise ValueError("Invalid or excessive numeric scale")
    sign = element.get("sign")
    if sign not in {None, "-"} or (sign and normalized.startswith(("-", "+"))):
        raise ValueError("Invalid or conflicting numeric sign")
    with localcontext() as ctx:
        ctx.prec = 2100
        value = Decimal(normalized).scaleb(int(scale_text))
        if sign == "-":
            value = -value
        if value == value.to_integral_value():
            return int(value)
        number = float(value)
        if not math.isfinite(number) or (number == 0 and value != 0):
            raise ValueError("Numeric value exceeds JSON number range")
        return number


def _kind(root, title, scopes):
    namespaces = {uri for scope in scopes.values() for uri in scope.values()}
    audit = any(uri.startswith("http://www.far.se/se/fr/ar/") for uri in namespaces)
    annual = any(uri.startswith("http://www.taxonomier.se/se/fr/gen-base/") for uri in namespaces)
    title = title.casefold()
    audit = audit or "revisionsberättelse" in title or "revisionsberattelse" in title or "audit report" in title
    annual = annual or "årsredovisning" in title or "arsredovisning" in title or "annual report" in title
    if audit:
        return "audit"
    return "annual" if annual else "unknown"


def _viewer_html(html, root, generated):
    tokens = re.finditer(r"<!--.*?-->|<!\[CDATA\[.*?\]\]>|<\?.*?\?>|<(?:[^>\"']|\"[^\"]*\"|'[^']*')*>", html, re.S)
    elements = iter(root.iter())
    insertions = []
    for token in tokens:
        if not re.match(r"<[^/!?\s]", token[0]):
            continue
        element = next(elements)
        if element not in generated:
            continue
        identifier = generated[element]
        empty_id = re.search(r"(?<![\w:-])id\s*=\s*([\"'])\1", token[0])
        if empty_id:
            position = token.start() + empty_id.end() - 1
            insertions.append((position, identifier))
        else:
            position = token.end() - (2 if token[0].endswith("/>") else 1)
            insertions.append((position, f' id="{identifier}"'))
    for position, text in reversed(insertions):
        html = html[:position] + text + html[position:]
    return html


def _document(data, name, index):
    html, root, scopes = _xml(data)
    title_node = root.find("x:head/x:title", NS)
    title = _text(title_node).strip() if title_node is not None else ""
    document = {"name": name, "title": title, "kind": _kind(root, title, scopes), "html": html, "sha256": hashlib.sha256(data).hexdigest()}
    ids = defaultdict(list)
    for element in root.iter():
        if element.get("id"):
            ids[element.get("id")].append(element)
    contexts, units, periods, facts, warnings = {}, {}, [], [], []
    generated = {}
    for identifier, elements in ids.items():
        if any(e.tag == f"{{{XBRLI}}}context" for e in elements):
            try:
                if len(elements) != 1:
                    raise ValueError("Duplicate context ID")
                context = _context(elements[0], scopes)
                contexts[identifier] = context
                if context["start"]:
                    periods.append({key: context[key] for key in ("start", "end", "entity")})
            except ValueError as exc:
                contexts[identifier] = str(exc)
        if any(e.tag == f"{{{XBRLI}}}unit" for e in elements):
            try:
                if len(elements) != 1:
                    raise ValueError("Duplicate unit ID")
                units[identifier] = (_unit(elements[0], scopes), None)
            except ValueError as exc:
                units[identifier] = (None, str(exc))
    for element in root.iter():
        if element.tag not in {f"{{{IX}}}nonFraction", f"{{{IX}}}nonNumeric", f"{{{IX}}}fraction"}:
            continue
        fact = {
            "concept": element.get("name", ""), "localName": element.get("name", "").split(":")[-1],
            "namespace": None, "contextId": element.get("contextRef"), "entity": None,
            "start": None, "end": None, "instant": None, "dimensions": {}, "reportingScope": None,
            "unit": None, "unitRef": element.get("unitRef"), "value": None, "decimals": None,
            "text": _text(element).strip(), "elementId": element.get("id"), "documentIndex": index,
        }
        errors = []
        try:
            fact["namespace"], fact["localName"] = _qname(fact["concept"], scopes[element])
        except ValueError as exc:
            errors.append(str(exc))
        context = contexts.get(fact["contextId"], "Missing context reference")
        if isinstance(context, dict):
            fact.update(context)
        else:
            errors.append(context)
        try:
            fact["text"] = _fact_text(element, ids)
        except ValueError as exc:
            errors.append(str(exc))
        numeric = element.tag != f"{{{IX}}}nonNumeric"
        if numeric:
            if not fact["elementId"]:
                identifier = f"statement-audit-{index}-{len(facts)}"
                while identifier in ids:
                    identifier += "-fact"
                generated[element] = identifier
                fact["elementId"] = identifier
            fact["unit"], unit_error = units.get(fact["unitRef"], (None, "Missing unit reference"))
            if unit_error:
                errors.append(unit_error)
            decimals = element.get("decimals")
            fact["decimalsRaw"] = decimals
            if decimals is not None and decimals != "INF":
                if re.fullmatch(r"[+-]?[0-9]{1,4}", decimals):
                    fact["decimals"] = int(decimals)
                else:
                    errors.append("Invalid decimals attribute")
        nil = element.get(f"{{{XSI}}}nil", "false")
        if nil not in {"true", "1", "false", "0"}:
            errors.append("Invalid nil attribute")
        if numeric and nil in {"false", "0"}:
            try:
                if element.tag == f"{{{IX}}}fraction":
                    raise ValueError("Inline fraction facts are unsupported")
                if element.get("continuedAt"):
                    raise ValueError("Numeric continuation is unsupported by Inline XBRL")
                value = _number(fact["text"], element, scopes[element])
                if not errors:
                    fact["value"] = value
            except (ValueError, InvalidOperation) as exc:
                errors.append(str(exc))
        if errors:
            fact["error"] = "; ".join(errors)
        facts.append(fact)
    errors_count = sum("error" in fact for fact in facts)
    if errors_count:
        warnings.append(f"{name}: {errors_count} fact(s) could not be fully interpreted; inspect their error fields")
    if document["kind"] == "unknown":
        warnings.append(f"{name}: document kind is unknown; financial matching must not assume annual accounts")
    document["viewerHtml"] = _viewer_html(html, root, generated) if generated else html
    return document, facts, periods, warnings


def read_filing(data: bytes, filename: str) -> dict:
    """Read a single company ZIP or standalone XHTML; invalid uploads raise ValueError."""
    if not isinstance(data, bytes) or not data:
        raise ValueError("Upload is empty or is not bytes")
    if len(data) > MAX_UPLOAD:
        raise ValueError("Upload exceeds the 20 MB limit")
    sources, warnings = [], []
    if filename.lower().endswith(".zip") or zipfile.is_zipfile(io.BytesIO(data)):
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                entries = archive.infolist()
                if len(entries) > MAX_FILES:
                    raise ValueError("ZIP exceeds the 100 entry limit")
                if sum(entry.file_size for entry in entries) > MAX_EXPANDED:
                    raise ValueError("ZIP exceeds the 50 MB expanded limit")
                seen = set()
                for entry in entries:
                    path = PurePosixPath(entry.filename.replace("\\", "/"))
                    if path.is_absolute() or ".." in path.parts or ":" in entry.filename or "\x00" in entry.filename:
                        raise ValueError("ZIP contains an unsafe entry path")
                    if entry.filename in seen:
                        raise ValueError("ZIP contains duplicate entry names")
                    seen.add(entry.filename)
                    if entry.flag_bits & 1:
                        raise ValueError("Encrypted ZIP entries are unsupported")
                    if path.suffix.lower() == ".zip":
                        raise ValueError("Nested/weekly ZIP unsupported. Upload one company's inner ZIP or its XHTML file")
                    if entry.is_dir():
                        continue
                    if path.suffix.lower() in {".xhtml", ".html", ".htm"}:
                        with archive.open(entry) as stream:
                            content = stream.read(min(entry.file_size, MAX_EXPANDED) + 1)
                        if len(content) != entry.file_size:
                            raise ValueError("ZIP expanded size differs from its declared size")
                        sources.append((entry.filename, content))
                    else:
                        warnings.append(f"Ignored non-XHTML ZIP entry: {entry.filename}")
        except (zipfile.BadZipFile, RuntimeError, NotImplementedError, OSError) as exc:
            raise ValueError(f"Cannot read company ZIP: {exc}") from exc
    elif PurePosixPath(filename).suffix.lower() in {".xhtml", ".html", ".htm"}:
        sources.append((filename, data))
    else:
        raise ValueError("Upload one company's ZIP or a standalone XHTML file")
    if not sources:
        raise ValueError("No XHTML documents found in company ZIP")
    result = {"documents": [], "facts": [], "periods": [], "warnings": warnings}
    for index, (name, content) in enumerate(sources):
        document, facts, periods, doc_warnings = _document(content, name, index)
        result["documents"].append(document)
        result["facts"].extend(facts)
        for period in periods:
            if period not in result["periods"]:
                result["periods"].append(period)
        result["warnings"].extend(doc_warnings)
    return result
