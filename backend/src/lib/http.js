'use strict';

// Helpers for API Gateway HTTP API (payload format 2.0) Lambda responses.

function json(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

function text(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...headers },
    body,
  };
}

// Parsed JSON body, tolerant of base64-encoded payloads.
function jsonBody(event) {
  if (!event || !event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

// Raw request bytes — required for Stripe webhook signature verification.
function rawBody(event) {
  if (!event || !event.body) return Buffer.from('');
  return event.isBase64Encoded
    ? Buffer.from(event.body, 'base64')
    : Buffer.from(event.body, 'utf8');
}

function method(event) {
  return event?.requestContext?.http?.method || event?.httpMethod || 'GET';
}

function header(event, name) {
  const headers = event?.headers || {};
  // HTTP API lowercases header keys, but be defensive.
  return headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
}

module.exports = { json, text, jsonBody, rawBody, method, header };
