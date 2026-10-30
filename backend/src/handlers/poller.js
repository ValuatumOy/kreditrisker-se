'use strict';

// Poller — triggered by an EventBridge schedule (~every 1 min). For each order
// CONFIRMING Basic orders first receive an order reference. Withdrawal requests
// are handled independently of fulfillment status, with charged payments queued
// for manual refund review. For each remaining GENERATING order, checks the
// report-engine job and resolves the manual-capture
// PaymentIntent:
//   DONE         → download PDF, CAPTURE the PaymentIntent, email the PDF, mark FULFILLED
//   FAILED       → CANCEL the PaymentIntent (release the hold, no charge),
//                  alert admin, mark FAILED
//   PENDING/RUN  → leave it; fail + cancel past MAX_GENERATION minutes so a stuck
//                  job can't drift toward Stripe's 7-day capture window
//
// FULFILLED is set after email succeeds so failures can be retried. If SES
// accepts an email but the order update fails, a retry can send it again.

const { stripeClient } = require('../lib/stripe');
const dynamo = require('../lib/dynamo');
const { listOrdersByStatus } = dynamo;
const credits = require('../lib/credits');
const { getJob, downloadPdf } = require('../lib/reportEngine');
const { generateValuatumReport } = require('../lib/valuatumReports');
const { getProduct, localizedField, DEFAULT_REPORT_LANG } = require('../lib/products');
const emailService = require('../lib/email');
const config = require('../lib/config');
const fulfillment = require('../lib/fulfillment');
const withdrawals = require('../lib/withdrawals');
const { paymentFunding } = require('../lib/paymentFunding');
const { isFixtureOrder } = require('../lib/fixtureTest');

function ageMinutes(order) {
  const created = Date.parse(order.createdAt || '');
  if (!Number.isFinite(created)) return Infinity;
  return (Date.now() - created) / 60000;
}

// A retry is successful only if Stripe confirms the payment was captured.
async function capturePaymentIntent(stripe, paymentIntentId) {
  if (!paymentIntentId) {
    throw new Error('Payment review required: capture has no PaymentIntent');
  }
  try {
    const intent = await stripe.paymentIntents.capture(paymentIntentId);
    if (intent?.status !== 'succeeded') throw new Error('Payment capture was not confirmed');
  } catch (err) {
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (paymentIntent.status === 'succeeded') {
      console.log('capturePaymentIntent: already captured', {
        paymentIntentId,
      });
      return;
    }
    if (paymentIntent.status === 'canceled') {
      const canceled = new Error('Payment authorization was canceled before report delivery');
      canceled.code = 'payment_authorization_canceled';
      throw canceled;
    }
    throw err;
  }
}

async function cancelPaymentIntent(stripe, paymentIntentId) {
  if (!paymentIntentId) {
    throw new Error('Payment review required: cancellation has no PaymentIntent');
  }
  try {
    const intent = await stripe.paymentIntents.cancel(paymentIntentId);
    if (intent?.status !== 'canceled') throw new Error('Payment cancellation was not confirmed');
  } catch (err) {
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (paymentIntent.status === 'canceled') {
      console.log('cancelPaymentIntent: already canceled', { paymentIntentId });
      return;
    }
    throw err;
  }
}

function packageSettlementInput(order, orderAttrs, occurredAt) {
  const email = order.creditKey?.email;
  const reportType = order.creditKey?.reportType;
  if (!email || !reportType) {
    throw new Error('Package-funded order is missing its creditKey');
  }
  return {
    email,
    reportType,
    sessionId: order.sessionId,
    companyName: order.companyName,
    occurredAt,
    orderAttrs,
  };
}

async function settleFunding(order, attrs = {}, occurredAt = new Date().toISOString()) {
  const orderAttrs = { ...attrs, status: 'FULFILLED' };
  if (order.funding === 'package') {
    return credits.consume(packageSettlementInput(order, orderAttrs, occurredAt));
  }
  if (order.reportType === 'se_credit_risk') {
    const completed = await dynamo.finishSingleOrder(order.sessionId, orderAttrs);
    return completed ? { status: 'SETTLED' } : { status: 'WITHDRAWN' };
  }
  return dynamo.updateOrder(order.sessionId, orderAttrs);
}

async function releaseFunding(order, reason, occurredAt = new Date().toISOString()) {
  const orderAttrs = { status: 'FAILED', error: reason };
  if (order.funding === 'package') {
    return credits.release(packageSettlementInput(order, orderAttrs, occurredAt));
  }
  if (order.reportType === 'se_credit_risk') {
    const completed = await dynamo.finishSingleOrder(order.sessionId, orderAttrs);
    return completed ? { status: 'SETTLED' } : { status: 'WITHDRAWN' };
  }
  return dynamo.updateOrder(order.sessionId, orderAttrs);
}

async function unspentAfterDelivery(order) {
  if (order.funding !== 'package') return undefined;
  try {
    const balance = await credits.getBalance(order.creditKey.email, order.creditKey.reportType);
    return Math.max(0, credits.unspentReports(balance) - 1);
  } catch (err) {
    console.error('poller: balance read failed; omitting remaining report count', {
      sessionId: order.sessionId,
      error: err.message,
    });
    return undefined;
  }
}

// Build the PDF filename from the company name: NFKD splits accented letters
// into base + combining mark (æ/ø/å and other diacritics), which we then strip,
// so Danish/diacritic characters fold to their plain ASCII form. Any remaining
// non-alphanumerics collapse to single hyphens.
//   "JYSK A/S" → "jysk-a-s.pdf"
function reportFileName(companyName) {
  const slug = (companyName || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'credit-risk-report'}.pdf`;
}

async function deliver(stripe, order, pdfBuffer) {
  const funding = paymentFunding(order);
  if (order.reportType === 'se_credit_risk' && order.funding !== 'package'
      && !(await dynamo.claimDelivery(order.sessionId))) return false;
  if (funding === 'STRIPE') {
    try {
      await capturePaymentIntent(stripe, order.paymentIntentId);
    } catch (err) {
      if (err.code !== 'payment_authorization_canceled') throw err;
      await fail(stripe, order, err.message);
      return false;
    }
  }
  const product = getProduct(order.reportType);
  await emailService.sendReportEmail(order.email, {
    companyName: order.companyName,
    pdfBuffer,
    fileName: reportFileName(order.companyName),
    productName: localizedField(product?.name, order.lang),
    lang: order.lang,
    reportLang: order.reportLang || order.params?.lang,
    remainingReports: await unspentAfterDelivery(order),
    // Tags the send so an SES bounce/complaint event names the order.
    sessionId: order.sessionId,
  });
  const settlement = await settleFunding(order);
  return settlement?.status !== 'WITHDRAWN';
}

async function fulfill(stripe, order, job) {
  // Re-mint the URL implicitly by using the just-fetched job's s3Url.
  const pdfBuffer = await downloadPdf(job.s3Url);
  if (!(await deliver(stripe, order, pdfBuffer))) return;
  console.log('poller: fulfilled', {
    sessionId: order.sessionId,
    jobId: order.jobId,
  });
}

async function fail(stripe, order, reason) {
  if (paymentFunding(order) === 'STRIPE') await cancelPaymentIntent(stripe, order.paymentIntentId);
  const settlement = await releaseFunding(order, reason);
  if (settlement?.status === 'WITHDRAWN') return;
  // Best-effort: a failed admin alert (e.g. SES identity not verified) must
  // not keep the order GENERATING and re-loop the poller every tick. The hold
  // is already released above, so marking the order terminal is the priority.
  try {
    await emailService.sendAdminGenerationAlert(
      order,
      reason,
      localizedField(getProduct(order.reportType)?.name, 'en'),
      settlement?.status
    );
  } catch (err) {
    console.error('poller: admin alert failed (marking order FAILED anyway)', {
      sessionId: order.sessionId,
      error: err.message,
    });
  }
  console.warn('poller: failed', { sessionId: order.sessionId, reason });
}

// Synchronous-REST products: the webhook claimed the order without a job,
// so we generate the PDF here in one call via
// the authenticated Valuatum REST endpoint. A thrown error leaves the order
// GENERATING for the next tick; the age guard below releases the hold if it
// never succeeds within the budget.
async function processRestOrder(stripe, order, product) {
  if (ageMinutes(order) > config.maxGenerationMinutes) {
    await fail(
      stripe,
      order,
      `Report generation timed out after ${config.maxGenerationMinutes} min.`
    );
    return;
  }
  const pdfBuffer = await generateValuatumReport({
    reportName: order.params?.reportName || product.reportName,
    fid: order.params?.fid,
    // Report content language — the buyer's choice, written by
    // buildReportParams(). Never falls back to order.lang: that is the
    // Stripe/email language and is independent of the PDF's language.
    lang: order.params?.lang || DEFAULT_REPORT_LANG,
    currency: order.params?.currency || product.reportCurrency,
  });
  if (!(await deliver(stripe, order, pdfBuffer))) return;
  console.log('poller: fulfilled (rest)', {
    sessionId: order.sessionId,
    reportType: order.reportType,
  });
}

async function processOrder(stripe, order) {
  paymentFunding(order);
  const product = getProduct(order.reportType);
  if (product?.generator === 'valuatumRest') {
    await processRestOrder(stripe, order, product);
    return;
  }

  // Claimed by the webhook but no jobId recorded yet.
  if (!order.jobId) {
    if (ageMinutes(order) < config.claimGraceMinutes) return; // submit may be in flight
    await fail(stripe, order, 'Job submission could not be confirmed (no jobId recorded).');
    return;
  }

  const job = await getJob(order.jobId);

  if (job.status === 'DONE') {
    if (!job.s3Url) throw new Error('job DONE but no s3Url');
    await fulfill(stripe, order, job);
  } else if (job.status === 'FAILED') {
    await fail(stripe, order, `Generation failed: ${job.error || 'unknown error'}`);
  } else if (ageMinutes(order) > config.maxGenerationMinutes) {
    await fail(
      stripe,
      order,
      `Generation timed out after ${config.maxGenerationMinutes} min (status ${job.status}).`
    );
  }
  // else PENDING/RUNNING within budget → leave for the next tick.
}

async function confirmBasicOrder(stripe, order) {
  if (order.withdrawalRequestId) return;
  paymentFunding(order);
  if (ageMinutes(order) > config.maxGenerationMinutes) {
    await fail(stripe, order, 'Order confirmation could not be sent before the generation deadline.');
    return;
  }
  if (!order.confirmationAcceptedAt) {
    await emailService.sendOrderReceivedEmail(order, localizedField(getProduct(order.reportType)?.name, order.lang));
    await dynamo.updateOrder(order.sessionId, { confirmationAcceptedAt: new Date().toISOString() });
  }
  if (!(await dynamo.beginGeneration(order.sessionId))) return;
  try {
    await fulfillment.startFulfillment(order, getProduct(order.reportType));
  } catch (error) {
    // Once claimed, never resubmit: an interrupted response may hide a paid job.
    console.error('poller: order error', { sessionId: order.sessionId, error: error.message });
  }
}

exports.handler = async () => {
  const stripe = await stripeClient();
  const pendingWithdrawals = await dynamo.listWithdrawals();
  for (const indexed of pendingWithdrawals) {
    try {
      const order = await dynamo.getOrder(indexed.sessionId);
      if (order && (!config.isolatedFixtureTest || isFixtureOrder(order))) await withdrawals.processWithdrawal(stripe, order);
    } catch (error) {
      console.error('withdrawal: processing error', { sessionId: indexed.sessionId, step: 'background processing', error: error.message });
    }
  }
  for (const indexed of await dynamo.listWithdrawals('REVIEW_REQUIRED')) {
    const order = await dynamo.getOrder(indexed.sessionId);
    if (order?.withdrawalState === 'REVIEW_REQUIRED') {
      console.warn('withdrawal: manual refund required', { sessionId: order.sessionId });
    }
  }
  const confirming = await listOrdersByStatus('CONFIRMING');
  for (const indexed of confirming) {
    try {
      const order = await dynamo.getOrder(indexed.sessionId);
      if (order?.status === 'CONFIRMING' && (!config.isolatedFixtureTest || isFixtureOrder(order))) await confirmBasicOrder(stripe, order);
    } catch (error) {
      console.error('poller: order error', { sessionId: indexed.sessionId, error: error.message });
    }
  }
  const orders = await listOrdersByStatus('GENERATING');
  console.log('poller: tick', { count: orders.length });

  for (const indexedOrder of orders) {
    try {
      // The status index is eventually consistent; it may still show a
      // jobless or already fulfilled version of an order.
      const order = await dynamo.getOrder(indexedOrder.sessionId);
      if (!order || order.status !== 'GENERATING' || order.withdrawalRequestId || (config.isolatedFixtureTest && !isFixtureOrder(order))) continue;
      await processOrder(stripe, order);
    } catch (err) {
      console.error('poller: order error', {
        sessionId: indexedOrder.sessionId,
        error: err.message,
      });
    }
  }

  return { ok: true, processed: orders.length };
};

exports.settleFunding = settleFunding;
exports.releaseFunding = releaseFunding;
exports.deliver = deliver;
exports.fail = fail;
