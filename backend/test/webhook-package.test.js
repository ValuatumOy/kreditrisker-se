'use strict';

const { test, mock, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.CREDITS_TABLE = 'test-credits';
process.env.ORDERS_TABLE = 'test-orders';
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_dummy';

const Stripe = require('stripe');
const credits = require('../src/lib/credits');
const dynamo = require('../src/lib/dynamo');
const fulfillment = require('../src/lib/fulfillment');
const emailService = require('../src/lib/email');
const { handler } = require('../src/handlers/webhook');

const { reportName } = require('../src/lib/products').getProduct('se_credit_risk');

const signer = new Stripe(process.env.STRIPE_SECRET_KEY);

const REQUEST_ID = '11111111-2222-4333-8444-555555555555';
const ORDER_ID = `pkg_${REQUEST_ID}`;
const CS_ID = 'cs_test_bundle_1';

const BUNDLE_META = {
  reportType: 'se_credit_risk_bundle',
  fulfillReportType: 'se_credit_risk',
  requestId: REQUEST_ID,
  fid: '12345',
  companyName: 'JYSK A/S',
};

function completedSession(overrides = {}, metaOverrides = {}) {
  return {
    id: CS_ID,
    payment_status: 'paid',
    payment_intent: 'pi_test_1',
    amount_total: 1500,
    currency: 'sek',
    customer_details: { email: '  Buyer@Example.COM ', name: 'Testi Ostaja' },
    metadata: { ...BUNDLE_META, ...metaOverrides },
    ...overrides,
  };
}

// Sign the payload with Stripe's local test helper.
function webhookEvent(session) {
  const payload = JSON.stringify({
    type: 'checkout.session.completed',
    data: { object: session },
  });
  return {
    requestContext: { http: { method: 'POST' } },
    headers: {
      'stripe-signature': signer.webhooks.generateTestHeaderString({
        payload,
        secret: process.env.STRIPE_WEBHOOK_SECRET,
      }),
    },
    body: payload,
  };
}

function mockCredits(status = 'RESERVED') {
  return {
    purchaseAndReserve: mock.method(credits, 'purchaseAndReserve', async () => ({ status })),
    release: mock.method(credits, 'release', async () => ({ status: 'SETTLED' })),
    getBalance: mock.method(credits, 'getBalance', async () => ({ remaining: 2, reserved: 1 })),
  };
}

beforeEach(() => {
  mock.restoreAll();
  mock.method(fulfillment, 'startFulfillment', async () => ({ jobId: null }));
  mock.method(emailService, 'sendCreditGrantEmail', async () => undefined);
  mock.method(emailService, 'sendCreditReleaseEmail', async () => undefined);
});

test('a bundle purchase grants, reserves, and claims the request-keyed order', async () => {
  const { purchaseAndReserve } = mockCredits();

  const res = await handler(webhookEvent(completedSession()));
  assert.equal(res.statusCode, 200);

  const [input] = purchaseAndReserve.mock.calls[0].arguments;
  assert.equal(input.email, 'buyer@example.com');
  assert.equal(input.reportType, 'se_credit_risk');
  assert.equal(input.count, 3);
  assert.equal(input.checkoutSessionId, CS_ID);
  assert.equal(input.order.sessionId, ORDER_ID);

  const { order } = input;
  assert.equal(order.requestId, REQUEST_ID);
  assert.equal(order.email, 'buyer@example.com');
  // The poller uses reportType; purchaseSku records what was sold.
  assert.equal(order.purchaseSku, 'se_credit_risk_bundle');
  assert.equal(order.reportType, 'se_credit_risk');
  assert.equal(order.checkoutSessionId, CS_ID);
  // paymentIntentId is reserved for payments the poller must settle.
  assert.equal(order.paymentIntentId, undefined);
  assert.equal(order.purchasePaymentIntentId, 'pi_test_1');
  assert.equal(emailService.sendCreditGrantEmail.mock.callCount(), 0);
  // Build params from the granted product, not the generator-less bundle.
  assert.deepEqual(order.params, {
    fid: '12345',
    lang: 'sv',
    reportName,
    currency: 'SEK',
  });

  assert.deepEqual(
    fulfillment.startFulfillment.mock.calls.map((c) => c.arguments[0]),
    [order],
  );
});

test('an unpaid bundle grants nothing; an approved zero-total one still does', async () => {
  const { purchaseAndReserve } = mockCredits();

  await handler(webhookEvent(completedSession({ payment_status: 'unpaid' })));
  assert.equal(purchaseAndReserve.mock.callCount(), 0);

  await handler(
    webhookEvent(completedSession({ payment_status: 'no_payment_required', amount_total: 0 })),
  );
  assert.equal(purchaseAndReserve.mock.callCount(), 1);
});

test('the payment_status gate does not touch manual-capture single reports', async () => {
  // Single-report payments remain unpaid until the poller captures them.
  const claimOrder = mock.method(dynamo, 'claimOrder', async () => true);

  const res = await handler(
    webhookEvent(
      completedSession(
        { payment_status: 'unpaid' },
        { reportType: 'se_credit_risk', fulfillReportType: undefined, requestId: undefined },
      ),
    ),
  );

  assert.equal(res.statusCode, 200);
  assert.equal(claimOrder.mock.callCount(), 1);
  assert.equal(claimOrder.mock.calls[0].arguments[0].sessionId, CS_ID);
  assert.equal(fulfillment.startFulfillment.mock.callCount(), 1);
});

test('a report the package does not grant is refused', async () => {
  const { purchaseAndReserve } = mockCredits();

  for (const fulfillReportType of [undefined, 'se_ai_credit_risk', 'se_credit_risk_bundle']) {
    const res = await handler(webhookEvent(completedSession({}, { fulfillReportType })));
    assert.equal(res.statusCode, 200);
  }

  assert.equal(purchaseAndReserve.mock.callCount(), 0);
  assert.equal(fulfillment.startFulfillment.mock.callCount(), 0);
});

test('an unusable request id or email stops before the ledger', async () => {
  const { purchaseAndReserve } = mockCredits();

  await handler(webhookEvent(completedSession({}, { requestId: 'not-a-uuid' })));
  await handler(
    webhookEvent(completedSession({ customer_details: { email: '' }, customer_email: null })),
  );

  assert.equal(purchaseAndReserve.mock.callCount(), 0);
});

test('generation starts only when the webhook claimed the order itself', async () => {
  // Neither status means this invocation claimed the order.
  for (const status of ['DUPLICATE', 'GRANTED_EXISTING_ORDER']) {
    mock.restoreAll();
    mock.method(fulfillment, 'startFulfillment', async () => ({ jobId: null }));
    mock.method(emailService, 'sendCreditGrantEmail', async () => undefined);
    mock.method(emailService, 'sendCreditReleaseEmail', async () => undefined);
    mockCredits(status);

    const res = await handler(webhookEvent(completedSession()));

    assert.equal(res.statusCode, 200);
    assert.equal(fulfillment.startFulfillment.mock.callCount(), 0, status);
    assert.equal(emailService.sendCreditGrantEmail.mock.callCount(), 0, status);
  }
});

test('a generation that never started returns the report, one that did keeps it', async () => {
  const { release } = mockCredits();
  mock.method(fulfillment, 'startFulfillment', async () => {
    throw new Error('report engine unreachable');
  });

  // Return 200 because redelivery cannot restart generation.
  const res = await handler(webhookEvent(completedSession()));
  assert.equal(res.statusCode, 200);
  const [released] = release.mock.calls[0].arguments;
  assert.equal(released.sessionId, ORDER_ID);
  assert.equal(released.email, 'buyer@example.com');
  assert.equal(released.reportType, 'se_credit_risk');
  assert.equal(released.orderAttrs.status, 'FAILED');
  assert.equal(emailService.sendCreditReleaseEmail.mock.callCount(), 0);

  mock.method(fulfillment, 'startFulfillment', async () => {
    throw new fulfillment.FulfillmentTrackingError('job_1', new Error('DynamoDB down'));
  });

  await handler(webhookEvent(completedSession()));
  assert.equal(release.mock.callCount(), 1, 'the generator already accepted that job');
});


