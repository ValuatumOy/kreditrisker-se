import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkoutSecretName, resolveReportEngine } from '../lib/checkout-stack'

const separate = {
    url: 'https://isolated123.lambda-url.eu-west-1.on.aws/',
    arn: 'arn:aws:lambda:eu-west-1:123456789012:function:sweden-report-isolated',
}
const sharedTest = {
    url: 'https://7zqqrejifzqphtwfb2imxtn67q0yzekq.lambda-url.eu-west-1.on.aws/',
    arn: 'arn:aws:lambda:eu-west-1:892885731254:function:pdf-report-api-test',
}
const sharedProd = {
    url: 'https://jdnrhdk37rmqzayy2km4jyrlgq0uapaw.lambda-url.eu-west-1.on.aws/',
    arn: 'arn:aws:lambda:eu-west-1:892885731254:function:pdf-report-api',
}

test('test checkout has no engine by default and cannot be enabled without an isolated one', () => {
    assert.equal(resolveReportEngine({ environmentName: 'Test' }), undefined)
    assert.equal(resolveReportEngine({ environmentName: 'Test', checkoutEnabled: false, testReportEngine: separate }), undefined)
    assert.throws(() => resolveReportEngine({ environmentName: 'Test', checkoutEnabled: true }), /separate report engine/)
})

test('test checkout rejects both shared engines, including mixed URL and ARN', () => {
    for (const target of [
        sharedTest, sharedProd,
        { url: sharedTest.url, arn: separate.arn },
        { url: separate.url, arn: sharedProd.arn },
    ]) {
        assert.throws(() => resolveReportEngine({ environmentName: 'Test', checkoutEnabled: true, testReportEngine: target }), /separate Lambda/)
    }
})

test('test checkout accepts only a plain HTTPS Lambda URL and function ARN', () => {
    assert.deepEqual(
        resolveReportEngine({ environmentName: 'Test', checkoutEnabled: true, testReportEngine: separate }),
        { ...separate, url: separate.url.slice(0, -1) },
    )
    for (const url of [
        'http://isolated123.lambda-url.eu-west-1.on.aws/',
        'https://isolated123.lambda-url.eu-west-1.on.aws/jobs',
        'https://isolated123.lambda-url.eu-west-1.on.aws/?id=1',
        'https://example.com/',
    ]) {
        assert.throws(() => resolveReportEngine({ environmentName: 'Test', checkoutEnabled: true, testReportEngine: { ...separate, url } }), /separate Lambda/)
    }
    assert.throws(() => resolveReportEngine({ environmentName: 'Test', checkoutEnabled: true, testReportEngine: { ...separate, arn: '' } }), /separate Lambda/)
})

test('production engine remains unchanged', () => {
    assert.deepEqual(resolveReportEngine({ environmentName: 'Prod' }), sharedProd)
})

test('enabled test checkout requires an isolated Stripe secret without changing production', () => {
    assert.equal(checkoutSecretName({ environmentName: 'Test' }), 'kreditrisker-se-test')
    assert.throws(() => checkoutSecretName({ environmentName: 'Test', checkoutEnabled: true }), /dedicated test secret/)
    for (const name of ['kreditrisker-se-prod', 'kreditrisker-se-test', 'kreditrisker-se-isolated-../prod']) {
        assert.throws(() => checkoutSecretName({ environmentName: 'Test', checkoutEnabled: true, testSecretName: name }), /dedicated/)
    }
    assert.equal(checkoutSecretName({ environmentName: 'Test', checkoutEnabled: true, testSecretName: 'kreditrisker-se-isolated-checkout' }), 'kreditrisker-se-isolated-checkout')
    assert.equal(checkoutSecretName({ environmentName: 'Prod' }), 'kreditrisker-se-prod')
    assert.throws(() => checkoutSecretName({ environmentName: 'Prod', testSecretName: 'kreditrisker-se-isolated-checkout' }), /production checkout/)
})
