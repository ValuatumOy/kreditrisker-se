'use strict';

// Client for the Valuatum REST /reports endpoint (docs/valuatum_rest_api.yaml).
// Unlike the async report engine, this returns the finished PDF synchronously in
// a single GET, so the poller calls it directly instead of polling a job:
//   GET {VALUATUM_REST_URL}/reports/{reportName}?fid={fid}&lang={lang}
//     → 200 application/pdf
// The base URL and bearer token live in the application secret bundle
// (VALUATUM_REST_URL, VALUATUM_REST_TOKEN — see secrets.js). This is the same
// authenticated endpoint the FI directory uses; it is NOT the public
// CloudFront-fronted "free report" link, which 403s for server-side callers.

const { loadSecrets } = require('./secrets');

// Fetch a Jasper PDF report for a single followed model. Returns a Buffer.
async function generateValuatumReport({ reportName, fid, lang, currency }) {
  const { VALUATUM_REST_URL, VALUATUM_REST_TOKEN } = await loadSecrets();
  if (!VALUATUM_REST_URL) throw new Error('VALUATUM_REST_URL is not set');
  if (!VALUATUM_REST_TOKEN) throw new Error('VALUATUM_REST_TOKEN is not set');
  if (!fid) throw new Error('generateValuatumReport: fid is required');

  const base = VALUATUM_REST_URL.replace(/\/$/, '');
  const url =
    `${base}/reports/${encodeURIComponent(reportName)}` +
    `?fid=${encodeURIComponent(fid)}&lang=${encodeURIComponent(lang || 'en')}` +
    // The report only accepts currencies enabled for its data set — DK
    // financials require DKK (EUR, the endpoint default, is rejected).
    (currency ? `&currency=${encodeURIComponent(currency)}` : '');

  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${VALUATUM_REST_TOKEN}`,
      accept: 'application/pdf',
    },
  });

  if (!res.ok) {
    // Surface a snippet of the error body to aid the admin alert / logs.
    const body = await res.text().catch(() => '');
    throw new Error(
      `Valuatum /reports/${reportName} failed: ${res.status} ${body.slice(0, 300)}`,
    );
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

module.exports = { generateValuatumReport };
