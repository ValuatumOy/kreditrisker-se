import * as path from 'path'
import * as cdk from 'aws-cdk-lib'
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2'
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations'
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch'
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as events from 'aws-cdk-lib/aws-events'
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import * as ses from 'aws-cdk-lib/aws-ses'
import * as sns from 'aws-cdk-lib/aws-sns'
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions'
import { Construct } from 'constructs'

// PDF report engine shared with the Finnish and Danish directories (PdfReport-Api).
const REPORT_ENGINE = {
    Test: { url: 'https://7zqqrejifzqphtwfb2imxtn67q0yzekq.lambda-url.eu-west-1.on.aws/', arn: 'arn:aws:lambda:eu-west-1:892885731254:function:pdf-report-api-test' },
    Prod: { url: 'https://jdnrhdk37rmqzayy2km4jyrlgq0uapaw.lambda-url.eu-west-1.on.aws/', arn: 'arn:aws:lambda:eu-west-1:892885731254:function:pdf-report-api' },
}
const STRIPE_PRODUCT_ENV_NAMES = new Set([
    'STRIPE_PRODUCT_SE_BASIC', 'STRIPE_PRODUCT_SE_AI',
    'STRIPE_PRODUCT_SE_BASIC_BUNDLE', 'STRIPE_PRODUCT_SE_AI_BUNDLE',
])

type ReportEngineTarget = { url: string; arn: string }

export interface CheckoutStackProps extends cdk.StackProps {
    environmentName: 'Test' | 'Prod'
    /** Public site origin used in Stripe redirect URLs. */
    siteUrl: string
    reportEngineUsername?: string
    reportFromEmail?: string
    /** Alerts on failed generation and SES adverse events. */
    reportAdminEmail?: string
    /** Customer-facing support address shown in delivery emails (launch gate 8). */
    contactEmail?: string
    /**
     * Stripe product ids per product (STRIPE_PRODUCT_SE_AI, _BASIC, _BASIC_BUNDLE,
     * _AI_BUNDLE). A product without an id is not sold (backend/src/lib/products.js).
     */
    stripeProducts?: Record<string, string>
    /** Enables new sessions; disabling Test also disconnects its report engine. */
    checkoutEnabled?: boolean
    /** Dedicated test engine, with its own queues and data. */
    testReportEngine?: ReportEngineTarget
    /** Version of the approved purchase terms accepted before checkout. */
    termsVersion?: string
    /** Separate Stripe credentials for an enabled test checkout. */
    testSecretName?: string
    /** Suppress only the test stack's email subscription for simulator-only tests. */
    suppressTestAlertSubscription?: boolean
    /** Restrict a temporary test stack to a synthetic company and SES simulator. */
    isolatedFixtureTest?: boolean
}

export function checkoutSecretName(props: Pick<CheckoutStackProps, 'environmentName' | 'checkoutEnabled' | 'testSecretName'>): string {
    if (props.environmentName === 'Prod') {
        if (props.testSecretName) throw new Error('A test secret cannot be configured on the production checkout')
        return 'kreditrisker-se-prod'
    }
    if (props.testSecretName && !/^kreditrisker-se-isolated-[A-Za-z0-9_-]+$/.test(props.testSecretName)) {
        throw new Error('Test secret must use a dedicated kreditrisker-se-isolated- name')
    }
    if (props.checkoutEnabled && !props.testSecretName) {
        throw new Error('Enabled test checkout requires a dedicated test secret')
    }
    return props.testSecretName ?? 'kreditrisker-se-test'
}

export function resolveReportEngine(props: Pick<CheckoutStackProps, 'environmentName' | 'checkoutEnabled' | 'testReportEngine'>): ReportEngineTarget | undefined {
    if (props.environmentName === 'Prod') return REPORT_ENGINE.Prod
    // The TEST switch also disconnects the engine to prevent background
    // webhook or redeem events from launching paid jobs while it is off.
    if (!props.checkoutEnabled) return undefined
    const target = props.testReportEngine
    if (!target) {
        throw new Error('Enabled test checkout requires a separate report engine URL and ARN')
    }
    const url = URL.canParse(target.url) ? new URL(target.url) : null
    const sharedUrls = Object.values(REPORT_ENGINE).map(engine => new URL(engine.url).hostname)
    const sharedArns = Object.values(REPORT_ENGINE).map(engine => engine.arn)
    if (!url || url.protocol !== 'https:' || url.username || url.password || url.port
        || url.pathname !== '/' || url.search || url.hash
        || !/^[a-z0-9-]+\.lambda-url\.eu-west-1\.on\.aws$/.test(url.hostname)
        || sharedUrls.includes(url.hostname)
        || !/^arn:aws:lambda:eu-west-1:\d{12}:function:[A-Za-z0-9_-]+$/.test(target.arn)
        || sharedArns.includes(target.arn)) {
        throw new Error('Test report engine must have a separate Lambda Function URL and function ARN in eu-west-1')
    }
    return { url: url.origin, arn: target.arn }
}

export function validateTestCheckoutSite(props: Pick<CheckoutStackProps, 'environmentName' | 'siteUrl' | 'checkoutEnabled'>): void {
    if (props.environmentName !== 'Test' || !props.checkoutEnabled) return
    const site = URL.canParse(props.siteUrl) ? new URL(props.siteUrl) : null
    const hostname = site?.hostname.replace(/\.$/, '')
    if (!site || site.protocol !== 'https:' || site.username || site.password || site.pathname !== '/' || site.search || site.hash
        || hostname === 'kreditrisker.se' || hostname === 'www.kreditrisker.se') {
        throw new Error('Enabled test checkout requires a separate HTTPS test-site origin; set siteUrlTest')
    }
}

/**
 * Report checkout backend, ported from the Danish directory: Stripe Checkout
 * (manual capture) + async report generation + email delivery. The site's
 * CloudFront distribution (SiteStack) routes /api/* here; Stripe calls the
 * webhook on the direct API Gateway URL. See backend/README.md.
 */
export class CheckoutStack extends cdk.Stack {
    constructor(
        scope: Construct,
        id: string,
        props: CheckoutStackProps
    ) {
        super(scope, id, props)
        if (props.checkoutEnabled && !props.termsVersion) throw new Error('checkoutEnabled requires an approved termsVersion')
        if (props.environmentName === 'Prod' && (props.suppressTestAlertSubscription || props.isolatedFixtureTest)) throw new Error('Production alert subscriptions cannot be suppressed or set to fixture mode')
        if (props.suppressTestAlertSubscription && !props.isolatedFixtureTest) throw new Error('Suppressing test alerts requires isolated fixture mode')
        if (Object.keys(props.stripeProducts ?? {}).some(name => !STRIPE_PRODUCT_ENV_NAMES.has(name))) throw new Error('stripeProducts contains an unsupported environment variable')
        validateTestCheckoutSite(props)
        const reportEngine = resolveReportEngine(props)
        const secretName = checkoutSecretName(props)

        const descriptionPrefix = `${props.environmentName} - Kreditrisker.se`

        const backendRoot = path.resolve(__dirname, '..', '..', 'backend')
        const backendSrc = path.join(backendRoot, 'src')
        const backendLockfile = path.join(backendRoot, 'package-lock.json')

        // Orders table — async job state across the webhook → poller gap.
        const ordersTable = new dynamodb.Table(this, 'OrdersTable', {
            partitionKey: {
                name: 'sessionId',
                type: dynamodb.AttributeType.STRING,
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            pointInTimeRecoverySpecification: {
                pointInTimeRecoveryEnabled: true,
            },
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        })
        // GSI so the poller lists non-terminal orders without a full scan.
        ordersTable.addGlobalSecondaryIndex({
            indexName: 'StatusIndex',
            partitionKey: {
                name: 'status',
                type: dynamodb.AttributeType.STRING,
            },
            projectionType: dynamodb.ProjectionType.ALL,
        })
        ordersTable.addGlobalSecondaryIndex({
            indexName: 'WithdrawalIndex',
            partitionKey: { name: 'withdrawalState', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'withdrawalRequestedAt', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        })

        const creditsTable = new dynamodb.Table(this, 'CreditsTable', {
            partitionKey: {
                name: 'pk',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'sk',
                type: dynamodb.AttributeType.STRING,
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            pointInTimeRecoverySpecification: {
                pointInTimeRecoveryEnabled: true,
            },
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        })
        creditsTable.addGlobalSecondaryIndex({
            indexName: 'NotificationIndex',
            partitionKey: {
                name: 'notificationQueue',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'notificationNextAttemptAt',
                type: dynamodb.AttributeType.STRING,
            },
            projectionType: dynamodb.ProjectionType.ALL,
        })

        // One JSON secret holding the Stripe keys. Created and populated OUT OF
        // BAND (console/CLI) — the stack only references it, so `cdk deploy` can
        // never overwrite the real keys. Email needs no secret: SES authenticates
        // through the poller's execution role. Create once before the first
        // deploy of a new environment:
        //   aws secretsmanager create-secret --name kreditrisker-se-<env> \
        //     --secret-string '{"STRIPE_SECRET_KEY":"sk_...","STRIPE_WEBHOOK_SECRET":"whsec_..."}'
        // VALUATUM_REST_URL / VALUATUM_REST_TOKEN are needed only by a product
        // with generator 'valuatumRest'; both Swedish reports use the engine.
        const appSecret = secretsmanager.Secret.fromSecretNameV2(
            this,
            'ReportCheckoutSecrets',
            secretName
        )

        const adminEmail = props.isolatedFixtureTest
            ? 'success@simulator.amazonses.com'
            : props.reportAdminEmail ?? 'luottoriskiraportti202605@valuatum.com'

        // SES configuration set applied to every send. Suppression keeps hard
        // bounces and complaints from being re-mailed (protecting the shared
        // valuatum.com sending reputation), and reputation metrics surface
        // bounce/complaint rates in CloudWatch.
        const emailConfigurationSet = new ses.ConfigurationSet(
            this,
            'EmailConfigurationSet',
            {
                configurationSetName: `kreditrisker-se-${props.environmentName.toLowerCase()}-transactional`,
                reputationMetrics: true,
                suppressionReasons:
                    ses.SuppressionReasons.BOUNCES_AND_COMPLAINTS,
            }
        )

        // Adverse SES events are operational alerts only — nothing consumes them
        // in code, and the order state machine does not depend on them. Each
        // deployed stack owns its own topic, so the address below confirms one
        // subscription per environment.
        const emailFailureTopic = new sns.Topic(this, 'EmailFailureTopic', {
            displayName: `${descriptionPrefix} SES adverse events`,
        })
        if (!(props.environmentName === 'Test' && props.suppressTestAlertSubscription)) {
            emailFailureTopic.addSubscription(new subscriptions.EmailSubscription(adminEmail))
        }
        emailConfigurationSet.addEventDestination('EmailFailureEvents', {
            destination: ses.EventDestination.snsTopic(emailFailureTopic),
            events: [
                ses.EmailSendingEvent.BOUNCE,
                ses.EmailSendingEvent.COMPLAINT,
                ses.EmailSendingEvent.REJECT,
            ],
        })

        const commonEnv: Record<string, string> = {
            ...props.stripeProducts,
            ORDERS_TABLE: ordersTable.tableName,
            ORDERS_STATUS_INDEX: 'StatusIndex',
            CREDITS_TABLE: creditsTable.tableName,
            CREDITS_NOTIFICATION_INDEX: 'NotificationIndex',
            SITE_URL: props.siteUrl,
            FROM_EMAIL: props.reportFromEmail ?? 'noreply@valuatum.com',
            ADMIN_EMAIL: adminEmail,
            SES_CONFIGURATION_SET: emailConfigurationSet.configurationSetName,
            REPORT_ENGINE_URL: reportEngine?.url ?? '',
            REPORT_ENGINE_REGION: 'eu-west-1',
            REPORT_ENGINE_USERNAME:
                props.reportEngineUsername ?? 'kreditrisker.se',
            APP_SECRETS_ARN: appSecret.secretArn,
            NODE_OPTIONS: '--enable-source-maps',
            CONTACT_EMAIL: props.contactEmail ?? '',
            REPORT_CHECKOUT_ENABLED: props.checkoutEnabled ? '1' : '0',
            REPORT_TERMS_VERSION: props.termsVersion ?? '',
            REPORT_ISOLATED_FIXTURE_TEST: props.environmentName === 'Test' && props.isolatedFixtureTest ? '1' : '0',
        }

        const makeFn = (
            name: string,
            entry: string,
            timeout = 30,
            reservedConcurrentExecutions?: number
        ): NodejsFunction => {
            const logGroup = new logs.LogGroup(this, `${name}Logs`, {
                retention: logs.RetentionDays.ONE_MONTH,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
            })
            return new NodejsFunction(this, name, {
                entry: path.join(backendSrc, 'handlers', entry),
                projectRoot: backendRoot,
                depsLockFilePath: backendLockfile,
                handler: 'handler',
                runtime: lambda.Runtime.NODEJS_22_X,
                memorySize: 256,
                timeout: cdk.Duration.seconds(timeout),
                reservedConcurrentExecutions,
                environment: commonEnv,
                logGroup,
                bundling: {
                    minify: true,
                    sourceMap: true,
                    // The email adapter uses SES attachment support from the
                    // installed SDK. Do not rely on Lambda's changing version.
                    bundleAwsSDK: true,
                },
            })
        }

        const createCheckoutFn = makeFn(
            'CreateCheckoutFn',
            'create-checkout.js',
            15
        )
        const webhookFn = makeFn('WebhookFn', 'webhook.js')
        const redeemFn = makeFn('RedeemFn', 'redeem.js')
        const withdrawalFn = makeFn('WithdrawalFn', 'withdrawal.js')
        const creditNotificationFn = makeFn(
            'CreditNotificationFn',
            'credit-notifications.js'
        )
        // A run can last longer than its one-minute schedule. Serializing the
        // function prevents overlapping runs from sending the same order twice.
        const pollerFn = makeFn('ReportPollerFn', 'poller.js', 120, 1)

        appSecret.grantRead(createCheckoutFn)
        appSecret.grantRead(webhookFn)
        appSecret.grantRead(pollerFn)
        ordersTable.grantReadWriteData(webhookFn)
        ordersTable.grantReadWriteData(pollerFn)
        ordersTable.grantReadWriteData(redeemFn)
        ordersTable.grantReadWriteData(withdrawalFn)
        creditsTable.grantReadWriteData(redeemFn)
        creditsTable.grantReadWriteData(webhookFn)
        creditsTable.grantReadWriteData(pollerFn)
        creditsTable.grantReadWriteData(creditNotificationFn)

        // Invoke the report engine's Function URL (SigV4). The engine owner must
        // ALSO grant access on their side — see report_generation_api.md.
        if (reportEngine) {
            const invokePolicy = new iam.PolicyStatement({
                actions: ['lambda:InvokeFunctionUrl'],
                resources: [reportEngine.arn],
                conditions: {
                    StringEquals: {
                        'lambda:FunctionUrlAuthType': 'AWS_IAM',
                    },
                },
            })
            const invokeViaUrlPolicy = new iam.PolicyStatement({
                actions: ['lambda:InvokeFunction'],
                resources: [reportEngine.arn],
                conditions: {
                    Bool: { 'lambda:InvokedViaFunctionUrl': 'true' },
                },
            })
            webhookFn.addToRolePolicy(invokePolicy)
            webhookFn.addToRolePolicy(invokeViaUrlPolicy)
            pollerFn.addToRolePolicy(invokePolicy)
            pollerFn.addToRolePolicy(invokeViaUrlPolicy)
            // /api/redeem submits package-funded report jobs too.
            redeemFn.addToRolePolicy(invokePolicy)
            redeemFn.addToRolePolicy(invokeViaUrlPolicy)
        }

        // Send report/alert mail. The poller is the only Lambda that emails, so
        // create-checkout and webhook deliberately get no SES permission. Scoped
        // to the one verified identity — this role cannot send as anyone else.
        // Naming a configuration set on a send makes it a second authorized
        // resource: without it SES denies every SendEmail from this role.
        pollerFn.addToRolePolicy(
            new iam.PolicyStatement({
                actions: ['ses:SendEmail'],
                resources: [
                    cdk.Stack.of(this).formatArn({
                        service: 'ses',
                        resource: 'identity',
                        resourceName: 'valuatum.com',
                    }),
                    cdk.Stack.of(this).formatArn({
                        service: 'ses',
                        resource: 'configuration-set',
                        resourceName:
                            emailConfigurationSet.configurationSetName,
                    }),
                ],
            })
        )
        creditNotificationFn.addToRolePolicy(
            new iam.PolicyStatement({
                actions: ['ses:SendEmail'],
                resources: [
                    cdk.Stack.of(this).formatArn({
                        service: 'ses',
                        resource: 'identity',
                        resourceName: 'valuatum.com',
                    }),
                    cdk.Stack.of(this).formatArn({
                        service: 'ses',
                        resource: 'configuration-set',
                        resourceName:
                            emailConfigurationSet.configurationSetName,
                    }),
                ],
            })
        )
        withdrawalFn.addToRolePolicy(new iam.PolicyStatement({
            actions: ['ses:SendEmail'],
            resources: [
                cdk.Stack.of(this).formatArn({ service: 'ses', resource: 'identity', resourceName: 'valuatum.com' }),
                cdk.Stack.of(this).formatArn({ service: 'ses', resource: 'configuration-set', resourceName: emailConfigurationSet.configurationSetName }),
            ],
        }))

        const reportApi = new apigwv2.HttpApi(this, 'ReportCheckoutApi', {
            apiName: 'dk-company-directory-report-checkout',
            description: `${descriptionPrefix} AI report Stripe checkout API`,
            corsPreflight: {
                allowOrigins: [props.siteUrl, 'http://localhost:4321'],
                allowMethods: [
                    apigwv2.CorsHttpMethod.GET,
                    apigwv2.CorsHttpMethod.POST,
                    apigwv2.CorsHttpMethod.OPTIONS,
                ],
                allowHeaders: ['content-type'],
                maxAge: cdk.Duration.hours(1),
            },
        })
        const checkoutRoutes = reportApi.addRoutes({
            path: '/api/create-checkout',
            methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
            integration: new integrations.HttpLambdaIntegration(
                'CreateCheckoutInt',
                createCheckoutFn
            ),
        })
        reportApi.addRoutes({
            path: '/api/webhook',
            methods: [apigwv2.HttpMethod.POST],
            integration: new integrations.HttpLambdaIntegration(
                'WebhookInt',
                webhookFn
            ),
        })
        reportApi.addRoutes({
            path: '/api/redeem',
            methods: [apigwv2.HttpMethod.POST],
            integration: new integrations.HttpLambdaIntegration(
                'RedeemInt',
                redeemFn
            ),
        })
        const withdrawalRoutes = reportApi.addRoutes({
            path: '/api/withdrawal',
            methods: [apigwv2.HttpMethod.POST],
            integration: new integrations.HttpLambdaIntegration('WithdrawalInt', withdrawalFn),
        })
        const stage = reportApi.defaultStage?.node.defaultChild as apigwv2.CfnStage
        // RouteSettings references route keys, not resource IDs; CloudFormation
        // otherwise creates the stage before the routes exist and rejects it.
        for (const route of [...checkoutRoutes, ...withdrawalRoutes]) stage.node.addDependency(route)
        stage.addPropertyOverride('RouteSettings', {
            'POST /api/withdrawal': { ThrottlingRateLimit: 2, ThrottlingBurstLimit: 4 },
            ...(props.isolatedFixtureTest ? {
                'POST /api/create-checkout': { ThrottlingRateLimit: 0.5, ThrottlingBurstLimit: 2 },
            } : {}),
        })

        // Poller runs ~every minute.
        new events.Rule(this, 'ReportPollerSchedule', {
            schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
            targets: [new eventsTargets.LambdaFunction(pollerFn)],
        })
        creditNotificationFn.configureAsyncInvoke({ retryAttempts: 0 })
        new events.Rule(this, 'CreditNotificationSchedule', {
            schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
            targets: [
                new eventsTargets.LambdaFunction(creditNotificationFn, {
                    retryAttempts: 0,
                }),
            ],
        })
        const creditNotificationAlarm = new cloudwatch.Alarm(
            this,
            'CreditNotificationFailureAlarm',
            {
                metric: creditNotificationFn.metricErrors({
                    period: cdk.Duration.minutes(1),
                }),
                threshold: 1,
                evaluationPeriods: 1,
                treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
            }
        )
        creditNotificationAlarm.addAlarmAction(
            new cloudwatchActions.SnsAction(emailFailureTopic)
        )

        // The poller catches errors per order so one broken delivery doesn't
        // block the rest. Lambda Errors alone therefore misses those failures.
        const pollerOrderErrors = new logs.MetricFilter(this, 'ReportPollerOrderErrors', {
            logGroup: pollerFn.logGroup,
            metricNamespace: `KreditriskerSE/${props.environmentName}`,
            metricName: 'ReportOrderErrors',
            filterPattern: logs.FilterPattern.literal('"poller: order error"'),
            metricValue: '1',
            defaultValue: 0,
        })
        const webhookPaymentErrors = new logs.MetricFilter(this, 'WebhookPaymentReviewErrors', {
            logGroup: webhookFn.logGroup,
            metricNamespace: `KreditriskerSE/${props.environmentName}`,
            metricName: 'WebhookPaymentReviewRequired',
            filterPattern: logs.FilterPattern.literal('"webhook: payment review required"'),
            metricValue: '1', defaultValue: 0,
        })
        for (const [id, metric] of [
            ['WebhookPaymentReviewAlarm', webhookPaymentErrors.metric({ period: cdk.Duration.minutes(1), statistic: 'Sum' })],
            ['ReportPollerOrderErrorAlarm', pollerOrderErrors.metric({ period: cdk.Duration.minutes(1), statistic: 'Sum' })],
            ['ReportPollerRuntimeErrorAlarm', pollerFn.metricErrors({ period: cdk.Duration.minutes(1) })],
        ] as const) {
            new cloudwatch.Alarm(this, id, {
                metric,
                threshold: 1,
                evaluationPeriods: 1,
                treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
            }).addAlarmAction(new cloudwatchActions.SnsAction(emailFailureTopic))
        }
        for (const [id, fn] of [['WithdrawalApi', withdrawalFn], ['WithdrawalWorker', pollerFn]] as const) {
            const metric = new logs.MetricFilter(this, `${id}Errors`, {
                logGroup: fn.logGroup,
                metricNamespace: `KreditriskerSE/${props.environmentName}`,
                metricName: `${id}Errors`,
                filterPattern: logs.FilterPattern.literal('"withdrawal: processing error"'),
                metricValue: '1', defaultValue: 0,
            })
            new cloudwatch.Alarm(this, `${id}ErrorAlarm`, {
                metric: metric.metric({ period: cdk.Duration.minutes(1), statistic: 'Sum' }),
                threshold: 1, evaluationPeriods: 1,
                treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
            }).addAlarmAction(new cloudwatchActions.SnsAction(emailFailureTopic))
        }
        const manualRefunds = new logs.MetricFilter(this, 'WithdrawalManualRefunds', {
            logGroup: pollerFn.logGroup,
            metricNamespace: `KreditriskerSE/${props.environmentName}`,
            metricName: 'WithdrawalManualRefundRequired',
            filterPattern: logs.FilterPattern.literal('"withdrawal: manual refund required"'),
            metricValue: '1', defaultValue: 0,
        })
        new cloudwatch.Alarm(this, 'WithdrawalManualRefundAlarm', {
            metric: manualRefunds.metric({ period: cdk.Duration.minutes(1), statistic: 'Sum' }),
            threshold: 1, evaluationPeriods: 1,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        }).addAlarmAction(new cloudwatchActions.SnsAction(emailFailureTopic))

        new cdk.CfnOutput(this, 'ReportCheckoutApiUrl', {
            value: reportApi.apiEndpoint,
            description:
                'Direct HTTP API endpoint. Add it as the /api/* CloudFront origin AND set the Stripe webhook to <this>/api/webhook.',
        })
        new cdk.CfnOutput(this, 'ReportCheckoutApiDomain', {
            value: `${reportApi.httpApiId}.execute-api.${this.region}.amazonaws.com`,
            description:
                'Bare API Gateway domain to use as the CloudFront /api/* origin.',
        })
        new cdk.CfnOutput(this, 'ReportCheckoutSecretArn', {
            value: appSecret.secretArn,
        })
        new cdk.CfnOutput(this, 'OrdersTableName', {
            value: ordersTable.tableName,
        })
        new cdk.CfnOutput(this, 'CreditsTableName', {
            value: creditsTable.tableName,
        })
        new cdk.CfnOutput(this, 'EmailConfigurationSetName', {
            value: emailConfigurationSet.configurationSetName,
            description:
                'SES configuration set applied to every send (suppression + reputation metrics + adverse-event publishing).',
        })
        new cdk.CfnOutput(this, 'EmailFailureTopicArn', {
            value: emailFailureTopic.topicArn,
            description: `SES adverse-event topic. Confirm the email subscription sent to ${adminEmail} — one per deployed stack.`,
        })
    }
}
