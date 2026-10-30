import { test } from 'node:test'
import assert from 'node:assert/strict'
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
        const stack = new CheckoutStack(new cdk.App(), `Alerts${environmentName}`, {
            env: { account: '123456789012', region: 'eu-west-1' },
            environmentName,
            siteUrl: 'https://example.test',
        })
        const resources = Template.fromStack(stack).toJSON().Resources as Record<string, { Type: string; Properties: Record<string, any> }>
        const topicId = Object.entries(resources).find(([id, resource]) => id.startsWith('EmailFailureTopic') && resource.Type === 'AWS::SNS::Topic')?.[0]
        const logGroupId = Object.entries(resources).find(([id, resource]) => id.startsWith('ReportPollerFnLogs') && resource.Type === 'AWS::Logs::LogGroup')?.[0]
        const functionId = Object.entries(resources).find(([id, resource]) => id.startsWith('ReportPollerFn') && resource.Type === 'AWS::Lambda::Function')?.[0]
        assert.ok(topicId && logGroupId && functionId)
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
    })
}
