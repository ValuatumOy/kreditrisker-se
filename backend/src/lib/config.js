'use strict';

// Centralized, non-secret configuration sourced from Lambda environment
// variables. Secret values (Stripe keys, Valuatum REST credentials) live in
// Secrets Manager — see secrets.js. Email sending needs no secret: SES
// authenticates through the Lambda execution role.

function intEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) ? value : fallback;
}

function strEnv(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === null || value === '' ? fallback : value;
}

const config = {
  region: strEnv('AWS_REGION', 'eu-west-1'),

  // Set to a LocalStack endpoint (e.g. http://localhost:4566) for local dev.
  // Empty in production → the SDK uses the real AWS endpoints.
  awsEndpoint: strEnv('AWS_ENDPOINT_URL', ''),

  // DynamoDB orders table (name injected by CDK). Holds the async job state
  // (jobId ↔ paymentIntent ↔ email ↔ status) across the webhook → poller gap.
  ordersTable: strEnv('ORDERS_TABLE', 'CreditReports-Orders'),
  // GSI used by the poller to list non-terminal orders without a full scan.
  ordersStatusIndex: strEnv('ORDERS_STATUS_INDEX', 'StatusIndex'),
  creditsTable: strEnv('CREDITS_TABLE', 'CreditReports-Credits'),
  creditsNotificationIndex: strEnv(
    'CREDITS_NOTIFICATION_INDEX',
    'NotificationIndex'
  ),

  // Public site origin (used in Stripe redirect URLs, and as the allowed CORS
  // origin if the browser calls the API cross-origin). This is the host the
  // Astro site is actually served on — companies.creditreports.dk — NOT the apex.
  contactEmail: strEnv('CONTACT_EMAIL', ''),
  siteUrl: strEnv('SITE_URL', 'https://www.kreditrisker.se').replace(/\/$/, ''),

  // Email (Amazon SES v2, same region as this stack). Sender is an address on
  // the verified valuatum.com SES domain identity. Internal failure alerts go to
  // the same address as the FI flow. The customer-facing footer points questions
  // to contact@creditreports.dk (just a mailto link in the body — needs no SES
  // configuration).
  fromEmail: strEnv('FROM_EMAIL', 'noreply@valuatum.com'),
  adminEmail: strEnv('ADMIN_EMAIL', 'luottoriskiraportti202605@valuatum.com'),
  // SES configuration set (name injected by CDK) — applies bounce/complaint
  // suppression and publishes adverse events to SNS. May be empty during local
  // development; deployed environments always get a real value.
  sesConfigurationSet: strEnv('SES_CONFIGURATION_SET', ''),

  // ── PDF report engine (see docs/report_generation_api.md) ────────────────
  // AWS Lambda Function URL, IAM/SigV4 auth, async job API.
  reportEngineUrl: strEnv('REPORT_ENGINE_URL', '').replace(/\/$/, ''),
  reportEngineRegion: strEnv('REPORT_ENGINE_REGION', 'eu-west-1'),
  // `username` field sent with every job — identifies this caller in the engine.
  reportUsername: strEnv('REPORT_ENGINE_USERNAME', 'kreditrisker.se'),

  // Poller timing guards (minutes).
  // Below CLAIM_GRACE a claimed-but-jobless order is assumed mid-submit.
  claimGraceMinutes: intEnv('CLAIM_GRACE_MINUTES', 2),
  // Above MAX_GENERATION a still-running job is failed + its hold released, so a
  // stuck job can't creep toward Stripe's 7-day capture window.
  maxGenerationMinutes: intEnv('MAX_GENERATION_MINUTES', 30),

  // Secrets Manager: a single JSON secret holding STRIPE_SECRET_KEY,
  // STRIPE_WEBHOOK_SECRET and the Valuatum REST credentials.
  appSecretsArn: strEnv('APP_SECRETS_ARN', ''),
};

module.exports = config;
