# FFLogs v2 GraphQL PoC (TypeScript/Node.js)

FFLogs v2 API を使って、fightID を手入力せずに対象 fight を自動決定し、以下を出力する PoC です。

- 敵(ボス)の行動タイムライン（casts）
- 各プレイヤーのスキル使用状況（時系列 + 集計）

## 1. セットアップ

```bash
npm install
cp .env.example .env
```

`.env` に FFLogs の OAuth 情報を設定します。

```dotenv
FFLOGS_CLIENT_ID=your_client_id
FFLOGS_CLIENT_SECRET=your_client_secret
FFLOGS_TOKEN_URL=https://www.fflogs.com/oauth/token
FFLOGS_GRAPHQL_URL=https://www.fflogs.com/api/v2/client
FFLOGS_LOCALE=ja
XIVAPI_BASE_URL=https://xivapi.com
XIVAPI_LANG=ja
XIVAPI_CACHE_PATH=./out/xivapi_ability_cache.json
ABILITY_OVERRIDES_PATH=./out/ability_overrides.json
```

### FFLogs での client_id / client_secret 取得概要

1. FFLogs にログイン
2. API Client を作成（Client Credentials）
3. `client_id` / `client_secret` を `.env` に設定

## 2. 実行方法

### report モード（推奨）

```bash
npm run dev -- --report <reportCode>
```

主要オプション:

- `--pick <best|lastKill|firstKill|longest|byBoss:<bossId>>`（default: `best`）
- `--only-kill <true|false>`（default: `true`）
- `--difficulty <number>`
- `--fight-id <number>`（デバッグ用 override）
- `--translate <true|false>`（default: `true`）
- `--locale <ja|en|...>`（default: `.env` の `FFLOGS_LOCALE`、未設定時 `ja`）
- `--xivapi-fallback <true|false>`（default: `true`）
- `--xivapi-lang <ja|en|...>`（default: `.env` の `XIVAPI_LANG`）
- `--xivapi-base-url <url>`（default: `.env` の `XIVAPI_BASE_URL`）
- `--xivapi-cache-path <path>`（default: `.env` の `XIVAPI_CACHE_PATH`）
- `--ability-overrides-path <path>`（default: `.env` の `ABILITY_OVERRIDES_PATH`）

例:

```bash
npm run dev -- --report abcDEF12 --pick byBoss:123 --difficulty 101
```

### rankings モード

```bash
npm run dev -- --rankings true --encounter-id <id> --metric <metric> --difficulty <difficulty>
```

主要オプション:

- `--page-size <N>`（default: `10`）
- `--rank-index <0..N-1>`（default: `0`）
- `--region <slug>` / `--server <slug>` / `--job <name>` / `--partition <number>`

例:

```bash
npm run dev -- --rankings true --encounter-id 123 --metric dps --difficulty 101 --page-size 10 --rank-index 0
```

## 3. ビルド / 実行

```bash
npm run build
npm run start -- --report <reportCode>
```

## 3.1 Next.js 可視化

1. Next.jsビューアを起動

```bash
npm --prefix web install
npm run web:dev
```

ブラウザで `http://localhost:3000` を開くと、Webから直接FFLogsへ問い合わせて以下を表示します。

- report fights 一覧の取得
- rankings 一覧の取得（`encounterId + metric + difficulty`）
- encounter名検索（ボス名から `Encounter ID` を検索）
- グループ選択（Zone -> Encounter）で `Encounter ID` を検索不要で選択
- 選択 fight の詳細解析（boss timeline / players casts / summary）
- 時間レンジ絞り込み（Start/End）
- プレイヤー列の表示/非表示
- ability名/ID検索（ヒット強調）
- Boss-only行表示
- 表示モード切替（Text / Icon / Both）

`rankings` モードを使う場合、`reportCode` の手入力は不要です。
ボス名検索→候補選択→`Encounter ID` セット→ランキング取得→解析、の順で進められます。

環境変数 `FFLOGS_OUT_DIR` を指定すると、`out` の参照先を変更できます。
アイコンはWeb側でXIVAPIを参照して取得します。未解決IDはテキスト表示にフォールバックします。

`NEXT_PUBLIC_API_BASE_URL` は必須です。
`NEXT_PUBLIC_USE_NEXT_API=true` の場合は Next.js の API Route (`/api/*`) を経由し、
`false` の場合は Lambda API を直接呼びます。

以下エンドポイントを使用します。

- `/report/fights`
- `/rankings/search`
- `/encounters/search`
- `/encounters/groups`
- `/ability-icons`
- `/report/analyze`

例:

```dotenv
NEXT_PUBLIC_API_BASE_URL=https://<api-id>.execute-api.<region>.amazonaws.com/dev
```

## 3.2 AWS IaC (SAM) でバックエンド作成

`infra/template.yaml` に以下を定義しています。

- API Gateway (HTTP API)
- Lambda (`api-handler`, `ability-sync-handler`)
- DynamoDB (`AbilityMaster`, `AnalysisCache`)
- EventBridge定期実行（ability同期オーケストレータ）
- CloudWatch Alarms（API/Lambda errors, sync duration）

手順:

```bash
# 1) Lambda用アーティファクトを準備（dist -> infra/dist）
npm run infra:prepare

# 2) 初回デプロイ
cd infra
sam build -t template.yaml
sam deploy --guided -t template.yaml
```

詳細は `infra/README.md` を参照してください。

## 3.3 AWS IaC (Amplify Gen2) へ移行

`amplify/backend.ts` に、SAM相当のリソースをCDKで定義しています。

- Lambda (`api-handler`, `ability-sync-handler`)
- DynamoDB (`AbilityMaster`, `AnalysisCache`)
- EventBridge schedule + DLQ
- API Gateway HTTP API
- CloudWatch alarms

Amplify Console で必要な環境変数を設定後、`amplify.yml` 経由でデプロイできます。
必須値は `amplify/README.md` を参照してください。

補足:

- 検証段階では SAM と Gen2 の共存は可能
- 運用時は二重管理を避けるためどちらかに統一推奨

## 4. 出力ファイル (`./out`)

- `fights.json`（report モード時: fights 一覧 + 選択理由）
- `rankings.json`（rankings モード時: 取得条件 + 結果）
- `selected_fight.json`（最終選択された fight のメタ情報）
- `boss_timeline.json`（敵タイムライン）
- `players_casts.json`（player ごとの cast 時系列）
- `players_summary.json`（player ごとのアビリティ集計）
- `xivapi_resolve_report.json`（XIVAPI補完の診断: 何件解決/失敗したか）
- `unresolved_abilities.json`（未解決abilityIdの出現回数）

標準出力には以下を表示します。

- selected fight 概要
- player summary 上位（casts 多い順）

## 5. 実装ポイント

- OAuth2 Client Credentials で token 取得
- GraphQL クライアントは `fetch` ベース
- 429 / 5xx は指数バックオフでリトライ
- `events(dataType: Casts)` を `nextPageTimestamp` で全件ページング
- `masterData.actors` で `actorID -> name/type` 解決
- `masterData.abilities` で `abilityGameID -> ability名` 解決
- 翻訳指定（`translate=true` + `Accept-Language`）を試行し、未対応スキーマでは自動フォールバック
- FFLogsで名称未解決のIDはXIVAPI (`Action`) をフォールバック参照して補完（ローカルキャッシュあり）
- ボス推定は PoC として「対象 fight 内で casts が最も多い敵 actor」

## 6. よくある失敗

- 認証失敗: `FFLOGS_CLIENT_ID/SECRET/TOKEN_URL` を確認
- GraphQL errors: 引数条件（encounter/metric/difficulty）や private logs を確認
- private logs: 公開範囲不足で report/rankings が null になる場合あり
- ページング: 大規模ログは複数ページになるため `nextPageTimestamp` を確認

未解決IDを手動補完したい場合は `ABILITY_OVERRIDES_PATH` に JSON を置いてください。

```json
{
  "45991": "（任意の日本語名）"
}
```

## 7. テスト

```bash
npm run test
```

- `test/pickFight.test.ts`
- `test/summary.test.ts`

## 8. 改善候補

1. ボス識別精度向上（encounter metadata, hostile flags, phase 連携）
2. casts 以外のイベント種別追加（damage, buffs/debuffs, interrupts）
3. レポート/actor キャッシュ導入（ローカルキャッシュ + TTL）
4. Next.js UI の追加（timeline 可視化、player 比較、絞り込み）
