import io
import json
from pathlib import Path
import struct
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import urllib.parse
import zipfile

import official


ORGNR = "5561939215"
PERIOD = "2026-06-30"
NAME = f"{ORGNR}_{PERIOD}.zip"


def inner_zip(text="filing"):
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as archive:
        archive.writestr("annual.xhtml", text)
    return data.getvalue()


def outer_zip(entries, compression=zipfile.ZIP_DEFLATED):
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w", compression=compression) as archive:
        for name, payload in entries:
            archive.writestr(name, payload)
    return data.getvalue()


class Response:
    def __init__(self, body, status=200, headers=None):
        self.body = io.BytesIO(body)
        self.status = status
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def read(self, size):
        return self.body.read(size)


class BulkServer:
    def __init__(self, archives, page_size=1000):
        self.archives = archives
        self.page_size = page_size
        self.requests = []
        self.ignore_range = False
        self.bad_content_range = False

    def __call__(self, request, timeout=None):
        parsed = urllib.parse.urlsplit(request.full_url)
        self.requests.append(request)
        if parsed.query:
            query = urllib.parse.parse_qs(parsed.query)
            keys = sorted(self.archives)
            marker = query.get("marker", [None])[0]
            begin = keys.index(marker) + 1 if marker else 0
            page = keys[begin:begin + self.page_size]
            truncated = begin + len(page) < len(keys)
            rows = "".join(f'<Contents><Key>{key}</Key><Size>{len(self.archives[key])}</Size><ETag>etag-{len(self.archives[key])}</ETag><LastModified>2026-10-01T00:00:00Z</LastModified></Contents>' for key in page)
            body = f'<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>{str(truncated).lower()}</IsTruncated><NextMarker>{page[-1] if page else ""}</NextMarker>{rows}</ListBucketResult>'
            return Response(body.encode())
        key = urllib.parse.unquote(parsed.path).removeprefix("/arsredovisningar-bulkfiler/")
        body = self.archives[key]
        if self.ignore_range:
            return Response(body)
        value = request.get_header("Range")
        start, end = map(int, value.removeprefix("bytes=").split("-"))
        part = body[start:end + 1]
        content_range = f"bytes {start}-{end}/{len(body)}" if not self.bad_content_range else "bytes 1-2/3"
        return Response(part, 206, {"Content-Range": content_range, "Content-Length": str(len(part))})


class OfficialTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.cache = Path(self.temporary.name)
        self.reader = official.OfficialFilings(self.cache)
        self.payload = inner_zip()
        self.key = "arsredovisningar/2026/39_1.zip"
        self.server = BulkServer({self.key: outer_zip([(NAME, self.payload)])})
        self.patcher = patch("official.urllib.request.urlopen", side_effect=self.server)
        self.patcher.start()

    def tearDown(self):
        self.patcher.stop()
        self.temporary.cleanup()

    def test_deflate_only_range_requests_and_cached_reuse(self):
        progress = []
        result = self.reader.fetch("556193-9215", PERIOD, progress.append)
        self.assertEqual(result["data"], self.payload)
        self.assertFalse(result["fromCache"])
        self.assertTrue(result["url"].endswith(self.key))
        self.assertIn("+00:00", result["retrievedAt"])
        self.assertTrue(progress)
        range_requests = [r for r in self.server.requests if not urllib.parse.urlsplit(r.full_url).query]
        self.assertEqual(len(range_requests), 5)
        self.assertTrue(all(r.get_header("Range") and r.get_header("If-match") for r in range_requests))
        self.server.requests.clear()
        cached = self.reader.fetch(ORGNR, PERIOD)
        self.assertEqual(cached["data"], self.payload)
        self.assertTrue(cached["fromCache"])
        self.assertEqual(self.server.requests, [])

    def test_stored_payload(self):
        self.server.archives[self.key] = outer_zip([(NAME, self.payload)], zipfile.ZIP_STORED)
        self.assertEqual(self.reader.fetch(ORGNR, PERIOD)["data"], self.payload)

    def test_listing_pagination_newest_archive_and_exact_end(self):
        newer = "arsredovisningar/2026/40_1.zip"
        old = "arsredovisningar/2025/40_1.zip"
        self.server.archives[newer] = outer_zip([(f"{ORGNR}_2026-05-31.zip", inner_zip("wrong end"))])
        self.server.archives[old] = outer_zip([(NAME, inner_zip("older year"))])
        self.server.page_size = 1
        self.assertEqual(self.reader.fetch(ORGNR, PERIOD)["data"], self.payload)
        queries = [urllib.parse.parse_qs(urllib.parse.urlsplit(r.full_url).query) for r in self.server.requests if urllib.parse.urlsplit(r.full_url).query]
        self.assertEqual(len(queries), 3)
        self.assertEqual(queries[1]["marker"], [old])
        self.assertTrue(all(q["prefix"] == ["arsredovisningar/"] for q in queries))
        requested_keys = [r.full_url for r in self.server.requests if not urllib.parse.urlsplit(r.full_url).query]
        self.assertTrue(all(old not in url for url in requested_keys))

    def test_newer_correction_found_even_when_positive_cache_exists(self):
        self.reader.fetch(ORGNR, PERIOD)
        newer = "arsredovisningar/2026/41_2.zip"
        correction = inner_zip("corrected filing")
        self.server.archives[newer] = outer_zip([(NAME, correction)])
        cached_listing = json.loads((self.cache / "archives.json").read_text())
        cached_listing["fetchedAt"] = 0
        (self.cache / "archives.json").write_text(json.dumps(cached_listing))
        result = self.reader.fetch(ORGNR, PERIOD)
        self.assertEqual(result["data"], correction)
        self.assertFalse(result["fromCache"])
        self.assertTrue(result["url"].endswith(newer))

    def test_same_archive_update_invalidates_cached_zip(self):
        self.reader.fetch(ORGNR, PERIOD)
        correction = inner_zip("different size corrected filing")
        self.server.archives[self.key] = outer_zip([(NAME, correction)])
        (self.cache / "archives.json").unlink()
        self.assertEqual(self.reader.fetch(ORGNR, PERIOD)["data"], correction)

    def test_unknown_filing_cannot_reuse_other_period(self):
        with self.assertRaisesRegex(ValueError, "ei löytynyt"):
            self.reader.fetch(ORGNR, "2026-07-31")

    def test_traversal_and_nested_paths_are_not_matches(self):
        self.server.archives = {
            self.key: outer_zip([("../" + NAME, self.payload), ("directory/" + NAME, self.payload), ("\\" + NAME, self.payload)]),
            "arsredovisningar/2026/../41_1.zip": outer_zip([(NAME, self.payload)]),
        }
        with self.assertRaisesRegex(ValueError, "ei löytynyt"):
            self.reader.fetch(ORGNR, PERIOD)

    def test_duplicate_matching_names_require_manual_selection(self):
        with patch("warnings.warn"):
            self.server.archives[self.key] = outer_zip([(NAME, self.payload), (NAME, inner_zip("second"))])
        with self.assertRaisesRegex(ValueError, "useita"):
            self.reader.fetch(ORGNR, PERIOD)

    def test_server_ignoring_ranges_never_downloads_full_archive(self):
        self.server.ignore_range = True
        with self.assertRaisesRegex(ValueError, "Koko viikkopakettia ei ladattu"):
            self.reader.fetch(ORGNR, PERIOD)

    def test_wrong_content_range_rejected(self):
        self.server.bad_content_range = True
        with self.assertRaisesRegex(ValueError, "osittaista latausta"):
            self.reader.fetch(ORGNR, PERIOD)

    def test_payload_crc_is_validated(self):
        data = bytearray(outer_zip([(NAME, self.payload)], zipfile.ZIP_STORED))
        central = data.rfind(b"PK\x01\x02")
        struct.pack_into("<I", data, 14, 123)
        struct.pack_into("<I", data, central + 16, 123)
        self.server.archives[self.key] = bytes(data)
        with self.assertRaisesRegex(ValueError, "tarkistussumma"):
            self.reader.fetch(ORGNR, PERIOD)

    def test_expansion_limit_checked_before_payload_request(self):
        data = bytearray(self.server.archives[self.key])
        central = data.find(b"PK\x01\x02")
        struct.pack_into("<I", data, central + 24, official.MAX_FILING + 1)
        self.server.archives[self.key] = bytes(data)
        with self.assertRaisesRegex(ValueError, "kokorajan"):
            self.reader.fetch(ORGNR, PERIOD)
        self.assertEqual(len([r for r in self.server.requests if r.get_header("Range")]), 2)

    def test_zip64_sentinel_rejected(self):
        data = bytearray(self.server.archives[self.key])
        eocd = data.rfind(b"PK\x05\x06")
        struct.pack_into("<I", data, eocd + 12, 0xFFFFFFFF)
        self.server.archives[self.key] = bytes(data)
        with self.assertRaisesRegex(ValueError, "ZIP64"):
            self.reader.fetch(ORGNR, PERIOD)

    def test_unsupported_compression_rejected(self):
        self.server.archives[self.key] = outer_zip([(NAME, self.payload)], zipfile.ZIP_BZIP2)
        with self.assertRaisesRegex(ValueError, "pakattua"):
            self.reader.fetch(ORGNR, PERIOD)

    def test_corrupted_cached_payload_downloaded_again(self):
        self.reader.fetch(ORGNR, PERIOD)
        (self.cache / NAME).write_bytes(b"broken")
        result = self.reader.fetch(ORGNR, PERIOD)
        self.assertEqual(result["data"], self.payload)
        self.assertFalse(result["fromCache"])

    def test_input_validation_avoids_network(self):
        for orgnr, period in [("../../etc", PERIOD), (ORGNR, "2026-06-31"), (ORGNR, "20260630"), (ORGNR, None)]:
            with self.subTest(orgnr=orgnr, period=period), self.assertRaises(ValueError):
                self.reader.fetch(orgnr, period)
        self.assertEqual(self.server.requests, [])

    def test_parallel_completion_preserves_newest_filing_and_root_progress(self):
        newest = "arsredovisningar/2026/41_1.zip"
        old_completed = threading.Event()
        order = []
        self.server.archives[newest] = outer_zip([(NAME, inner_zip("newest"))])
        original_index = self.reader._index
        def out_of_order(archive):
            if archive["key"] == newest:
                self.assertTrue(old_completed.wait(2))
            result = original_index(archive)
            order.append(archive["key"])
            if archive["key"] == self.key:
                old_completed.set()
            return result
        main_thread = threading.get_ident()
        progress_threads = []
        with patch.object(self.reader, "_index", side_effect=out_of_order):
            result = self.reader.fetch(ORGNR, PERIOD, lambda _: progress_threads.append(threading.get_ident()))
        self.assertEqual(order, [self.key, newest])
        self.assertEqual(result["data"], inner_zip("newest"))
        self.assertTrue(all(identity == main_thread for identity in progress_threads))

    def test_failed_newer_archive_prevents_choosing_older_match(self):
        newest = "arsredovisningar/2026/41_1.zip"
        self.server.archives[newest] = outer_zip([(NAME, self.payload)])
        original_index = self.reader._index
        def fail_newer(archive):
            if archive["key"] == newest:
                raise ValueError("newer archive failed")
            return original_index(archive)
        with patch.object(self.reader, "_index", side_effect=fail_newer), self.assertRaisesRegex(ValueError, "newer archive failed"):
            self.reader.fetch(ORGNR, PERIOD)
        self.assertFalse((self.cache / NAME).exists())

    def test_cancellation_joins_all_inflight_workers(self):
        newest = "arsredovisningar/2026/41_1.zip"
        self.server.archives[newest] = outer_zip([(NAME, self.payload)])
        active, completed = [], []
        started = threading.Event()
        def slow_index(archive):
            active.append(archive["key"])
            started.set()
            time.sleep(0.05)
            completed.append(archive["key"])
            return []
        main_thread = threading.get_ident()
        def cancel(message):
            self.assertEqual(threading.get_ident(), main_thread)
            if "Etsitään" in message:
                self.assertTrue(started.wait(2))
                raise ValueError("cancelled")
        with patch.object(self.reader, "_index", side_effect=slow_index), self.assertRaisesRegex(ValueError, "cancelled"):
            self.reader.fetch(ORGNR, PERIOD, cancel)
        self.assertTrue(active)
        self.assertEqual(sorted(active), sorted(completed))
        self.assertFalse((self.cache / NAME).exists())

    def test_parallel_windows_have_at_most_four_workers(self):
        self.server.archives = {f"arsredovisningar/2026/{week}_1.zip": outer_zip([]) for week in range(1, 10)}
        lock = threading.Lock()
        active = maximum = 0
        seen = []
        def bounded_index(archive):
            nonlocal active, maximum
            with lock:
                active += 1
                maximum = max(maximum, active)
                seen.append(archive["key"])
            time.sleep(0.01)
            with lock:
                active -= 1
            return []
        with patch.object(self.reader, "_index", side_effect=bounded_index), self.assertRaisesRegex(ValueError, "ei löytynyt"):
            self.reader.fetch(ORGNR, PERIOD)
        self.assertEqual(len(seen), 9)
        self.assertEqual(maximum, 4)
        self.assertEqual(active, 0)


if __name__ == "__main__":
    unittest.main()
