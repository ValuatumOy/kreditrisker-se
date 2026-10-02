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
        //     --secret-string '{"STRIPE_SECRET_KEY":"sk_...","STRIPE_WEBHOOK_SECRET":"whsec_...","VALUATUM_REST_URL":"https://...","VALUATUM_REST_TOKEN":"..."}'
        const appSecret = secretsmanager.Secret.fromSecretNameV2(
            this,
            'ReportCheckoutSecrets',
            `kreditrisker-se-${props.environmentName.toLowerCase()}`
        )

        const adminEmail =
            props.reportAdminEmail ?? 'luottoriskiraportti202605@valuatum.com'

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
        emailFailureTopic.addSubscription(
            new subscriptions.EmailSubscription(adminEmail)
        )
        emailConfigurationSet.addEventDestination('EmailFailureEvents', {
            destination: ses.EventDestination.snsTopic(emailFailureTopic),
            events: [
                ses.EmailSendingEvent.BOUNCE,
                ses.EmailSendingEvent.COMPLAINT,
                ses.EmailSendingEvent.REJECT,
            ],
        })

        const commonEnv: Record<string, string> = {
            ORDERS_TABLE: ordersTable.tableName,
            ORDERS_STATUS_INDEX: 'StatusIndex',
            CREDITS_TABLE: creditsTable.tableName,
            CREDITS_NOTIFICATION_INDEX: 'NotificationIndex',
            SITE_URL: props.siteUrl,
            FROM_EMAIL: props.reportFromEmail ?? 'noreply@valuatum.com',
            ADMIN_EMAIL: adminEmail,
            SES_CONFIGURATION_SET: emailConfigurationSet.configurationSetName,
            REPORT_ENGINE_URL: REPORT_ENGINE[props.environmentName].url,
            REPORT_ENGINE_REGION: 'eu-west-1',
            REPORT_ENGINE_USERNAME:
                props.reportEngineUsername ?? 'kreditrisker.se',
            APP_SECRETS_ARN: appSecret.secretArn,
            NODE_OPTIONS: '--enable-source-maps',
            CONTACT_EMAIL: props.contactEmail ?? '',
            ...props.stripeProducts,
        }

        const makeFn = (
            name: string,
            entry: string,
            timeout = 30
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
                environment: commonEnv,
                logGroup,
                bundling: {
                    minify: true,
                    sourceMap: true,
                    externalModules: [
                        '@aws-sdk/client-dynamodb',
                        '@aws-sdk/client-secrets-manager',
                        '@aws-sdk/client-sesv2',
                        '@aws-sdk/credential-provider-node',
                        '@aws-sdk/lib-dynamodb',
                        '@aws-sdk/protocol-http',
                        '@aws-sdk/signature-v4',
                    ],
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
        const creditNotificationFn = makeFn(
            'CreditNotificationFn',
            'credit-notifications.js'
        )
        const pollerFn = makeFn('ReportPollerFn', 'poller.js', 120)

        appSecret.grantRead(createCheckoutFn)
        appSecret.grantRead(webhookFn)
        appSecret.grantRead(pollerFn)
        ordersTable.grantReadWriteData(webhookFn)
        ordersTable.grantReadWriteData(pollerFn)
        ordersTable.grantReadWriteData(redeemFn)
        creditsTable.grantReadWriteData(redeemFn)
        creditsTable.grantReadWriteData(webhookFn)
        creditsTable.grantReadWriteData(pollerFn)
        creditsTable.grantReadWriteData(creditNotificationFn)

        // Invoke the report engine's Function URL (SigV4). The engine owner must
        // ALSO grant access on their side — see report_generation_api.md.
        const invokePolicy = new iam.PolicyStatement({
            actions: ['lambda:InvokeFunctionUrl'],
            resources: [REPORT_ENGINE[props.environmentName].arn],
            conditions: {
                StringEquals: {
                    'lambda:FunctionUrlAuthType': 'AWS_IAM',
                },
            },
        })
        webhookFn.addToRolePolicy(invokePolicy)
        pollerFn.addToRolePolicy(invokePolicy)
        // /api/redeem starts a package-funded report itself, so it submits jobs
        // exactly like the webhook does for a paid one.
        redeemFn.addToRolePolicy(invokePolicy)

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
        reportApi.addRoutes({
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
