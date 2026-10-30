'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
} = require('@aws-sdk/lib-dynamodb');
const config = require('./config');

// Orders table — the single source of truth for the async fulfillment gap
// between the webhook (submits a generation job) and the poller (captures the
// payment + emails the PDF once the job is DONE).
//
// Item shape:
//   {
//     sessionId,        // PK — Stripe Checkout Session id (idempotency key)
//     status,           // CONFIRMING | GENERATING | FULFILLED | FAILED | WITHDRAWN
//     paymentIntentId,  // Stripe PaymentIntent (manual capture)
//     jobId,            // report-engine job id (absent until the job is submitted)
//     email,            // Stripe-collected customer email
//     reportType,       // product key, e.g. ai_credit_risk
//     lang,             // buyer's language: Stripe copy + delivery email
//     reportLang,       // language of the generated PDF (also on params.lang)
//     params,           // map passed to the report engine
//     companyName,
//     createdAt, updatedAt,
//   }

const clientConfig = { region: config.region };
if (config.awsEndpoint) clientConfig.endpoint = config.awsEndpoint;

const doc = DynamoDBDocumentClient.from(new DynamoDBClient(clientConfig), {
  marshallOptions: { removeUndefinedValues: true },
});

// Claim an order row for a Checkout Session. Conditional on the session not
// already existing, so a redelivered webhook can't submit a second job. Returns
// true if the claim was created, false if the session was already processed.
async function claimOrder(item) {
  try {
    await doc.send(new PutCommand({
      TableName: config.ordersTable,
      Item: item,
      ConditionExpression: 'attribute_not_exists(sessionId)',
    }));
    return true;
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

async function getOrder(sessionId) {
  const res = await doc.send(new GetCommand({
    TableName: config.ordersTable, Key: { sessionId }, ConsistentRead: true,
  }));
  return res.Item || null;
}

async function deleteOrder(sessionId) {
  await doc.send(new DeleteCommand({ TableName: config.ordersTable, Key: { sessionId } }));
}

// Patch arbitrary attributes on an order (jobId, status, error, …).
async function updateOrder(sessionId, attrs) {
  const keys = Object.keys(attrs);
  if (!keys.length) return;
  const names = {};
  const values = {};
  const sets = keys.map((k, i) => {
    names[`#k${i}`] = k;
    values[`:v${i}`] = attrs[k];
    return `#k${i} = :v${i}`;
  });
  names['#u'] = 'updatedAt';
  values[':u'] = new Date().toISOString();
  await doc.send(new UpdateCommand({
    TableName: config.ordersTable,
    Key: { sessionId },
    UpdateExpression: `SET ${sets.join(', ')}, #u = :u`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

// All orders currently in a given status (e.g. GENERATING), via the status GSI.
async function listOrdersByStatus(status) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await doc.send(new QueryCommand({
      TableName: config.ordersTable,
      IndexName: config.ordersStatusIndex,
      KeyConditionExpression: '#s = :s',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': status },
      ExclusiveStartKey,
    }));
    items.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function beginGeneration(sessionId) {
  return conditionalOrderUpdate(sessionId, { status: 'GENERATING' },
    '#status = :confirming AND attribute_not_exists(withdrawalRequestId)',
    { '#status': 'status' }, { ':confirming': 'CONFIRMING' });
}

async function claimDelivery(sessionId) {
  return conditionalOrderUpdate(sessionId, { deliveryClaimedAt: new Date().toISOString() },
    '#status = :generating AND attribute_not_exists(withdrawalRequestId)',
    { '#status': 'status' }, { ':generating': 'GENERATING' });
}

async function finishSingleOrder(sessionId, attrs) {
  return conditionalOrderUpdate(sessionId, attrs,
    'attribute_exists(sessionId) AND attribute_not_exists(withdrawalRequestId)');
}

async function conditionalOrderUpdate(sessionId, attrs, condition, names = {}, values = {}) {
  const sets = Object.entries({ ...attrs, updatedAt: new Date().toISOString() }).map(([key, value], index) => {
    names[`#a${index}`] = key;
    values[`:a${index}`] = value;
    return `#a${index} = :a${index}`;
  });
  try {
    await doc.send(new UpdateCommand({
      TableName: config.ordersTable, Key: { sessionId },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: condition,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }));
    return true;
  } catch (error) {
    if (error?.name === 'ConditionalCheckFailedException') return false;
    throw error;
  }
}

async function requestWithdrawal({ sessionId, email, requestId, requestedAt, receiptMethod }) {
  const order = await getOrder(sessionId);
  if (!order || order.reportType !== 'se_credit_risk' || order.funding === 'package'
      || String(order.email || '').trim().toLowerCase() !== email) return null;
  if (order.withdrawalRequestId) return order;
  const attrs = {
    withdrawalRequestId: requestId,
    withdrawalRequestedAt: requestedAt,
    withdrawalState: 'PENDING',
    withdrawalReceiptMethod: receiptMethod,
  };
  const created = await conditionalOrderUpdate(sessionId, attrs,
    '#email = :email AND #type = :type AND attribute_not_exists(withdrawalRequestId)',
    { '#email': 'email', '#type': 'reportType' },
    { ':email': order.email, ':type': 'se_credit_risk' });
  if (created) return { ...order, ...attrs };
  const current = await getOrder(sessionId);
  return current?.withdrawalRequestId && current.reportType === 'se_credit_risk' && current.funding !== 'package'
    && String(current.email || '').trim().toLowerCase() === email ? current : null;
}

async function listWithdrawals(state = 'PENDING') {
  const items = [];
  let ExclusiveStartKey;
  do {
    const response = await doc.send(new QueryCommand({
      TableName: config.ordersTable, IndexName: 'WithdrawalIndex',
      KeyConditionExpression: '#state = :state',
      ExpressionAttributeNames: { '#state': 'withdrawalState' },
      ExpressionAttributeValues: { ':state': state }, ExclusiveStartKey,
    }));
    items.push(...(response.Items || []));
    ExclusiveStartKey = response.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

module.exports = {
  doc,
  claimOrder,
  getOrder,
  deleteOrder,
  updateOrder,
  listOrdersByStatus,
  beginGeneration,
  claimDelivery,
  finishSingleOrder,
  requestWithdrawal,
  listWithdrawals,
};
