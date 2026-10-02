import * as cdk from 'aws-cdk-lib'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as targets from 'aws-cdk-lib/aws-route53-targets'
import * as s3 from 'aws-cdk-lib/aws-s3'
import { Construct } from 'constructs'
import { searchRewriteCode, siteRequestCode } from './functions'

export interface SiteStackProps extends cdk.StackProps {
    environmentName: 'Test' | 'Prod'
    /** Apex domain, e.g. kreditrisker.se. Omit to serve on the CloudFront domain only. */
    domain?: string
    /** Route 53 hosted zone of `domain` (created automatically when the domain is bought in Route 53). */
    hostedZoneId?: string
    /** us-east-1 certificate for domain + www (CertStack). */
    certificate?: acm.ICertificate
    /** CloudSearch search endpoint host, e.g. search-sweden-companies-prod-xxxx.eu-west-1.cloudsearch.amazonaws.com */
    searchEndpoint?: string
    /** Report checkout HTTP API host (CheckoutStack output), for /api/* except search. */
    checkoutApiDomain?: string
}

/**
 * Static hosting for the Swedish directory: a private S3 bucket behind
 * CloudFront (Jenkins copies `dist/` into it), plus a private bucket for the
 * build state (the directory index carried between nightly runs).
 *
 *   /*                 S3, with /path/ -> /path/index.html and apex -> www
 *   /api/search        CloudSearch (query built in a CloudFront Function, no Lambda)
 *   /api/*             report checkout API (same origin, so no CORS)
 */
export class SiteStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: SiteStackProps) {
        super(scope, id, props)
        const prod = props.environmentName === 'Prod'
        const removalPolicy = prod ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY

        const siteBucket = new s3.Bucket(this, 'SiteBucket', {
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            removalPolicy,
            autoDeleteObjects: !prod,
        })

        const stateBucket = new s3.Bucket(this, 'StateBucket', {
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            versioned: true,
            lifecycleRules: [{ noncurrentVersionExpiration: cdk.Duration.days(30) }],
            removalPolicy,
            autoDeleteObjects: !prod,
        })

        const siteFunction = new cloudfront.Function(this, 'SiteRequest', {
            runtime: cloudfront.FunctionRuntime.JS_2_0,
            code: cloudfront.FunctionCode.fromInline(siteRequestCode(props.domain)),
            comment: 'apex -> www, /path/ -> /path/index.html, /path -> /path/',
        })

        const headers = new cloudfront.ResponseHeadersPolicy(this, 'Headers', {
            securityHeadersBehavior: {
                strictTransportSecurity: { accessControlMaxAge: cdk.Duration.days(365), includeSubdomains: true, override: true },
                contentTypeOptions: { override: true },
                frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
                referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
            },
            // The test environment must never be indexed, whatever the pages say.
            customHeadersBehavior: prod ? undefined : { customHeaders: [{ header: 'X-Robots-Tag', value: 'noindex, nofollow', override: true }] },
        })

        const additionalBehaviors: Record<string, cloudfront.BehaviorOptions> = {}
        if (props.searchEndpoint) {
            additionalBehaviors['/api/search'] = {
                origin: new origins.HttpOrigin(props.searchEndpoint),
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                cachePolicy: new cloudfront.CachePolicy(this, 'SearchCache', {
                    defaultTtl: cdk.Duration.minutes(5),
                    maxTtl: cdk.Duration.hours(1),
                    queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
                }),
                functionAssociations: [
                    {
                        eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
                        function: new cloudfront.Function(this, 'SearchRewrite', {
                            runtime: cloudfront.FunctionRuntime.JS_2_0,
                            code: cloudfront.FunctionCode.fromInline(searchRewriteCode()),
                            comment: '/api/search?q= -> CloudSearch structured query',
                        }),
                    },
                ],
                responseHeadersPolicy: headers,
            }
        }
        if (props.checkoutApiDomain) {
            additionalBehaviors['/api/*'] = {
                origin: new origins.HttpOrigin(props.checkoutApiDomain),
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
                cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
                originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
                responseHeadersPolicy: headers,
            }
        }

        const names = props.domain && props.certificate ? [props.domain, `www.${props.domain}`] : undefined
        const distribution = new cloudfront.Distribution(this, 'Distribution', {
            comment: `Kreditrisker.se ${props.environmentName}`,
            domainNames: names,
            certificate: names ? props.certificate : undefined,
            priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
            httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
            defaultBehavior: {
                origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
                compress: true,
                functionAssociations: [{ eventType: cloudfront.FunctionEventType.VIEWER_REQUEST, function: siteFunction }],
                responseHeadersPolicy: headers,
            },
            additionalBehaviors,
            // A missing object is a 403 from S3 with origin access control.
            errorResponses: [403, 404].map((httpStatus) => ({ httpStatus, responseHttpStatus: 404, responsePagePath: '/404.html', ttl: cdk.Duration.minutes(5) })),
        })

        if (names && props.hostedZoneId) {
            const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId: props.hostedZoneId, zoneName: props.domain! })
            const target = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution))
            for (const recordName of names) {
                new route53.ARecord(this, `A-${recordName}`, { zone, recordName, target })
                new route53.AaaaRecord(this, `AAAA-${recordName}`, { zone, recordName, target })
            }
        }

        new cdk.CfnOutput(this, 'SiteBucketName', { value: siteBucket.bucketName, description: 'Jenkins BUILD_BUCKET' })
        new cdk.CfnOutput(this, 'DistributionId', { value: distribution.distributionId, description: 'Jenkins CLOUDFRONT_DISTRIBUTION_ID' })
        new cdk.CfnOutput(this, 'DistributionDomain', { value: distribution.distributionDomainName })
        new cdk.CfnOutput(this, 'StateUri', { value: `s3://${stateBucket.bucketName}/index.jsonl`, description: 'Jenkins STATE_URI' })
    }
}

/** CloudFront certificates must live in us-east-1. */
export class CertStack extends cdk.Stack {
    readonly certificate: acm.ICertificate
    constructor(scope: Construct, id: string, props: cdk.StackProps & { domain: string; hostedZoneId: string }) {
        super(scope, id, props)
        const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId: props.hostedZoneId, zoneName: props.domain })
        this.certificate = new acm.Certificate(this, 'Certificate', {
            domainName: props.domain,
            subjectAlternativeNames: [`www.${props.domain}`],
            validation: acm.CertificateValidation.fromDns(zone),
        })
    }
}
