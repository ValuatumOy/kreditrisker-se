import { test } from 'node:test'
import * as cdk from 'aws-cdk-lib'
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
        },
    })
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
        ResponseHeadersPolicyConfig: { SecurityHeadersConfig: { FrameOptions: { FrameOption: 'DENY', Override: true } } },
    })
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: { CacheBehaviors: Match.arrayWith([Match.objectLike({ PathPattern: '/analytics-frame/*' })]) },
    })
})
