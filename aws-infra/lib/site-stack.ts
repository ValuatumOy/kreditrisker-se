import * as cdk from 'aws-cdk-lib'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as events from 'aws-cdk-lib/aws-events'
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as targets from 'aws-cdk-lib/aws-route53-targets'
import * as s3 from 'aws-cdk-lib/aws-s3'
import { Construct } from 'constructs'
import { siteRequestCode } from './functions'

/** Search Lambda package in the state bucket, written by Jenkins (scripts/search-db.ts). */
export const SEARCH_CODE_KEY = 'search/search.zip'

export interface SiteStackProps extends cdk.StackProps {
    environmentName: 'Test' | 'Prod'
    /** Apex domain, e.g. kreditrisker.se. Omit to serve on the CloudFront domain only. */
    domain?: string
    /** Route 53 hosted zone of `domain` (created automatically when the domain is bought in Route 53). */
    hostedZoneId?: string
    /** us-east-1 certificate for domain + www (CertStack). */
    certificate?: acm.ICertificate
    /** Company search Lambda behind /api/search. Its package must be in the state bucket at
     *  SEARCH_CODE_KEY before the first deploy (docs/AWS-SETUP.md). */
    search?: boolean
    /** Report checkout HTTP API host (CheckoutStack output), for /api/* except search. */
    checkoutApiDomain?: string
    /** IAM role of the Jenkins build agent (an existing role, not managed here): gets write access to both buckets,
     *  CloudFront invalidation and read access to this stack's outputs, which the job reads instead of hardcoded ids. */
    buildRoleName?: string
}

/**
 * Static hosting for the Swedish directory: a private S3 bucket behind
 * CloudFront (Jenkins copies `dist/` into it), plus a private bucket for the
 * build state (the directory index carried between nightly runs).
 *
 *   /*                 S3, with /path/ -> /path/index.html and apex -> www
 *   /api/search        search Lambda (SQLite database in its package, search/handler.ts)
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
        let searchFunction: lambda.Function | undefined
        if (props.search) {
            // Jenkins replaces the code every night (update-function-code from SEARCH_CODE_KEY); the key never
            // changes, so a later deploy of this stack leaves that code alone.
            searchFunction = new lambda.Function(this, 'Search', {
                description: `${props.environmentName} - kreditrisker.se company search (code: Jenkins, state bucket ${SEARCH_CODE_KEY})`,
                runtime: lambda.Runtime.NODEJS_22_X,
                architecture: lambda.Architecture.ARM_64,
                memorySize: 1024,
                timeout: cdk.Duration.seconds(10),
                handler: 'handler.handler',
                code: lambda.Code.fromBucket(stateBucket, SEARCH_CODE_KEY),
                logGroup: new logs.LogGroup(this, 'SearchLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: cdk.RemovalPolicy.DESTROY }),
            })
            cdk.Annotations.of(this).acknowledgeWarning('@aws-cdk/aws-lambda:codeFromBucketObjectVersionNotSpecified', 'on purpose: Jenkins updates the code')
            // Keeps one instance warm, and fully read into memory, between searches.
            new events.Rule(this, 'SearchPing', {
                schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
                targets: [new eventsTargets.LambdaFunction(searchFunction, { event: events.RuleTargetInput.fromObject({ ping: true }), retryAttempts: 0 })],
            })
            const url = searchFunction.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM })
            additionalBehaviors['/api/search'] = {
                origin: origins.FunctionUrlOrigin.withOriginAccessControl(url),
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                cachePolicy: new cloudfront.CachePolicy(this, 'SearchCache', {
                    defaultTtl: cdk.Duration.minutes(5),
                    maxTtl: cdk.Duration.hours(1),
                    queryStringBehavior: cloudfront.CacheQueryStringBehavior.allowList('q', 'size'),
                }),
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

        if (searchFunction) {
            // Function URLs with IAM auth also need lambda:InvokeFunction for the caller (the origin adds InvokeFunctionUrl).
            searchFunction.addPermission('SearchInvokeFromCloudFront', {
                principal: new iam.ServicePrincipal('cloudfront.amazonaws.com'),
                action: 'lambda:InvokeFunction',
                sourceArn: this.formatArn({ service: 'cloudfront', region: '', resource: 'distribution', resourceName: distribution.distributionId }),
            })
        }

        if (names && props.hostedZoneId) {
            const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId: props.hostedZoneId, zoneName: props.domain! })
            const target = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution))
            for (const recordName of names) {
                new route53.ARecord(this, `A-${recordName}`, { zone, recordName, target })
                new route53.AaaaRecord(this, `AAAA-${recordName}`, { zone, recordName, target })
            }
        }

        if (props.buildRoleName) {
            const buildRole = iam.Role.fromRoleName(this, 'BuildRole', props.buildRoleName)
            siteBucket.grantReadWrite(buildRole)
            siteBucket.grantDelete(buildRole)
            stateBucket.grantReadWrite(buildRole)
            distribution.grantCreateInvalidation(buildRole)
            buildRole.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['cloudformation:DescribeStacks'], resources: [this.stackId] }))
            if (searchFunction) {
                buildRole.addToPrincipalPolicy(
                    new iam.PolicyStatement({
                        actions: ['lambda:UpdateFunctionCode', 'lambda:GetFunction', 'lambda:GetFunctionConfiguration', 'lambda:InvokeFunction'],
                        resources: [searchFunction.functionArn],
                    }),
                )
            }
        }

        new cdk.CfnOutput(this, 'SiteBucketName', { value: siteBucket.bucketName, description: 'Jenkins BUILD_BUCKET' })
        new cdk.CfnOutput(this, 'DistributionId', { value: distribution.distributionId, description: 'Jenkins CLOUDFRONT_DISTRIBUTION_ID' })
        new cdk.CfnOutput(this, 'DistributionDomain', { value: distribution.distributionDomainName })
        new cdk.CfnOutput(this, 'SiteOrigin', {
            value: names ? `https://www.${props.domain}` : `https://${distribution.distributionDomainName}`,
            description: 'Jenkins SE_SITE_ORIGIN (canonical URLs, sitemaps)',
        })
        if (searchFunction) new cdk.CfnOutput(this, 'SearchFunctionName', { value: searchFunction.functionName, description: 'Jenkins SEARCH_FUNCTION' })
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
