'use strict';

// Client for the PDF report engine (docs/report_generation_api.md):
// an AWS Lambda Function URL in eu-west-1, IAM/SigV4 auth, async job API.
//   POST /jobs            → 202 { jobId }
//   GET  /jobs/{jobId}     → { status, s3Url?, error? }
// On DONE, s3Url is a presigned link valid 1h; we re-GET to mint a fresh one if
// needed, so the poller always downloads from a just-fetched URL.

const { SignatureV4 } = require('@aws-sdk/signature-v4');
const { HttpRequest } = require('@aws-sdk/protocol-http');
const { defaultProvider } = require('@aws-sdk/credential-provider-node');
const { Sha256 } = require('@aws-crypto/sha256-js');
const config = require('./config');

function signer() {
  return new SignatureV4({
    service: 'lambda',
    region: config.reportEngineRegion,
    credentials: defaultProvider(),
    sha256: Sha256,
  });
}

// Sign with SigV4 (service=lambda) and send via global fetch.
async function signedFetch(httpMethod, urlStr, bodyObj) {
  if (!config.reportEngineUrl) {
    throw new Error('REPORT_ENGINE_URL is not set');
  }
  const url = new URL(urlStr);
  const body = bodyObj === undefined ? undefined : JSON.stringify(bodyObj);
  const request = new HttpRequest({
    method: httpMethod,
    protocol: url.protocol,
    hostname: url.hostname,
    path: url.pathname + (url.search || ''),
    headers: {
      host: url.hostname,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body,
  });
  const signed = await signer().sign(request);
  return fetch(url.toString(), {
    method: httpMethod,
    headers: signed.headers,
    body: signed.body,
  });
}

// POST /jobs — submit a render job. Returns the jobId (26-char ULID).
async function submitJob({ username, templateName, params }) {
  const res = await signedFetch('POST', `${config.reportEngineUrl}/jobs`, {
    username,
    templateName,
    params,
    output: 'pdf',
  });
  const text = await res.text();
  if (res.status !== 202) {
    throw new Error(`report engine POST /jobs failed: ${res.status} ${text}`);
  }
  const data = JSON.parse(text || '{}');
  if (!data.jobId) throw new Error(`report engine POST /jobs returned no jobId: ${text}`);
  return data.jobId;
}

// GET /jobs/{jobId} — job status. Returns { status, s3Url?, error?, ... }.
async function getJob(jobId) {
  const res = await signedFetch('GET', `${config.reportEngineUrl}/jobs/${encodeURIComponent(jobId)}`);
  const text = await res.text();
  if (res.status !== 200) {
    throw new Error(`report engine GET /jobs/${jobId} failed: ${res.status} ${text}`);
  }
  return JSON.parse(text || '{}');
}

// Download the finished PDF from the presigned S3 URL (no SigV4 — the URL is
// already signed). Returns a Buffer.
async function downloadPdf(s3Url) {
  const res = await fetch(s3Url);
  if (!res.ok) throw new Error(`PDF download failed: ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

module.exports = { submitJob, getJob, downloadPdf };
