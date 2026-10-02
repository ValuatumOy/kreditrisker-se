'use strict';

const Stripe = require('stripe');
const { loadSecrets } = require('./secrets');

// Returns a Stripe client built from the secret loaded out of Secrets Manager.
// This product uses its OWN Stripe account/keys. Do not reuse keys from other
// products or webhooks.
async function stripeClient() {
  const { STRIPE_SECRET_KEY } = await loadSecrets();
  if (!STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set');
  // Newer API versions currently return hosted Checkout links that Stripe rejects as incomplete.
  return new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
}

module.exports = { stripeClient };
