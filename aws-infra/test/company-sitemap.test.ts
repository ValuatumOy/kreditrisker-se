import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as cdk from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { SiteStack } from '../lib/site-stack'

test('Jenkins can wait for invalidation only on its site distribution', () => {
    const stack = new SiteStack(new cdk.App(), 'SitemapDeployTest', { environmentName: 'Prod', buildRoleName: 'sweden-process-role' })
    const template = Template.fromStack(stack)
    const policies = Object.values(template.findResources('AWS::IAM::Policy')) as any[]
    const statements = policies.flatMap((p) => p.Properties.PolicyDocument.Statement)
    const grant = statements.find((s) => s.Action === 'cloudfront:GetInvalidation')
    assert.ok(grant)
    const distributionId = Object.keys(template.findResources('AWS::CloudFront::Distribution'))[0]
    assert.deepEqual(grant.Resource, {
        'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':cloudfront::', { Ref: 'AWS::AccountId' }, ':distribution/', { Ref: distributionId }]],
    })
    assert.deepEqual(policies.find((p) => p.Properties.PolicyDocument.Statement.includes(grant)).Properties.Roles, ['sweden-process-role'])
})
