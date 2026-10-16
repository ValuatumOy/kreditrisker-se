import base64
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen
from urllib.error import HTTPError

import server
from test_compare import SALES, bundle, html
from test_filing import document, numeric, archive


class AutomaticTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.model = bundle()['modeldata']
        self.model['followedModelId'] = 52
        self.requests = []
        self.reject = False
        owner = self

        class Api(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def respond(self, body):
                self.send_response(401 if owner.reject else 200)
                self.end_headers()
                self.wfile.write(json.dumps(body).encode())

            def do_GET(self):
                owner.requests.append(self.path)
                if self.path.startswith('/rest/company?') and self.path != '/rest/company?code=556193-9215':
                    self.respond([])
                    return
                self.respond([{'companyCode': '556193-9215', 'companyName': 'Test AB', 'companyId': 60,
                    'models': [{'followedModelId': 52, 'analystName': 'Data Import'}]}])

            def do_POST(self):
                owner.requests.append(self.path)
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                owner.assertEqual(body['fids'], [52])
                owner.assertFalse(body['includeEstimates'])
                self.respond({'52': owner.model})

        api = ThreadingHTTPServer(('127.0.0.1', 0), Api)
        self.start(api)
        env = patch.dict(os.environ, {'PUBLIC_VALUATUM_API_BASE_URL': f'http://127.0.0.1:{api.server_port}',
                                      'SECRET_VALUATUM_API_TOKEN': 'test-only'})
        env.start()
        self.addCleanup(env.stop)
        source = archive([('annual.xhtml', document(numeric('427568195')))])
        self.source = source
        self.fetch = patch.object(server.OfficialFilings, 'fetch', return_value={
            'data': source, 'name': '5561939215_2026-06-30.zip', 'url': 'https://official.example/archive.zip',
            'retrievedAt': '2026-10-14T10:00:00+00:00', 'fromCache': False}).start()
        self.addCleanup(patch.stopall)
        patch.object(server, 'fetch_website', return_value=(html(), 'https://site.example/company/')).start()
        (root / 'bundle.json').write_text(json.dumps(bundle()), encoding='utf-8')
        (root / 'config.json').write_text(json.dumps([SALES]), encoding='utf-8')
        with socket.socket() as port:
            port.bind(('127.0.0.1', 0))
            number = port.getsockname()[1]
        opts = SimpleNamespace(config=root / 'config.json', bundle=root / 'bundle.json', filing=None, source_url='',
            output=root / 'cache', port=number, site_origin='https://site.example', system_url='', node=shutil.which('node'), catalog=None)
        self.app = server.create_server(opts)
        self.start(self.app)
        self.origin = f'http://127.0.0.1:{number}'

    def start(self, service):
        thread = threading.Thread(target=service.serve_forever, kwargs={'poll_interval': 0.02}, daemon=True)
        thread.start()
        self.addCleanup(service.server_close)
        self.addCleanup(service.shutdown)

    def request(self, path, body=None):
        request = Request(self.origin + path, data=json.dumps(body).encode() if body is not None else None,
            headers={'Origin': self.origin, 'Content-Type': 'application/json'})
        with urlopen(request, timeout=10) as response:
            return json.load(response)

    def compare(self):
        return self.request('/api/compare', {'company': '52', 'period': '2026-06-30',
            'websiteUrl': 'https://site.example/company/', 'automatic': True})

    def finished(self):
        end = time.monotonic() + 10
        while time.monotonic() < end:
            state = self.request('/api/state')
            if state['job']['status'] != 'running':
                return state
            time.sleep(0.03)
        self.fail('Local test acquisition did not finish')

    def test_search_and_fresh_rest_through_real_node_client(self):
        for orgnr in ('556193-9215', '5561939215'):
            found = self.request('/api/search?q=' + orgnr)
            self.assertEqual(found[0]['fid'], '52')
        self.compare()
        state = self.finished()
        self.assertEqual(state['job']['status'], 'done')
        self.assertEqual(state['report']['summary']['match'], 1)
        self.assertEqual(state['report']['provenance']['backendMode'], 'live')
        self.assertEqual(state['report']['provenance']['filingSha256'], hashlib.sha256(self.source).hexdigest())
        self.assertEqual(state['report']['provenance']['officialRetrievedAt'], '2026-10-14T10:00:00+00:00')
        self.fetch.assert_called_once()
        self.assertIn('/rest/modeldata', self.requests)
        self.assertEqual(self.requests.count('/rest/company?code=556193-9215'), 2)

    def test_wrong_rest_entity_fails_before_original_acquisition(self):
        self.model = copy.deepcopy(self.model)
        self.model['companyCode'] = '5561939216'
        self.compare()
        state = self.finished()
        self.assertEqual(state['job']['status'], 'error')
        self.assertIn('yritystunnus', state['job']['message'])
        self.assertIsNone(state['report'])
        self.fetch.assert_not_called()

    def test_wrong_rest_model_fails_before_original_acquisition(self):
        self.model['followedModelId'] = 999
        self.compare()
        state = self.finished()
        self.assertEqual(state['job']['status'], 'error')
        self.assertIn('yritysmallia', state['job']['message'])
        self.assertIsNone(state['report'])
        self.fetch.assert_not_called()

    def test_failed_new_acquisition_clears_old_source_and_report(self):
        self.compare()
        self.assertEqual(self.finished()['report']['summary']['match'], 1)
        self.fetch.side_effect = ValueError('Tilinpäätöstä ei löytynyt.')
        self.compare()
        state = self.finished()
        self.assertEqual(state['job']['status'], 'error')
        self.assertEqual(state['documents'], [])
        self.assertIsNone(state['report'])

    def test_only_one_acquisition_and_cancel_never_publishes_report(self):
        started, released = threading.Event(), threading.Event()
        def blocked(orgnr, end, progress):
            started.set()
            released.wait(5)
            progress('Haetaan…')
            return self.fetch.return_value
        self.fetch.side_effect = blocked
        job = self.compare()['job']
        self.assertTrue(started.wait(5))
        with self.assertRaises(HTTPError) as rejected:
            self.compare()
        self.assertEqual(rejected.exception.code, 400)
        rejected.exception.close()
        self.request('/api/cancel', {'id': job['id']})
        released.set()
        state = self.finished()
        self.assertEqual(state['job']['status'], 'error')
        self.assertIn('keskeytettiin', state['job']['message'])
        self.assertIsNone(state['report'])

    def test_manual_fallback_after_automatic_error_has_no_stale_job(self):
        self.fetch.side_effect = ValueError('Tilinpäätöstä ei löytynyt.')
        self.compare()
        self.assertEqual(self.finished()['job']['status'], 'error')
        self.request('/api/import', {'kind': 'filing', 'name': 'company.zip',
            'data': base64.b64encode(self.source).decode()})
        result = self.request('/api/compare', {'company': '52', 'period': '2026-06-30',
            'websiteUrl': 'https://site.example/company/', 'automatic': False})
        self.assertIsNone(result['job'])
        self.assertEqual(result['report']['summary']['match'], 1)


if __name__ == '__main__':
    unittest.main()
