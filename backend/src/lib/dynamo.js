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
//     status,           // GENERATING | FULFILLED | FAILED  (GSI partition key)
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
  const res = await doc.send(new GetCommand({ TableName: config.ordersTable, Key: { sessionId } }));
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

module.exports = {
  doc,
  claimOrder,
  getOrder,
  deleteOrder,
  updateOrder,
  listOrdersByStatus,
};
