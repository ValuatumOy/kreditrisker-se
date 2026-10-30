import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as cdk from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { CheckoutStack } from '../lib/checkout-stack'

// CDK uses the backend's installed esbuild locally; no Docker or network.
const esbuildDir = process.platform === 'win32'
    ? `../../backend/node_modules/@esbuild/win32-${process.arch}`
    : '../../backend/node_modules/.bin'
process.env.PATH = `${path.resolve(__dirname, esbuildDir)}${path.delimiter}${process.env.PATH}`

for (const environmentName of ['Test', 'Prod'] as const) {
    test(`${environmentName} checkout alerts on caught order errors and poller runtime errors`, () => {
        const app = new cdk.App()
        const stack = new CheckoutStack(app, `Alerts${environmentName}`, {
            env: { account: '123456789012', region: 'eu-west-1' },
            environmentName,
            siteUrl: 'https://example.test',
        })
        const resources = Template.fromStack(stack).toJSON().Resources as Record<string, { Type: string; Properties: Record<string, any> }>
        const orderTable = Object.entries(resources).find(([id, resource]) => id.startsWith('OrdersTable') && resource.Type === 'AWS::DynamoDB::Table')?.[1]
        assert.ok(orderTable?.Properties.GlobalSecondaryIndexes.some((index: any) => index.IndexName === 'WithdrawalIndex'
            && index.KeySchema.some((key: any) => key.AttributeName === 'withdrawalState' && key.KeyType === 'HASH')))
        assert.ok(Object.values(resources).some(resource => resource.Type === 'AWS::ApiGatewayV2::Route' && resource.Properties.RouteKey === 'POST /api/withdrawal'))
        const stage = Object.values(resources).find(resource => resource.Type === 'AWS::ApiGatewayV2::Stage')
        assert.deepEqual(stage?.Properties.RouteSettings['POST /api/withdrawal'], { ThrottlingBurstLimit: 4, ThrottlingRateLimit: 2 })
        assert.ok(Object.entries(resources).some(([id, resource]) => id.startsWith('WithdrawalManualRefundAlarm') && resource.Type === 'AWS::CloudWatch::Alarm'))
        const topicId = Object.entries(resources).find(([id, resource]) => id.startsWith('EmailFailureTopic') && resource.Type === 'AWS::SNS::Topic')?.[0]
        const logGroupId = Object.entries(resources).find(([id, resource]) => id.startsWith('ReportPollerFnLogs') && resource.Type === 'AWS::Logs::LogGroup')?.[0]
        const functionId = Object.entries(resources).find(([id, resource]) => id.startsWith('ReportPollerFn') && resource.Type === 'AWS::Lambda::Function')?.[0]
        assert.ok(topicId && logGroupId && functionId)
        const webhookLogId = Object.entries(resources).find(([id, resource]) => id.startsWith('WebhookFnLogs') && resource.Type === 'AWS::Logs::LogGroup')?.[0]
        const paymentFilter = Object.entries(resources).find(([id, resource]) => id.startsWith('WebhookPaymentReviewErrors') && resource.Type === 'AWS::Logs::MetricFilter')?.[1]
        assert.ok(webhookLogId && paymentFilter)
        assert.equal(paymentFilter.Properties.FilterPattern, '"webhook: payment review required"')
        assert.deepEqual(paymentFilter.Properties.LogGroupName, { Ref: webhookLogId })
        const paymentAlarm = Object.entries(resources).find(([id, resource]) => id.startsWith('WebhookPaymentReviewAlarm') && resource.Type === 'AWS::CloudWatch::Alarm')?.[1]
        assert.ok(paymentAlarm)
        assert.equal(paymentAlarm.Properties.Threshold, 1)
        assert.equal(paymentAlarm.Properties.MetricName, 'WebhookPaymentReviewRequired')
        assert.deepEqual(paymentAlarm.Properties.AlarmActions, [{ Ref: topicId }])
        const filter = Object.entries(resources).find(([id, resource]) => id.startsWith('ReportPollerOrderErrors') && resource.Type === 'AWS::Logs::MetricFilter')?.[1]
        assert.ok(filter)
        assert.equal(filter.Properties.FilterPattern, '"poller: order error"')
        assert.deepEqual(filter.Properties.LogGroupName, { Ref: logGroupId })
        assert.deepEqual(filter.Properties.MetricTransformations, [{
            DefaultValue: 0,
            MetricName: 'ReportOrderErrors',
            MetricNamespace: `KreditriskerSE/${environmentName}`,
            MetricValue: '1',
        }])

        for (const logicalPrefix of ['ReportPollerOrderErrorAlarm', 'ReportPollerRuntimeErrorAlarm']) {
            const alarm = Object.entries(resources).find(([id, resource]) => id.startsWith(logicalPrefix) && resource.Type === 'AWS::CloudWatch::Alarm')?.[1]
            assert.ok(alarm)
            assert.equal(alarm.Properties.Threshold, 1)
            assert.equal(alarm.Properties.EvaluationPeriods, 1)
            assert.equal(alarm.Properties.TreatMissingData, 'notBreaching')
            assert.deepEqual(alarm.Properties.AlarmActions, [{ Ref: topicId }])
            if (logicalPrefix === 'ReportPollerOrderErrorAlarm') {
                assert.equal(alarm.Properties.MetricName, 'ReportOrderErrors')
                assert.equal(alarm.Properties.Namespace, `KreditriskerSE/${environmentName}`)
            } else {
                assert.equal(alarm.Properties.MetricName, 'Errors')
                assert.equal(alarm.Properties.Namespace, 'AWS/Lambda')
                assert.deepEqual(alarm.Properties.Dimensions, [{ Name: 'FunctionName', Value: { Ref: functionId } }])
            }
        }

        if (environmentName === 'Prod') {
            // Check the synthesized Lambda, not just the local email module:
            // the runtime's older SDK must not silently drop PDF attachments.
            app.synth()
            const assets = JSON.parse(fs.readFileSync(path.join(app.outdir, 'AlertsProd.assets.json'), 'utf8'))
            const pollerAsset = Object.values(assets.files).find((asset: any) => asset.displayName === 'ReportPollerFn/Code') as any
            assert.ok(pollerAsset)
            const bundlePath = path.join(app.outdir, pollerAsset.source.path, 'index.js')
            const bundle = fs.readFileSync(bundlePath, 'utf8')
            const sourceMap = JSON.parse(fs.readFileSync(`${bundlePath}.map`, 'utf8'))
            assert.ok(sourceMap.sources.some((source: string) => source.includes('@aws-sdk/client-sesv2/')))
            assert.doesNotMatch(bundle, /require\(["']@aws-sdk\/client-sesv2["']\)/)
        }
    })
}
