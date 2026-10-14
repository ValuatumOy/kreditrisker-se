"""Loopback-only, read-only statement viewer and comparison service."""
import argparse
import base64
import hashlib
import json
import os
import re
import sys
import subprocess
import threading
import urllib.parse
import urllib.request
import uuid
from datetime import date, datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from compare import compare
from filing import read_filing
from official import OfficialFilings

STATIC = Path(__file__).parent / 'static'
MAX_BODY = 30 * 1024 * 1024


def orgnr(value):
    digits = re.sub(r'\D', '', str(value or ''))
    return digits[2:] if len(digits) == 12 and digits.startswith('16') else digits


def bundle_meta(bundle):
    md = bundle.get('modeldata', {})
    if not isinstance(md.get('dataMap'), dict) or not md.get('companyCode'):
        raise ValueError('Valuatumin JSON-tiedostossa pitää olla modeldata, dataMap ja companyCode.')
    periods = []
    for row in md['dataMap'].values():
        end = str(row.get('cr_fiscal_year_end', '')).split('.')[0]
        if re.fullmatch(r'\d{8}', end):
            periods.append(f'{end[:4]}-{end[4:6]}-{end[6:]}')
    return {'name': md.get('companyName', 'Yritys'), 'orgnr': orgnr(md['companyCode']),
            'fid': bundle.get('fid', md.get('followedModelId')), 'periods': sorted(set(periods), reverse=True),
            'retrievedAt': bundle.get('retrievedAt'), 'currency': md.get('currency')}


def read_bundle(data):
    obj = json.loads(data)
    if not isinstance(obj, dict):
        raise ValueError('Valuatumin datan pitää olla JSON-objekti.')
    bundle_meta(obj)
    return obj


def safe_url(url):
    p = urllib.parse.urlparse(url)
    if p.scheme not in ('http', 'https') or not p.hostname or p.username or p.password:
        raise ValueError('Linkin pitää olla http- tai https-osoite ilman tunnuksia.')
    return url


def fetch_website(url):
    safe_url(url)
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Kreditrisker-local-audit/1'}), timeout=25) as response:
        body = response.read(5 * 1024 * 1024 + 1)
        if len(body) > 5 * 1024 * 1024:
            raise ValueError('Yrityssivun vastaus on liian suuri.')
        return body.decode('utf-8'), response.url


def create_server(opts):
    config = json.loads(Path(opts.config).read_text(encoding='utf-8'))
    initial_bundle = read_bundle(Path(opts.bundle).read_bytes())
    initial_id = str(bundle_meta(initial_bundle)['fid'])
    loaded = {initial_id: initial_bundle}
    catalog = {initial_id: {'id': initial_id, **bundle_meta(initial_bundle)}}
    if getattr(opts, 'catalog', None):
        for item in json.loads(Path(opts.catalog).read_text(encoding='utf-8')):
            key = str(item['fid'])
            catalog.setdefault(key, {'id': key, **item, 'periods': []})
    api_ready = bool(os.environ.get('PUBLIC_VALUATUM_API_BASE_URL') and os.environ.get('SECRET_VALUATUM_API_TOKEN'))
    live_bundles = set()
    source = None
    source_name = ''
    source_hash = None
    if opts.filing:
        raw = Path(opts.filing).read_bytes()
        source = read_filing(raw, Path(opts.filing).name)
        source_hash = hashlib.sha256(raw).hexdigest()
        source_name = Path(opts.filing).name
    latest = None
    lock = threading.Lock()
    origins = {f'http://127.0.0.1:{opts.port}', f'http://localhost:{opts.port}'}
    output = Path(opts.output)
    output.mkdir(parents=True, exist_ok=True)
    filings = OfficialFilings(output / 'official')
    job = None

    def valuatum(mode, query):
        result = subprocess.run([opts.node, str(Path(__file__).with_name('valuatum.ts')), mode, str(query)],
                                cwd=Path(__file__).resolve().parents[2], capture_output=True, timeout=300,
                                env={**os.environ, 'SE_AUDIT_REST_CACHE': str(output / 'rest')})
        try:
            data = json.loads(result.stdout)
        except (ValueError, UnicodeDecodeError):
            raise ValueError('Valuatumin API-vastausta ei voitu lukea. Tarkista paikalliset asetukset.')
        if result.returncode or isinstance(data, dict) and data.get('error'):
            raise ValueError(data.get('error', 'Valuatumin API-haku epäonnistui.'))
        return data

    def company_bundle(key):
        expected = catalog[key]
        if api_ready:
            bundle = valuatum('bundle', expected['fid'])
            if bundle_meta(bundle)['orgnr'] != expected['orgnr']:
                raise ValueError('Valuatumin yritystunnus ei vastaa valittua yritystä.')
            if str(bundle.get('fid')) != str(expected['fid']) or str(bundle['modeldata'].get('followedModelId')) != str(expected['fid']):
                raise ValueError('Valuatumin luvut eivät vastaa valittua yritysmallia.')
            loaded[key] = bundle
            live_bundles.add(key)
            catalog[key] = {'id': key, **bundle_meta(bundle)}
        if key not in loaded:
            raise ValueError('Yrityksen luvut vaativat Valuatumin API-tunnuksen paikallisiin asetuksiin.')
        return loaded[key]

    def reconcile(bundle, period, url):
        nonlocal latest
        website_error = None
        try:
            html, final_url = fetch_website(url)
        except Exception as error:
            html, final_url = '', url
            website_error = f'Yrityssivua ei voitu lukea: {type(error).__name__}. Avaa linkki käsintarkistusta varten.'
        result = compare(source, bundle, html, period, config)
        result['provenance'] = {'filingName': source_name, 'filingSha256': source_hash,
            'documents': [{'name': d['name'], 'sha256': d['sha256']} for d in source['documents']],
            'officialArchiveUrl': opts.source_url, 'websiteUrl': final_url,
            'checkedAt': datetime.now(timezone.utc).isoformat(), 'backendRetrievedAt': bundle_meta(bundle)['retrievedAt'],
            'backendMode': 'live' if str(bundle_meta(bundle)['fid']) in live_bundles else 'saved',
            'officialRetrievedAt': source_retrieved_at}
        if website_error:
            result['warnings'].append(website_error)
        if job and job['status'] == 'running' and job.get('cancelled'):
            raise ValueError('Haku keskeytettiin.')
        (output / 'last-report.json').write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
        latest = result

    source_retrieved_at = None

    def start_job(request, company_only=False):
        nonlocal job, latest, source, source_name, source_hash, source_retrieved_at
        if job and job['status'] == 'running':
            raise ValueError('Edellinen haku on vielä kesken.')
        key = str(request['company'])
        if key not in catalog:
            raise ValueError('Tuntematon yritys. Hae yritys ensin nimellä tai tunnuksella.')
        period = request.get('period')
        url = request.get('websiteUrl')
        if not company_only:
            date.fromisoformat(period)
            safe_url(url)
        latest, source, source_name, source_hash = None, None, '', None
        source_retrieved_at = None
        opts.source_url = ''
        job = {'id': uuid.uuid4().hex, 'status': 'running', 'message': 'Haetaan Valuatumin tilinpäätösluvut…' if api_ready else 'Luetaan tallennetut Valuatumin luvut…', 'company': key}

        def progress(text):
            with lock:
                if job.get('cancelled'):
                    raise ValueError('Haku keskeytettiin.')
                job['message'] = text

        def run():
            nonlocal source, source_name, source_hash, source_retrieved_at
            try:
                bundle = company_bundle(key)
                progress('Etsitään alkuperäistä tilinpäätöstä…')
                if not company_only:
                    if period not in bundle_meta(bundle)['periods']:
                        raise ValueError('Valittua tilikautta ei löytynyt Valuatumin luvuista.')
                    downloaded = filings.fetch(bundle_meta(bundle)['orgnr'], period, progress)
                    parsed = read_filing(downloaded['data'], downloaded['name'])
                    with lock:
                        source, source_name = parsed, downloaded['name']
                        source_hash = hashlib.sha256(downloaded['data']).hexdigest()
                        opts.source_url = downloaded['url']
                        source_retrieved_at = downloaded['retrievedAt']
                    progress('Luetaan yrityssivu ja verrataan luvut…')
                    reconcile(bundle, period, url)
                with lock:
                    job.update(status='done', message='Luvut haettu.' if company_only else 'Vertailu valmis.')
            except Exception as error:
                with lock:
                    job.update(status='error', message=str(error) if isinstance(error, ValueError) else 'Haku epäonnistui. Yritä uudelleen.')
        threading.Thread(target=run, daemon=True).start()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send(self, data, content_type='application/json', status=200, document=False):
            encoded = json.dumps(data, ensure_ascii=False, allow_nan=False).encode('utf-8') if content_type == 'application/json' else data.encode('utf-8') if isinstance(data, str) else data
            self.send_response(status)
            self.send_header('Content-Type', content_type + ('; charset=utf-8' if content_type != 'application/octet-stream' else ''))
            self.send_header('Content-Length', str(len(encoded)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            if document:
                self.send_header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox")
            else:
                self.send_header('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'")
            self.end_headers()
            self.wfile.write(encoded)

        def valid_host(self):
            return self.headers.get('Host') in (f'127.0.0.1:{opts.port}', f'localhost:{opts.port}')

        def state(self):
            docs = [{k: doc.get(k) for k in ('name', 'title', 'kind')} for doc in source['documents']] if source else []
            return {'companies': list(catalog.values()), 'apiReady': api_ready, 'job': dict(job) if job else None,
                    'documents': docs, 'sourceName': source_name, 'sourceUrl': opts.source_url,
                    'sourcePeriods': source.get('periods', []) if source else [],
                    'siteOrigin': opts.site_origin, 'systemUrl': opts.system_url, 'report': latest}

        def do_GET(self):
            if not self.valid_host():
                return self.send({'error': 'Väärä paikallinen osoite.'}, status=403)
            route = urllib.parse.urlparse(self.path).path
            if route == '/api/state':
                return self.send(self.state())
            if route == '/api/report':
                return self.send(latest or {'error': 'Vertailua ei ole vielä tehty.'})
            if route == '/api/search':
                query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get('q', [''])[0].strip()
                try:
                    if len(query) < 2 or len(query) > 150:
                        raise ValueError('Kirjoita vähintään kaksi merkkiä.')
                    if api_ready:
                        found = valuatum('search', query)
                        with lock:
                            for item in found:
                                key = str(item['fid'])
                                catalog.setdefault(key, {'id': key, **item, 'periods': []})
                        return self.send([catalog[str(item['fid'])] for item in found])
                    normalized = orgnr(query) if any(c.isdigit() for c in query) else query.lower()
                    return self.send([item for item in catalog.values() if normalized in item['name'].lower() or normalized in item['orgnr']][:30])
                except (ValueError, OSError, subprocess.TimeoutExpired) as error:
                    return self.send({'error': str(error)}, status=400)
            if route.startswith('/filing/') and source:
                try:
                    index = int(route.rsplit('/', 1)[1])
                    if index < 0:
                        raise ValueError()
                    doc = source['documents'][index]
                    html = doc.get('viewerHtml', doc['html'])
                    html = html.replace('</head>', '<style>:target{background:#fff1b8;outline:2px solid #76561d;scroll-margin-top:4rem}</style></head>', 1)
                    return self.send(html, 'text/html', document=True)
                except (ValueError, IndexError):
                    return self.send({'error': 'Asiakirjaa ei löydy.'}, status=404)
            paths = {'/': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css'}
            if route in paths:
                types = {'/': 'text/html', '/app.js': 'text/javascript', '/styles.css': 'text/css'}
                return self.send((STATIC / paths[route]).read_bytes(), types[route])
            return self.send({'error': 'Sivua ei löydy.'}, status=404)

        def do_POST(self):
            nonlocal source, source_name, source_hash, source_retrieved_at, latest, job
            if not self.valid_host() or self.headers.get('Origin') not in origins:
                return self.send({'error': 'Vain paikallisen työkalun pyynnöt sallitaan.'}, status=403)
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if length < 1 or length > MAX_BODY:
                    raise ValueError('Tiedosto on liian suuri. Valitse yrityksen ZIP/XHTML, ei koko viikkopakettia.')
                request = json.loads(self.rfile.read(length))
                route = urllib.parse.urlparse(self.path).path
                with lock:
                    if route == '/api/cancel':
                        if job and job['status'] == 'running' and request.get('id') == job['id']:
                            job.update(cancelled=True, message='Keskeytetään haku…')
                        return self.send(self.state())
                    if route in ('/api/company', '/api/compare') and (route == '/api/company' or request.get('automatic')):
                        start_job(request, company_only=route == '/api/company')
                        return self.send(self.state())
                    if job and job['status'] == 'running':
                        raise ValueError('Odota ensin haun valmistumista.')
                    job = None
                    if route == '/api/import':
                        raw = base64.b64decode(request['data'], validate=True)
                        if request['kind'] == 'filing':
                            source = read_filing(raw, request['name'])
                            source_hash = hashlib.sha256(raw).hexdigest()
                            source_name = request['name']
                            opts.source_url = ''
                            source_retrieved_at = None
                        elif request['kind'] == 'backend':
                            bundle = read_bundle(raw)
                            key = str(bundle_meta(bundle)['fid'])
                            loaded[key] = bundle
                            catalog[key] = {'id': key, **bundle_meta(bundle)}
                            live_bundles.discard(key)
                        else:
                            raise ValueError('Tuntematon tiedostotyyppi.')
                        latest = None
                        return self.send(self.state())
                    if route != '/api/compare':
                        return self.send({'error': 'Toimintoa ei löydy.'}, status=404)
                    if not source:
                        raise ValueError('Valitse ensin yrityksen tilinpäätös ZIP- tai XHTML-tiedostona.')
                    bundle = loaded[str(request['company'])]
                    meta = bundle_meta(bundle)
                    period = request['period']
                    date.fromisoformat(period)
                    url = safe_url(request['websiteUrl'])
                    reconcile(bundle, period, url)
                    return self.send(self.state())
            except (ValueError, KeyError, TypeError, OSError) as error:
                return self.send({'error': str(error)}, status=400)

    return ThreadingHTTPServer(('127.0.0.1', opts.port), Handler)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    p = argparse.ArgumentParser()
    p.add_argument('--config', required=True)
    p.add_argument('--bundle', required=True)
    p.add_argument('--filing')
    p.add_argument('--port', type=int, default=4332)
    p.add_argument('--site-origin', default='https://d3po43lod2ykoc.cloudfront.net')
    p.add_argument('--system-url', default='')
    p.add_argument('--source-url', default='')
    p.add_argument('--output', required=True)
    p.add_argument('--catalog')
    p.add_argument('--node', default='node')
    opts = p.parse_args()
    if not 1024 <= opts.port <= 65535:
        p.error('Port must be between 1024 and 65535')
    for url in (opts.site_origin, opts.system_url, opts.source_url):
        if url:
            safe_url(url)
    server = create_server(opts)
    print(f'Ruotsin tilinpäätösten tarkistus: http://127.0.0.1:{opts.port}/', flush=True)
    print('Paikallinen työkalu. Tilinpäätöksiä tai API-tunnuksia ei julkaista nettisivuille.', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()
