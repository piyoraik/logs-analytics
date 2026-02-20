# AWS IaC (SAM)

## What this creates
- `HttpApi`:
  - `GET /health`
  - `GET /report/fights`
  - `GET /rankings/search`
  - `GET /encounters/search`
  - `GET /encounters/groups`
  - `GET /ability-icons`
  - `POST /report/analyze`
- Lambda:
  - `infra/lambda/api-handler.js` (runtime API)
  - `infra/lambda/ability-sync-handler.js` (scheduled ability sync)
- DynamoDB:
  - `AbilityMaster` (`abilityId` as PK)
  - `AnalysisCache` (`cacheKey` as PK, TTL enabled)
- EventBridge schedule:
  - runs ability sync daily by default
- Retry automation:
  - Lambda async retry (`MaximumRetryAttempts: 2`)
  - DLQ (`fflogs-ability-sync-dlq-<stage>`)
- CloudWatch alarms:
  - API errors
  - Ability sync errors / long duration
  - DLQ visible messages

## Prerequisites
- AWS CLI configured
- AWS SAM CLI installed
- Node.js 20+

## Deploy
1. Build app dist (Lambda reuses `dist/*` modules):
```bash
cd /Users/s-tanaka/work/logs_analytics
npm run build
```

2. Prepare Lambda payload files (`infra/dist`):
```bash
cd /Users/s-tanaka/work/logs_analytics/infra
npm run prepare:lambda
```

3. Build + deploy:
```bash
rm -rf .aws-sam
sam build -t template.yaml
sam deploy --guided -t template.yaml
```

## Preflight (before deploy)
Validate XIVAPI icon resolution locally:

```bash
cd /Users/s-tanaka/work/logs_analytics/infra
npm run preflight:xivapi
```

You should see sampled rows with `iconUrl` like:
`https://v2.xivapi.com/api/asset?path=ui%2Ficon%2F...`
and HTTP `status: 200`.

## Required parameters
- `FFLogsClientId`
- `FFLogsClientSecret`

## Optional parameters
- `XivApiBaseUrl` (default: `https://v2.xivapi.com`)
- `XivApiLang` (default: `ja`)
- `AbilitySeedIds` (comma-separated IDs for periodic sync)
- `AbilitySyncSchedule` (default: `rate(1 day)`)
- `ABILITY_SYNC_PAGE_LIMIT` (env, default `500`)
- `ABILITY_SYNC_MAX_PAGES` (env, default `200`)

If `AbilitySeedIds` is empty, `ability-sync-handler` runs full sync for XIVAPI `Action` sheet with pagination.
When response has `partial: true` and `nextAfter`, invoke again with payload:

```json
{ "after": 12345 }
```

## Amplify (Next.js) integration
Set this env var in Amplify:
- `NEXT_PUBLIC_API_BASE_URL=https://<api-id>.execute-api.<region>.amazonaws.com/<stage>`

Then web client will call Lambda API directly (no Next.js internal `/api/*` dependency for runtime data).
