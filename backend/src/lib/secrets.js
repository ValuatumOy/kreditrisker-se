'use strict';

const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const config = require('./config');

// Loads the application secret bundle (Stripe keys + Valuatum REST credentials)
// from Secrets Manager once per warm Lambda container. Falls back to process.env
// for local/dev runs. Email sending needs no entry here: SES authenticates
// through the Lambda execution role.

let cached = null;

async function loadSecrets() {
  if (cached) return cached;

  // Local/dev fallback: read straight from the environment.
  if (!config.appSecretsArn) {
    cached = {
      STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || '',
      STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || '',
      VALUATUM_REST_URL: process.env.VALUATUM_REST_URL || '',
      VALUATUM_REST_TOKEN: process.env.VALUATUM_REST_TOKEN || '',
    };
    return cached;
  }

  const clientConfig = { region: config.region };
  if (config.awsEndpoint) clientConfig.endpoint = config.awsEndpoint;
  const client = new SecretsManagerClient(clientConfig);
  const res = await client.send(new GetSecretValueCommand({ SecretId: config.appSecretsArn }));
  const parsed = JSON.parse(res.SecretString || '{}');

  cached = {
    STRIPE_SECRET_KEY: parsed.STRIPE_SECRET_KEY || '',
    STRIPE_WEBHOOK_SECRET: parsed.STRIPE_WEBHOOK_SECRET || '',
    VALUATUM_REST_URL: parsed.VALUATUM_REST_URL || '',
    VALUATUM_REST_TOKEN: parsed.VALUATUM_REST_TOKEN || '',
  };
  return cached;
}

module.exports = { loadSecrets };
