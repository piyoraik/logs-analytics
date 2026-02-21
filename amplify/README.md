# Amplify Gen2 Backend

`amplify/backend.ts` で、従来SAM(`infra/template.yaml`)と同等のバックエンドをCDKとして定義しています。

作成される主なリソース:

- HTTP API (`/health`, `/report/*`, `/rankings/search`, `/encounters/*`, `/character/*`, `/ability-icons`)
- Lambda (`api-handler`, `ability-sync-handler`)
- DynamoDB (`fflogs-ability-master-<stage>`, `fflogs-analysis-cache-<stage>`)
- EventBridge schedule (ability sync)
- DLQ + EventInvokeConfig
- CloudWatch alarms

## 必須環境変数 (Amplify Console)

- `FFLOGS_CLIENT_ID`
- `FFLOGS_CLIENT_SECRET`
- `FFLOGS_TOKEN_URL` (defaultあり)
- `FFLOGS_GRAPHQL_URL` (defaultあり)
- `XIVAPI_BASE_URL` (defaultあり)
- `XIVAPI_LANG` (defaultあり)
- `STAGE_NAME` (default: `dev`)

任意:

- `ABILITY_SEED_IDS`
- `ABILITY_SYNC_SCHEDULE` (default: `rate(1 day)`)
- `ABILITY_SYNC_PAGE_LIMIT` (default: `500`)
- `ABILITY_SYNC_MAX_PAGES` (default: `200`)

## デプロイ

Amplify HostingのCIで `amplify.yml` を使用し、以下を実行します。

1. root install + TypeScript build
2. `amplify/dist` の生成 (`npm run amplify:prepare`)
3. `npx ampx pipeline-deploy ...`
4. Next.js build
