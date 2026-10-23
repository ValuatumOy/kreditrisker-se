"""Fetch one original filing through bounded HTTP ranges of public bulk ZIPs."""

from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from datetime import date, datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import re
import struct
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
import zlib


BASE_URL = "https://vardefulla-datamangder.bolagsverket.se/arsredovisningar-bulkfiler"
LIST_TTL = 3600
MAX_LIST_PAGE = 2 * 1024 * 1024
MAX_LIST_PAGES = 100
MAX_CENTRAL = 16 * 1024 * 1024
MAX_FILING = 20 * 1024 * 1024
MAX_ENTRIES = 100000
INDEX_WORKERS = 4
KEY_PATTERN = re.compile(r"arsredovisningar/(20\d{2})/(\d{1,2})_(\d+)\.zip\Z")
ENTRY_PATTERN = re.compile(r"\d{10}_\d{4}-\d{2}-\d{2}\.zip\Z")


def _utc_now():
    return datetime.now(timezone.utc).isoformat()


def _read_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _write_bytes(path, data):
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=path.name, suffix=".tmp", delete=False) as handle:
        temporary = Path(handle.name)
        handle.write(data)
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def _write_json(path, value):
    _write_bytes(path, json.dumps(value, ensure_ascii=False).encode("utf-8"))


class OfficialFilings:
    def __init__(self, cache_dir: Path):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def _request(self, url, maximum, headers=None, expected_range=None):
        request = urllib.request.Request(url, headers={"Accept-Encoding": "identity", **(headers or {})})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                if expected_range is not None:
                    start, end, size = expected_range
                    if response.status != 206 or response.headers.get("Content-Range") != f"bytes {start}-{end}/{size}":
                        raise ValueError("Bolagsverket ei tue odotettua osittaista latausta. Koko viikkopakettia ei ladattu.")
                    content_length = response.headers.get("Content-Length")
                    if content_length is not None and int(content_length) != maximum:
                        raise ValueError("Osittaisen latauksen koko ei vastaa pyydettyä aluetta.")
                data = response.read(maximum + 1)
                if len(data) > maximum or (expected_range is not None and len(data) != maximum):
                    raise ValueError("Bolagsverketin vastauksen koko ei vastaa pyydettyä aluetta.")
                return data
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise ValueError("Tilinpäätöksen haku Bolagsverketistä epäonnistui. Yritä uudelleen.") from exc

    def _listing(self, refresh=False):
        path = self.cache_dir / "archives.json"
        cached = _read_json(path)
        if not refresh and isinstance(cached, dict) and 0 <= time.time() - cached.get("fetchedAt", 0) < LIST_TTL:
            return cached["archives"]
        archives, marker, seen = {}, None, set()
        for _ in range(MAX_LIST_PAGES):
            query = {"prefix": "arsredovisningar/", "delimiter": "\\"}
            if marker:
                query["marker"] = marker
            raw = self._request(BASE_URL + "?" + urllib.parse.urlencode(query), MAX_LIST_PAGE)
            if re.search(br"<!\s*(DOCTYPE|ENTITY)\b", raw, re.I):
                raise ValueError("Virheellinen Bolagsverketin tiedostoluettelo.")
            try:
                root = ET.fromstring(raw)
            except ET.ParseError as exc:
                raise ValueError("Bolagsverketin tiedostoluetteloa ei voitu lukea.") from exc
            def text(element, name):
                return element.findtext("{*}" + name, default="")
            for entry in root.findall("{*}Contents"):
                key = text(entry, "Key")
                match = KEY_PATTERN.fullmatch(key)
                if not match or not 1 <= int(match[2]) <= 53:
                    continue
                try:
                    size = int(text(entry, "Size"))
                except ValueError as exc:
                    raise ValueError("Virheellinen viikkopaketin koko tiedostoluettelossa.") from exc
                if not 22 <= size <= 0xFFFFFFFF:
                    raise ValueError("Viikkopaketin kokoa ei tueta.")
                archives[key] = {"key": key, "size": size, "etag": text(entry, "ETag"),
                                 "modified": text(entry, "LastModified")}
            if text(root, "IsTruncated").lower() != "true":
                result = list(archives.values())
                _write_json(path, {"fetchedAt": time.time(), "archives": result})
                return result
            marker = text(root, "NextMarker")
            if not marker or marker in seen:
                raise ValueError("Bolagsverketin tiedostoluettelon sivutus ei edennyt.")
            seen.add(marker)
        raise ValueError("Bolagsverketin tiedostoluettelo ylittää sallitun sivumäärän.")

    @staticmethod
    def _identity(archive):
        raw = json.dumps(archive, sort_keys=True).encode()
        return hashlib.sha256(raw).hexdigest()

    def _range(self, archive, start, end):
        size = archive["size"]
        if not 0 <= start <= end < size or end - start + 1 > max(MAX_CENTRAL, MAX_FILING):
            raise ValueError("Virheellinen tai liian suuri ZIP-latausalue.")
        headers = {"Range": f"bytes={start}-{end}"}
        if archive.get("etag"):
            etag = archive["etag"]
            headers["If-Match"] = etag if etag.startswith('"') else '"' + etag + '"'
        url = BASE_URL + "/" + urllib.parse.quote(archive["key"], safe="/")
        return self._request(url, end - start + 1, headers, (start, end, size))

    def _index(self, archive):
        identity = self._identity(archive)
        path = self.cache_dir / (identity + ".index.json")
        cached = _read_json(path)
        if isinstance(cached, dict) and cached.get("identity") == identity:
            return cached["entries"]
        size = archive["size"]
        start = max(0, size - 65557)
        tail = self._range(archive, start, size - 1)
        position = tail.rfind(b"PK\x05\x06")
        # A signature in a comment is not the end record unless its length also agrees.
        while position >= 0:
            if position + 22 <= len(tail):
                values = struct.unpack_from("<4s4H2IH", tail, position)
                if position + 22 + values[7] == len(tail):
                    break
            position = tail.rfind(b"PK\x05\x06", 0, position)
        if position < 0:
            raise ValueError("Viikkopaketin ZIP-hakemistoa ei löytynyt.")
        _, disk, central_disk, disk_count, count, central_size, offset, _ = values
        if disk or central_disk or disk_count != count or count == 0xFFFF or central_size == 0xFFFFFFFF or offset == 0xFFFFFFFF:
            raise ValueError("ZIP64- tai usean levyn viikkopakettia ei tueta.")
        if count > MAX_ENTRIES or central_size > MAX_CENTRAL or offset + central_size != start + position:
            raise ValueError("Viikkopaketin ZIP-hakemisto on liian suuri tai virheellinen.")
        central = self._range(archive, offset, offset + central_size - 1) if central_size else b""
        entries, cursor = [], 0
        for _ in range(count):
            if cursor + 46 > len(central):
                raise ValueError("Viikkopaketin ZIP-hakemisto on katkennut.")
            values = struct.unpack_from("<4s6H3I5H2I", central, cursor)
            signature, _, _, flags, method, _, _, crc, compressed, expanded, name_len, extra_len, comment_len, disk, _, _, local = values
            end = cursor + 46 + name_len + extra_len + comment_len
            if signature != b"PK\x01\x02" or end > len(central):
                raise ValueError("Virheellinen viikkopaketin ZIP-hakemisto.")
            if disk or 0xFFFFFFFF in (compressed, expanded, local):
                raise ValueError("ZIP64- tai usean levyn viikkopakettia ei tueta.")
            name_bytes = central[cursor + 46:cursor + 46 + name_len]
            try:
                name = name_bytes.decode("utf-8" if flags & 0x800 else "cp437")
            except UnicodeDecodeError as exc:
                raise ValueError("Virheellinen ZIP-tiedostonimi.") from exc
            # Only flat company filenames are eligible; never interpret paths from the archive.
            if ENTRY_PATTERN.fullmatch(name):
                entries.append({"name": name, "flags": flags, "method": method, "crc": crc,
                                "compressed": compressed, "expanded": expanded, "offset": local,
                                "centralOffset": offset})
            cursor = end
        if cursor != len(central):
            raise ValueError("Viikkopaketin ZIP-hakemistossa on odottamatonta sisältöä.")
        _write_json(path, {"identity": identity, "entries": entries})
        return entries

    def _download(self, archive, entry):
        if entry["flags"] & 1 or entry["method"] not in (0, 8):
            raise ValueError("Salattua tai tällä tavalla pakattua tilinpäätöstä ei tueta.")
        compressed, expanded, offset = entry["compressed"], entry["expanded"], entry["offset"]
        if not 0 < compressed <= MAX_FILING or not 0 < expanded <= MAX_FILING:
            raise ValueError("Tilinpäätöstiedosto ylittää 20 Mt:n kokorajan.")
        header = self._range(archive, offset, offset + 29)
        values = struct.unpack("<4s5H3I2H", header)
        signature, _, flags, method, _, _, crc, header_compressed, header_expanded, name_len, extra_len = values
        if signature != b"PK\x03\x04" or flags != entry["flags"] or method != entry["method"]:
            raise ValueError("Tilinpäätöksen ZIP-otsake ei vastaa hakemistoa.")
        if not flags & 8 and (crc, header_compressed, header_expanded) != (entry["crc"], compressed, expanded):
            raise ValueError("Tilinpäätöksen ZIP-kokotiedot eivät vastaa hakemistoa.")
        prefix = self._range(archive, offset + 30, offset + 29 + name_len + extra_len) if name_len + extra_len else b""
        name = prefix[:name_len].decode("utf-8" if flags & 0x800 else "cp437")
        start = offset + 30 + name_len + extra_len
        if name != entry["name"] or start + compressed > entry["centralOffset"]:
            raise ValueError("Tilinpäätöksen ZIP-tiedoston sijainti ei vastaa hakemistoa.")
        payload = self._range(archive, start, start + compressed - 1)
        if method == 8:
            try:
                decoder = zlib.decompressobj(-15)
                data = decoder.decompress(payload, expanded + 1)
                if len(data) > expanded or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
                    raise ValueError("Tilinpäätöksen pakkauksen koko tai rakenne on virheellinen.")
            except zlib.error as exc:
                raise ValueError("Tilinpäätöksen pakkausta ei voitu avata.") from exc
        else:
            data = payload
        if len(data) != expanded or zlib.crc32(data) & 0xFFFFFFFF != entry["crc"]:
            raise ValueError("Tilinpäätöksen koko tai tarkistussumma ei täsmää.")
        if not zipfile.is_zipfile(io.BytesIO(data)):
            raise ValueError("Ladattu tilinpäätös ei ole kelvollinen yrityskohtainen ZIP.")
        return data

    def _find(self, archives, target, progress):
        # Resolve each bounded batch in newest-first order, irrespective of network completion order.
        with ThreadPoolExecutor(max_workers=INDEX_WORKERS) as executor:
            futures = []
            try:
                for begin in range(0, len(archives), INDEX_WORKERS):
                    batch = archives[begin:begin + INDEX_WORKERS]
                    futures = [executor.submit(self._index, archive) for archive in batch]
                    for index, (archive, future) in enumerate(zip(batch, futures), begin + 1):
                        message = f"Etsitään tilinpäätöstä: {archive['key'].removeprefix('arsredovisningar/')} ({index}/{len(archives)})"
                        while True:
                            if progress:
                                progress(message)
                            try:
                                entries = future.result(timeout=0.5)
                                break
                            except FutureTimeout:
                                if future.done():
                                    raise
                                continue
                        matches = [entry for entry in entries if entry["name"] == target]
                        if len(matches) > 1:
                            raise ValueError("Samassa viikkopaketissa on useita saman yrityksen ja tilikauden tilinpäätöksiä. Lähde pitää tarkistaa käsin.")
                        if matches:
                            return archive, matches[0]
                return None
            finally:
                for future in futures:
                    future.cancel()
                # The context waits for in-flight requests before returning, including cancellation.

    def fetch(self, orgnr: str, period_end: str, progress=None) -> dict:
        if not isinstance(orgnr, str) or not re.fullmatch(r"\d{6}-?\d{4}", orgnr):
            raise ValueError("Anna ruotsalainen 10-numeroinen yritystunnus.")
        orgnr = orgnr.replace("-", "")
        try:
            period = date.fromisoformat(period_end)
            if period.isoformat() != period_end:
                raise ValueError()
        except (TypeError, ValueError) as exc:
            raise ValueError("Anna tilikauden päättymispäivä muodossa VVVV-KK-PP.") from exc
        target = f"{orgnr}_{period_end}.zip"
        if progress:
            progress("Haetaan Bolagsverketin viikkopakettien luetteloa…")
        archives = self._listing()
        def order(archive):
            match = KEY_PATTERN.fullmatch(archive["key"])
            return tuple(int(value) for value in match.groups())
        archives = sorted((a for a in archives if order(a)[0] >= max(2020, period.year)), key=order, reverse=True)
        found = self._find(archives, target, progress)
        if found:
            archive, entry = found
            identity = self._identity(archive)
            data_path = self.cache_dir / target
            meta_path = self.cache_dir / (target + ".json")
            meta = _read_json(meta_path)
            from_cache = False
            if isinstance(meta, dict) and meta.get("archiveIdentity") == identity and data_path.is_file():
                data = data_path.read_bytes() if data_path.stat().st_size <= MAX_FILING else b""
                from_cache = bool(data and hashlib.sha256(data).hexdigest() == meta.get("sha256"))
            if not from_cache:
                data = self._download(archive, entry)
                meta = {"name": target, "url": BASE_URL + "/" + archive["key"], "retrievedAt": _utc_now(),
                        "archiveIdentity": identity, "sha256": hashlib.sha256(data).hexdigest()}
                _write_bytes(data_path, data)
                _write_json(meta_path, meta)
            return {"data": data, "name": target, "url": meta["url"],
                    "retrievedAt": meta["retrievedAt"], "fromCache": from_cache}
        raise ValueError("Yrityksen ja tilikauden digitaalista tilinpäätöstä ei löytynyt Bolagsverketin julkisista viikkopaketeista. Kaikkia tilinpäätöksiä ei ole tässä aineistossa; alkuperäisen tiedoston voi edelleen tuoda käsin.")
