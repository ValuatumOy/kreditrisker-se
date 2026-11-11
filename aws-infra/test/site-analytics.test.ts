import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as cdk from 'aws-cdk-lib'
import * as ecr from 'aws-cdk-lib/aws-ecr'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { SiteStack } from '../lib/site-stack'

test('analytics frame is embeddable only by the website while normal pages stay protected', () => {
    const app = new cdk.App()
    const stack = new SiteStack(app, 'SiteAnalyticsTest', { environmentName: 'Prod', domain: 'kreditrisker.se' })
    const template = Template.fromStack(stack)
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
        ResponseHeadersPolicyConfig: {
            SecurityHeadersConfig: {
                ContentSecurityPolicy: { ContentSecurityPolicy: 'frame-ancestors https://www.kreditrisker.se', Override: true },
                ReferrerPolicy: { ReferrerPolicy: 'no-referrer', Override: true },
                FrameOptions: Match.absent(),
            },
            CustomHeadersConfig: { Items: [{ Header: 'X-Robots-Tag', Value: 'noindex, nofollow', Override: true }] },
        },
    })
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
        ResponseHeadersPolicyConfig: { SecurityHeadersConfig: { FrameOptions: { FrameOption: 'DENY', Override: true } } },
    })
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: { CacheBehaviors: Match.arrayWith([Match.objectLike({ PathPattern: '/analytics-frame/*' })]) },
    })
})

test('opening production removes only the normal site noindex header', () => {
    const app = new cdk.App()
    const repoStack = new cdk.Stack(app, 'Repo')
    const repo = ecr.Repository.fromRepositoryName(repoStack, 'SearchRepo', 'sweden-search')
    const stack = new SiteStack(app, 'SiteIndexingTest', { environmentName: 'Prod', domain: 'kreditrisker.se', indexing: true, searchRepository: repo, checkoutApiDomain: 'api.example.com' })
    const template = Template.fromStack(stack)
    const policies = template.findResources('AWS::CloudFront::ResponseHeadersPolicy') as Record<string, any>
    const entries = Object.entries(policies).map(([id, p]) => ({ id, config: p.Properties.ResponseHeadersPolicyConfig }))
    assert.equal(entries.length, 3)
    const normal = entries.find(({ config }) => !config.CustomHeadersConfig)!
    const api = entries.find(({ config }) => config.CustomHeadersConfig && config.SecurityHeadersConfig?.FrameOptions?.FrameOption === 'DENY')!
    const frame = entries.find(({ config }) => config.SecurityHeadersConfig?.ContentSecurityPolicy)!
    for (const { config } of [api, frame]) assert.deepEqual(config.CustomHeadersConfig.Items, [{ Header: 'X-Robots-Tag', Value: 'noindex, nofollow', Override: true }])
    const distribution = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0] as any
    const behavior = distribution.Properties.DistributionConfig
    assert.deepEqual(behavior.DefaultCacheBehavior.ResponseHeadersPolicyId, { Ref: normal.id })
    for (const route of ['/api/search', '/api/*']) assert.deepEqual(behavior.CacheBehaviors.find((b: any) => b.PathPattern === route).ResponseHeadersPolicyId, { Ref: api.id })
    assert.deepEqual(behavior.CacheBehaviors.find((b: any) => b.PathPattern === '/analytics-frame/*').ResponseHeadersPolicyId, { Ref: frame.id })
})
