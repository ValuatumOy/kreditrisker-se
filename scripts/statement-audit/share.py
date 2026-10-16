"""Create a script-free offline review pack using already downloaded filings."""
import argparse
from decimal import Decimal, InvalidOperation
import hashlib
from html import escape
from html.parser import HTMLParser
import json
from pathlib import Path
import re
from urllib.parse import quote, urlsplit
import zipfile

from filing import read_filing

CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"
STATUS = {"match": "Täsmää", "difference": "Ero", "manual": "Tarkista käsin",
          "unavailable": "Tieto puuttuu", "not_checked": "Lähdekartoitusta ei ole", "error": "Haku epäonnistui"}
CSS = "body{font:16px/1.5 system-ui,sans-serif;color:#19372e;margin:2rem auto;padding:0 1.5rem;max-width:100rem}a{color:#156045}table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{padding:.6rem;border-bottom:1px solid #d6dfda;text-align:left;vertical-align:top}thead{background:#eff4f0}td.num{white-space:nowrap;font-variant-numeric:tabular-nums}small{display:block;color:#53675f}details{margin:1rem 0}code{overflow-wrap:anywhere}.scroll{overflow:auto}"


def safe_css(value):
    value = re.sub(r"@import\b[^;]*(?:;|$)", "", value, flags=re.I)
    return re.sub(r"url\s*\([^)]*\)", "none", value, flags=re.I)


def page(title, body):
    return (f'<!doctype html><html lang="fi"><head><meta charset="utf-8">'
            f'<meta http-equiv="Content-Security-Policy" content="{escape(CSP, quote=True)}">'
            f'<meta name="viewport" content="width=device-width,initial-scale=1"><title>{escape(title)}</title>'
            f'<style>{CSS}</style></head><body>{body}</body></html>')


class SafeViewer(HTMLParser):
    """Keep document layout and fact IDs while removing active HTML and navigation."""
    tags = set("html head body title style div span p br hr table thead tbody tfoot tr td th col colgroup h1 h2 h3 h4 h5 h6 strong b em i u s small sub sup ul ol li dl dt dd pre blockquote a img section article header footer main".split())
    void = {"br", "hr", "col", "img"}
    blocked = {"script", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "option", "svg", "math", "template", "noscript", "link", "meta", "base", "video", "audio", "source"}
    attrs = {"id", "class", "style", "colspan", "rowspan", "scope", "width", "height", "align", "valign", "title", "lang", "dir", "start"}

    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.output, self.stack, self.block = [], [], []
        self.feed(html)
        self.close()

    def handle_starttag(self, tag, attrs):
        if self.block:
            if tag not in self.void and tag not in {"input", "embed", "link", "meta", "base", "source"}:
                self.block.append(tag)
            return
        if tag in self.blocked:
            if tag not in {"input", "embed", "link", "meta", "base", "source"}:
                self.block.append(tag)
            return
        output_tag = tag if tag in self.tags else "span"
        kept = [(key, safe_css(value) if key == "style" else value)
                for key, value in attrs if key in self.attrs and value is not None]
        if tag == "a":
            href = dict(attrs).get("href", "")
            if href.startswith("#"):
                kept.append(("href", href))
        if tag == "img":
            src = dict(attrs).get("src", "")
            if re.fullmatch(r"data:image/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+", src):
                kept.append(("src", src))
        self.output.append("<" + output_tag + "".join(f' {key}="{escape(value, quote=True)}"' for key, value in kept) + ">")
        if tag not in self.void:
            self.stack.append((tag, output_tag))

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in self.void:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if self.block:
            if tag in self.block:
                del self.block[self.block.index(tag):]
            return
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index][0] == tag:
                for _, output_tag in reversed(self.stack[index:]):
                    self.output.append(f"</{output_tag}>")
                del self.stack[index:]
                return

    def handle_data(self, data):
        if not self.block:
            self.output.append(safe_css(data) if self.stack and self.stack[-1][0] == "style" else escape(data))


def safe_viewer(html):
    output = "".join(SafeViewer(html).output)
    metadata = f'<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="{escape(CSP, quote=True)}">'
    if "<head>" in output:
        output = output.replace("<head>", "<head>" + metadata, 1)
    else:
        output = "<!doctype html><html><head>" + metadata + "</head><body>" + output + "</body></html>"
    return output


def external_link(url, label):
    url = str(url or "")
    if any(ord(character) < 32 for character in url):
        return escape(label)
    try:
        parsed = urlsplit(url)
    except ValueError:
        return escape(label)
    if parsed.scheme not in ("https", "http") or not parsed.hostname or parsed.username or parsed.password:
        return escape(label)
    return f'<a href="{escape(url, quote=True)}" target="_blank" rel="noopener noreferrer">{escape(label)}</a>'


def number(value):
    if value is None:
        return "—"
    try:
        decimal = Decimal(str(value))
        if not decimal.is_finite():
            return "—"
        formatted = format(decimal.quantize(Decimal("0.01")), "f")
        if "." in formatted:
            formatted = formatted.rstrip("0").rstrip(".")
        integer, dot, fraction = formatted.partition(".")
        grouped = re.sub(r"(?<=\d)(?=(\d{3})+$)", " ", integer)
        return escape(grouped + ("," + fraction if dot else ""))
    except InvalidOperation:
        return "—"


def status(value):
    return escape(STATUS.get(value, "Tarkista käsin"))


def count_text(counts):
    return " · ".join(f"{escape(str(counts.get(key, 0)))} {escape(label.lower())}" for key, label in STATUS.items()
                      if counts.get(key)) or "Ei tuloksia"


def make_case(report, documents, source_error=None):
    company, end = report.get("company", {}), report.get("periodEnd", "")
    title = f"{company.get('name', 'Yritys')} / {end}"
    body = f'<p><a href="index.html">← Kaikki tarkistukset</a></p><h1>{escape(title)}</h1>'
    body += '<p>Tilanne tallennushetkellä. Avaa lähdeluku tai koko tilinpäätös ja tarkista myös satunnaisia rivejä itse.</p>'
    for index, document in enumerate(documents):
        body += f'<p><a href="{escape(document["path"], quote=True)}" target="_blank" rel="noopener">{escape(document["title"])}</a></p>'
    provenance = report.get("provenance", {})
    if urlsplit(str(provenance.get("websiteUrl") or "")).hostname in {"127.0.0.1", "localhost"}:
        body += '<p><strong>Sivuvertailu koskee paikallisesti uudelleen rakennettua sivua.</strong> Tämä tulos ei vahvista julkaistun CloudFront-sivun ajantasaisuutta.</p>'
    body += '<p>' + external_link(provenance.get("websiteUrl"), "Avaa yrityssivu (nykyinen verkkosivu)") + '</p>'
    if source_error:
        body += f'<p>{escape(source_error)}</p>'
    for warning in report.get("warnings", []):
        body += f'<p>{escape(str(warning))}</p>'
    body += '<div class="scroll"><table><thead><tr><th>Luku</th><th>Tilinpäätös</th><th>Valuatum / REST</th><th>Nettisivu</th><th>Lähde → REST</th><th>REST → sivu</th><th>Kokonaisarvio</th></tr></thead><tbody>'
    for row in report.get("rows", []):
        official = row.get("official", {})
        label = escape(str(row.get("label", "Luku")))
        fact = official.get("selectedFact") or {}
        document_index = fact.get("documentIndex")
        if isinstance(document_index, int) and not isinstance(document_index, bool) and 0 <= document_index < len(documents) and fact.get("elementId"):
            href = documents[document_index]["path"] + "#" + quote(str(fact["elementId"]), safe="")
            label += f'<small><a href="{escape(href, quote=True)}" target="_blank" rel="noopener">Näytä lähdeluku</a></small>'
        calculations = ([{**official, "title": "Lähdelaskelma"}] if official.get("formula") else []) + row.get("reconciliations", [])
        for calculation in calculations:
            label += '<details><summary>' + escape(calculation["title"]) + '</summary><code>' + escape(calculation["formula"]) + '</code>'
            label += '<p>' + escape(calculation.get("note", "")) + '</p>'
            for evidence in calculation.get("selectedFacts", []):
                index = evidence.get("documentIndex")
                if type(index) is int and 0 <= index < len(documents) and evidence.get("elementId"):
                    href = documents[index]["path"] + "#" + quote(str(evidence["elementId"]), safe="")
                    title = f'{evidence.get("localName")} · {evidence.get("instant") or evidence.get("end")} · {number(evidence.get("value"))} kr'
                    label += '<small><a href="' + escape(href, quote=True) + '" target="_blank" rel="noopener">' + escape(title) + '</a></small>'
            label += '</details>'
        unit = row.get("unit", official.get("unit", ""))
        label += '<small>' + escape({"SEK": "kr", "people": "hlö", "percent": "%"}.get(unit, str(unit))) + '</small>'
        body += '<tr><th scope="row">' + label + '</th>'
        for field in ("official", "backend", "website"):
            cell = row.get(field, {})
            body += '<td class="num">' + number(cell.get("value"))
            if field == "official" and cell.get("sourceSign") == -1 and cell.get("selectedFact"):
                body += '<small>Lähteessä ' + number(cell['selectedFact']['value']) + '; etumerkki muunnettu.</small>'
            if field == "official" and cell.get("formula") and cell.get("value") is not None:
                body += '<small>' + ('Laskettu lähteestä' if cell["status"] == "calculated" else 'Laskentaesimerkki · ei varmennettu') + '</small>'
            body += '</td>'
        body += ''.join('<td>' + status(row.get(field)) + '</td>' for field in ("sourceBackendStatus", "backendWebsiteStatus"))
        body += '<td>' + status(row.get("status"))
        body += ''.join('<small>' + escape(note) + '</small>' for note in official.get("assumptions", []))
        body += '</td></tr>'
    body += '</tbody></table></div><details><summary>Tarkistuksen ajankohta ja lähteet</summary>'
    for key, label in (("checkedAt", "Tarkistettu"), ("backendRetrievedAt", "Valuatumin luvut haettu"),
                       ("officialRetrievedAt", "Alkuperäinen haettu"), ("filingSha256", "Alkuperäisen ZIP-tiedoston SHA-256")):
        body += f'<p>{label}: <code>{escape(str(provenance.get(key, "—")))}</code></p>'
    body += '<p>Asiakirjan avausversiosta on poistettu aktiivinen sisältö. Tarkistussumma koskee alkuperäistä ZIP-tiedostoa.</p>'
    body += '<p>' + external_link(provenance.get("officialArchiveUrl"), "Bolagsverketin lähdepaketti") + '</p></details>'
    body += '<details><summary>Rivikohtaiset tekniset huomiot</summary><ul>'
    for row in report.get("rows", []):
        if row.get("status") != "match":
            body += f'<li>{escape(str(row.get("label", "")))}: {escape(str(row.get("note", "")))}</li>'
    body += '</ul></details>'
    return page(title, body)


def build_pack(run_dir, cache_dir, output=None):
    run_dir, cache_dir = Path(run_dir), Path(cache_dir)
    output = Path(output) if output else run_dir / "share"
    output.mkdir(parents=True, exist_ok=True)
    summary = json.loads((run_dir / "summary.json").read_text(encoding="utf-8"))
    generated, cases = [], []
    for index, case in enumerate(summary["cases"]):
        documents, source_error = [], None
        report_name = case.get("report", "")
        report_path = run_dir / report_name
        if report_name and Path(report_name).name == report_name and report_path.is_file():
            report = json.loads(report_path.read_text(encoding="utf-8"))
        else:
            report = {"company": case.get("company") or {}, "periodEnd": case.get("periodEnd"), "rows": []}
        if report.get("rows"):
            case = {**case, **{key: {state: sum(row.get(field) == state for row in report["rows"])
                                    for state in STATUS}
                               for key, field in (("sourceBackend", "sourceBackendStatus"),
                                                  ("backendWebsite", "backendWebsiteStatus"))}}
            provenance = report.get("provenance", {})
            filename = provenance.get("filingName") or ""
            try:
                if not re.fullmatch(r"\d{10}_\d{4}-\d{2}-\d{2}\.zip", filename):
                    raise ValueError()
                source_path = cache_dir / filename
                if source_path.stat().st_size > 20 * 1024 * 1024:
                    raise ValueError()
                raw = source_path.read_bytes()
                if hashlib.sha256(raw).hexdigest() != provenance.get("filingSha256"):
                    raise ValueError()
                source = read_filing(raw, filename)
                expected = provenance.get("documents", [])
                if [d["sha256"] for d in source["documents"]] != [d["sha256"] for d in expected]:
                    raise ValueError()
                for document_index, document in enumerate(source["documents"]):
                    relative = f"case-{index + 1}-document-{document_index + 1}.html"
                    (output / relative).write_text(safe_viewer(document.get("viewerHtml", document["html"])), encoding="utf-8")
                    generated.append(relative)
                    documents.append({"path": relative, "title": document.get("title") or document["name"]})
            except (OSError, ValueError, KeyError):
                source_error = "Alkuperäistä asiakirjaa ei voitu liittää: paikallinen lähdetiedosto puuttuu tai sen tarkistussumma ei vastaa raporttia."
        relative = f"case-{index + 1}.html"
        html = make_case(report, documents, source_error or case.get("error"))
        (output / relative).write_text(html, encoding="utf-8")
        generated.append(relative)
        cases.append((case, relative, source_error))
    body = '<h1>Ruotsin tilinpäätösten tarkistus</h1><p>Avaa yritys ja tilikausi. Lähdeluvun linkki avaa sen kohdan alkuperäisen tilinpäätöksen avausversiosta. Paketti toimii ilman asennusta tai API-avainta.</p>'
    body += '<p>Tämä on tallennettu tarkistusotos, ei jatkuvasti päivittyvä palvelu. Puuttuva lähdekartoitus, puuttuva tieto tai käsintarkistus eivät tarkoita että kaikki luvut on vahvistettu.</p>'
    if any(urlsplit(str(case.get("websiteUrl") or "")).hostname in {"127.0.0.1", "localhost"} for case in summary["cases"]):
        body += '<p><strong>API–sivuvertailu koskee paikallisesti uudelleen rakennettuja sivuja.</strong> Julkaistu sivuversio pitää tarkistaa erikseen.</p>'
    body += f'<p>Tallennettu: {escape(str(summary.get("checkedAt", "—")))}</p><div class="scroll"><table><thead><tr><th>Yritys / tilikausi</th><th>Lähde → REST</th><th>REST → sivu</th><th>Kokonaisarvio</th></tr></thead><tbody>'
    for case, relative, source_error in cases:
        company = case.get("company") or {}
        name = company.get("name") or case.get("query") or "Yritys"
        body += f'<tr><th scope="row"><a href="{relative}">{escape(str(name))}</a><small>{escape(str(case.get("periodEnd") or "Tilikausi puuttuu"))}</small></th>'
        body += '<td>' + count_text(case.get("sourceBackend", {})) + '</td><td>' + count_text(case.get("backendWebsite", {})) + '</td><td>' + status(case.get("status"))
        if source_error:
            body += '<small>Alkuperäinen puuttuu paketista</small>'
        body += '</td></tr>'
    body += '</tbody></table></div>'
    (output / "index.html").write_text(page("Tilinpäätösten tarkistus", body), encoding="utf-8")
    generated.append("index.html")
    (output / "LUEMINUT.txt").write_text("Pura koko ZIP samaan kansioon. Avaa index.html selaimessa.\nPaketti sisältää tarkistetut luvut ja asiakirjojen turvalliset avausversiot.\nAPI-avainta tai ohjelmien asennusta ei tarvita. Nettisivulinkki avaa nykyisen sivun verkosta.\n", encoding="utf-8")
    generated.append("LUEMINUT.txt")
    archive_path = output.with_suffix(".zip")
    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for filename in generated:
            archive.write(output / filename, filename)
    return archive_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--cache", type=Path, default=Path(__file__).resolve().parents[2] / "data/statement-audit/official")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    print(build_pack(args.run, args.cache, args.output))
