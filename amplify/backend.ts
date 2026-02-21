import * as path from 'node:path';
import { defineBackend } from '@aws-amplify/backend';
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaDestinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as sqs from 'aws-cdk-lib/aws-sqs';

const backend = defineBackend({});
const stack = backend.createStack('logsAnalytics');

function envOrDefault(name: string, fallback: string): string {
  const value = process.env[name];
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

const stageName = envOrDefault('STAGE_NAME', envOrDefault('AMPLIFY_ENV', 'dev'));
const fflogsTokenUrl = envOrDefault('FFLOGS_TOKEN_URL', 'https://www.fflogs.com/oauth/token');
const fflogsGraphqlUrl = envOrDefault('FFLOGS_GRAPHQL_URL', 'https://www.fflogs.com/api/v2/client');
const xivApiBaseUrl = envOrDefault('XIVAPI_BASE_URL', 'https://xivapi.com');
const xivApiLang = envOrDefault('XIVAPI_LANG', 'ja');
const abilitySeedIds = envOrDefault('ABILITY_SEED_IDS', '');
const abilitySyncSchedule = envOrDefault('ABILITY_SYNC_SCHEDULE', 'rate(1 day)');
const abilitySyncPageLimit = envOrDefault('ABILITY_SYNC_PAGE_LIMIT', '500');
const abilitySyncMaxPages = envOrDefault('ABILITY_SYNC_MAX_PAGES', '200');

const fflogsClientId = envOrDefault('FFLOGS_CLIENT_ID', '');
const fflogsClientSecret = envOrDefault('FFLOGS_CLIENT_SECRET', '');

if (!fflogsClientId || !fflogsClientSecret) {
  // eslint-disable-next-line no-console
  console.warn(
    '[amplify/backend.ts] FFLOGS_CLIENT_ID / FFLOGS_CLIENT_SECRET are empty. Set them in Amplify environment variables.'
  );
}

const abilityMasterTable = new dynamodb.Table(stack, 'AbilityMasterTable', {
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  partitionKey: { name: 'abilityId', type: dynamodb.AttributeType.NUMBER }
});

const analysisCacheTable = new dynamodb.Table(stack, 'AnalysisCacheTable', {
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  partitionKey: { name: 'cacheKey', type: dynamodb.AttributeType.STRING },
  timeToLiveAttribute: 'ttl'
});

const commonEnv = {
  FFLOGS_CLIENT_ID: fflogsClientId,
  FFLOGS_CLIENT_SECRET: fflogsClientSecret,
  FFLOGS_TOKEN_URL: fflogsTokenUrl,
  FFLOGS_GRAPHQL_URL: fflogsGraphqlUrl,
  XIVAPI_BASE_URL: xivApiBaseUrl,
  XIVAPI_LANG: xivApiLang,
  ABILITY_MASTER_TABLE: abilityMasterTable.tableName,
  ANALYSIS_CACHE_TABLE: analysisCacheTable.tableName,
  ABILITY_SEED_IDS: abilitySeedIds,
  ABILITY_SYNC_PAGE_LIMIT: abilitySyncPageLimit,
  ABILITY_SYNC_MAX_PAGES: abilitySyncMaxPages,
  STAGE_NAME: stageName
};

const amplifyAssetRoot = path.resolve(process.cwd(), 'amplify');

const apiFunction = new lambda.Function(stack, 'ApiFunction', {
  runtime: lambda.Runtime.NODEJS_20_X,
  architecture: lambda.Architecture.ARM_64,
  code: lambda.Code.fromAsset(amplifyAssetRoot),
  handler: 'lambda/api-handler.handler',
  timeout: cdk.Duration.seconds(30),
  memorySize: 1024,
  environment: commonEnv
});

const abilitySyncDlq = new sqs.Queue(stack, 'AbilitySyncDlq', {
  retentionPeriod: cdk.Duration.days(14)
});

const abilitySyncFunction = new lambda.Function(stack, 'AbilitySyncFunction', {
  runtime: lambda.Runtime.NODEJS_20_X,
  architecture: lambda.Architecture.ARM_64,
  code: lambda.Code.fromAsset(amplifyAssetRoot),
  handler: 'lambda/ability-sync-handler.handler',
  timeout: cdk.Duration.minutes(15),
  memorySize: 1024,
  deadLetterQueueEnabled: true,
  deadLetterQueue: abilitySyncDlq,
  environment: commonEnv
});

abilityMasterTable.grantReadWriteData(apiFunction);
analysisCacheTable.grantReadWriteData(apiFunction);
abilityMasterTable.grantReadWriteData(abilitySyncFunction);

new lambda.EventInvokeConfig(stack, 'AbilitySyncInvokeConfig', {
  function: abilitySyncFunction,
  qualifier: '$LATEST',
  maxEventAge: cdk.Duration.hours(6),
  retryAttempts: 2,
  onFailure: new lambdaDestinations.SqsDestination(abilitySyncDlq)
});

new events.Rule(stack, 'AbilitySyncFunctionSchedule', {
  schedule: events.Schedule.expression(abilitySyncSchedule),
  targets: [new eventsTargets.LambdaFunction(abilitySyncFunction)]
});

const httpApi = new apigwv2.HttpApi(stack, 'ApiGateway', {
  apiName: `logs-analytics-backend-${stageName}`,
  corsPreflight: {
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: [apigwv2.CorsHttpMethod.ANY],
    allowOrigins: ['*']
  }
});

const integration = new apigwv2Integrations.HttpLambdaIntegration('ApiLambdaIntegration', apiFunction);

[
  '/health',
  '/report/fights',
  '/rankings/search',
  '/encounters/search',
  '/encounters/groups',
  '/character/contents',
  '/character/search',
  '/ability-icons'
].forEach((p) => {
  httpApi.addRoutes({
    path: p,
    methods: [apigwv2.HttpMethod.GET],
    integration
  });
});

httpApi.addRoutes({
  path: '/report/analyze',
  methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
  integration
});

new cloudwatch.Alarm(stack, 'ApiFunctionErrorsAlarm', {
  metric: apiFunction.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
  threshold: 1,
  evaluationPeriods: 1,
  comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
  treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
});

new cloudwatch.Alarm(stack, 'AbilitySyncErrorsAlarm', {
  metric: abilitySyncFunction.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
  threshold: 1,
  evaluationPeriods: 1,
  comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
  treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
});

new cloudwatch.Alarm(stack, 'AbilitySyncDurationAlarm', {
  metric: abilitySyncFunction.metricDuration({ period: cdk.Duration.minutes(5), statistic: 'Maximum' }),
  threshold: 840000,
  evaluationPeriods: 1,
  comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
  treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
});

new cloudwatch.Alarm(stack, 'AbilitySyncDlqVisibleMessagesAlarm', {
  metric: abilitySyncDlq.metricApproximateNumberOfMessagesVisible({
    period: cdk.Duration.minutes(5),
    statistic: 'Maximum'
  }),
  threshold: 1,
  evaluationPeriods: 1,
  comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
  treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
});

new cdk.CfnOutput(stack, 'ApiBaseUrl', {
  description: 'HTTP API base URL',
  value: httpApi.apiEndpoint
});

new cdk.CfnOutput(stack, 'AbilityMasterTableName', {
  value: abilityMasterTable.tableName
});

new cdk.CfnOutput(stack, 'AnalysisCacheTableName', {
  value: analysisCacheTable.tableName
});

new cdk.CfnOutput(stack, 'AbilitySyncFunctionName', {
  value: abilitySyncFunction.functionName
});

new cdk.CfnOutput(stack, 'AbilitySyncDlqUrl', {
  value: abilitySyncDlq.queueUrl
});
