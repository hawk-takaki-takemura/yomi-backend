# yomi translation backend runbook

## Scope

Functions のローカル開発は **Node.js 22**（`.nvmrc` 参照）を前提とします。デプロイ前に `npm ci && npm run build && npm run lint` を通してください。

This runbook covers production rollout and rollback for translation backend using:

- Firebase Functions (`translateStories`, `scheduledIngestTick`, `scheduledEnrichTick`)
- Firestore composite indexes (`enrich_queue` queries)
- Cloud Run IAM (`roles/run.invoker` for `allUsers`) — **Callable のみ**
- App Check enforcement (Callable)
- Remote Config switch (`translation_backend`)

Region baseline: `asia-northeast1`

---

## 1. Preconditions

- Functions are deployed from this directory (`functions/`).
- Function source uses `defineSecret("ANTHROPIC_API_KEY")` (Callable + scheduled enrich).
- `translateStories` config includes `enforceAppCheck: true` (scheduled functions do not use App Check).
- Firestore location is `asia-northeast1` (same as Functions region).
- Flutter app already supports:
  - `translation_backend = remote | local`
  - `translation_enabled = true | false`

---

## 2. Configure secret (prod)

```bash
cd /Users/takaki/Projects/yomi-backend/functions
firebase functions:secrets:set ANTHROPIC_API_KEY --project yomi-prod
```

Scheduled enrich (`scheduledEnrichTick`) reads this secret at runtime. After rotating the key, redeploy functions so new instances pick up the updated secret binding if needed.

---

## 3. Firestore indexes (prod / stg)

`scheduledEnrichTick` queries `enrich_queue` with:

- `status` + `queued_at` (pending jobs)
- `status` + `processing_started_at` (stale processing recovery)

Definitions live in `firestore.indexes.json`. **Deploy indexes before or with the first enrich rollout**, then wait until indexes show as **Enabled** in Firebase Console (Firestore → Indexes). Queries fail while indexes are building.

```bash
cd /Users/takaki/Projects/yomi-backend/functions
firebase deploy --only firestore:indexes --project yomi-prod
```

Repeat for `yomi-stg` as needed:

```bash
firebase deploy --only firestore:indexes --project yomi-stg
```

If the CLI requires a `firestore.rules` file for your project layout, add or link rules per your security model; this repo’s `firebase.json` currently references **indexes only**.

---

## 4. Deploy functions (prod)

```bash
cd /Users/takaki/Projects/yomi-backend/functions
npm run build
firebase deploy --only functions --project yomi-prod
```

Success criteria (examples):

- `functions[translateStories(asia-northeast1)] Successful update operation`
- `functions[scheduledIngestTick(asia-northeast1)] Successful update operation`
- `functions[scheduledEnrichTick(asia-northeast1)] Successful update operation`
- `Deploy complete!`

---

## 5. Cloud Run invoker policy (prod)

List service name first:

```bash
gcloud run services list --region=asia-northeast1 --project=yomi-prod
```

Grant unauthenticated invoke (required for callable entry on 2nd gen):

```bash
gcloud run services add-iam-policy-binding translatestories \
  --region=asia-northeast1 \
  --project=yomi-prod \
  --member="allUsers" \
  --role="roles/run.invoker"
```

If service name differs, replace `translatestories`.

### Why this is required

2nd gen Callable functions are backed by Cloud Run. If `allUsers` does not have
`roles/run.invoker`, Cloud Run rejects requests as unauthenticated and the
Flutter client surfaces this as `[firebase_functions/permission-denied]`.

### Console alternative (no gcloud)

GCP Console -> Cloud Run -> select `translatestories` in `asia-northeast1` ->
Permissions -> add `allUsers` with role `Cloud Run Invoker`.

---

## 5b. Staging mirror (yomi-stg)

Repeat the same steps for staging before prod validation:

```bash
gcloud run services list --region=asia-northeast1 --project=yomi-stg

gcloud run services add-iam-policy-binding translatestories \
  --region=asia-northeast1 \
  --project=yomi-stg \
  --member="allUsers" \
  --role="roles/run.invoker"
```

---

## 5c. Cloud Build permission failures

If deploy fails with:

> missing permission on the build service account

Open the Cloud Build log URL printed by Firebase CLI, then grant the missing
roles to the project's default compute service account
(`PROJECT_NUMBER-compute@developer.gserviceaccount.com`) via Cloud Build
settings UI (same approach as staging).

Reference:
https://cloud.google.com/functions/docs/troubleshooting#build-service-account

---

## 6. App Check (prod)

Firebase Console (`yomi-prod`) -> App Check:

- iOS app: configure `App Attest` (or `DeviceCheck` if required).
- Android app: configure `Play Integrity`.
- Enable App Check enforcement for Cloud Functions once app registration is complete.

Note: Android の debug ビルドでは App Check の **debug provider** を使うため、開発用に **debug トークン** を Firebase Console（`yomi-stg` / `yomi-prod`）へ登録する。運用方針はアプリ側 README の「App Check（Android）」を参照。

### Pre-release checklist (stg + prod)

- 不要になった debug トークンを棚卸しして削除する。
- Play Integrity / App Attest など本番向けプロバイダが有効であることを確認する。
- Callable のスモークテストを実施する。

---

## 7. Remote Config rollout (prod app repo)

From app repository (`/Users/takaki/Projects/yomi`):

```bash
make deploy-config-prod
```

Expected parameters:

- `translation_backend = remote`
- `translation_enabled = true`

---

## 8. Production verification

Run prod flavor app and verify:

- no `[firebase_functions/permission-denied]`
- translation returns expected localized titles
- function logs show translation requests
- fallback behavior remains safe on temporary backend failure

Useful logs:

```bash
firebase functions:log --project yomi-prod --only translateStories -n 100
```

### 8b. Scheduled ingest + enrich (stg / prod)

**Cloud Scheduler:** After deploy, confirm jobs exist (GCP Console → Cloud Scheduler or Firebase Console → Functions). Region should match `asia-northeast1`.

| Function | Schedule (time zone) | Role |
|----------|----------------------|------|
| `scheduledIngestTick` | Every day 04:00 `Asia/Tokyo` | Fetch HN lists → `hn_items`, enqueue `enrich_queue` |
| `scheduledEnrichTick` | Every 15 minutes `Asia/Tokyo` | Drain queue → fetch body / HN text → Claude → `hn_items.enrichment`, optional `translations/ja/stories/{id}` |

**Invoker:** Scheduled functions are invoked by Cloud Scheduler; **do not** require `allUsers` Cloud Run Invoker (unlike `translateStories`).

**Useful logs:**

```bash
firebase functions:log --project yomi-prod --only scheduledIngestTick -n 80
firebase functions:log --project yomi-prod --only scheduledEnrichTick -n 80
```

**What to verify:**

- Ingest: log `scheduledIngestTick.done` with `written`, `enrichQueued`, `enrichDeadLetterSkipped`.
- Enrich: log `scheduledEnrichTick.done` with `processedAttempts`, `staleRecovered`; errors on `enrich.claudeOrParseFailed` / `enrich.normalizeFailed`.
- Firestore: `hn_items` docs gain `enrichment` and `enrich_status: completed` for processed stories; `enrich_queue` docs move to `completed` or `failed`.

**Operational notes:**

- **Dead letter:** Ingest skips re-queue when `enrich_failure_count` exceeds the configured max for the same identity + pipeline version (see `ENRICH_MAX_FAILURES` in source).
- **Stuck `processing`:** Enrich worker resets stale `processing` jobs after `ENRICH_STALE_PROCESSING_MS` and reconciles queue vs `hn_items` state.
- **403 on fetch:** Some sites block simple HTTP fetch; monitor `enrich.fetchArticle.httpError` and consider domain-specific fetch later (not in scope for v1).

---

## 9. Immediate rollback

Use Remote Config for instant mitigation:

- set `translation_backend = local` (skip remote translation, show original)
- if needed, set `translation_enabled = false`

Then deploy config:

```bash
cd /Users/takaki/Projects/yomi
make deploy-config-prod
```

---

## 10. Post-release follow-up

- rotate `ANTHROPIC_API_KEY` regularly
- monitor error rate / latency / translation volume **and** enrich queue depth / Claude failures / `enrichDeadLetterSkipped`
- keep Functions runtime aligned with Firebase supported Node releases (`firebase.json` の `runtime` と `package.json` の `engines.node`)

---

## B-2 title_ja 優先ルール（確定 2026-04-16）

### 背景

`hn_items/{id}.enrichment.title_ja`（enrich パイプライン出力）と
`translations/ja/stories/{id}`（Callable `translateStories` のキャッシュ）の
2 経路に日本語タイトルが存在し得るため、UI が参照すべき正を決定する。

### 確定ルール

| 優先順位 | 条件 | 使用する値 |
|----------|------|------------|
| 1 | `enrich_status == 'completed'` かつ `enrichment.title_ja` が非空 | `enrichment.title_ja` |
| 2 | `translatedTitle` あり（Callable 結果） | `translatedTitle` |
| 3 | どちらもなし | HN 原文 `title` |

### 判断理由

- enrichment は本文コンテキスト込みの Claude パイプライン出力であり、短い英語タイトルのみを翻訳する Callable より意味的精度が高い。
- 鮮度競合（両方ある場合）でも enrichment を優先する。
- enrich 未完了・失敗中は Callable のみ（現状の挙動を維持）。

### Flutter 実装

`lib/features/feed/domain/entities/story.dart` の `displayTitle` getter を参照。

### 将来の変更条件

B-4（翻訳品質改善）でプロンプトを変更する場合は本節も合わせて更新する。
Callable 側で `translations/ja` に `title_ja` が既存の場合にスキップする最適化は、B-4 と同時に検討する。

---

## B-1 運用の見える化（2026-04-16）

### 監視方針

個人開発のため「週1手動確認 + 閾値超過時メールアラート1通」を基本とする。
重いダッシュボードは Phase 2 以降に検討する。

### 週次確認コマンド（所要5分）

#### 1. enrich キュー滞留確認

```bash
# pending / processing 件数（30件超なら要注意、50件超×1時間以上で異常）
firebase firestore:query hn_items \
  --project yomi-prod \
  --where "enrich_status,in,pending,processing" \
  --format json | jq length
```

#### 2. DeadLetter（失敗3回以上）確認

```bash
# 1件以上あれば原因調査
firebase firestore:query hn_items \
  --project yomi-prod \
  --where "enrich_failure_count,>=,3" \
  --format json | jq '.[].id'
```

#### 3. Claude エラー率確認（Cloud Logging）

```bash
# 直近24時間の enrich エラーログ
gcloud logging read \
  'resource.type="cloud_function"
   resource.labels.function_name="scheduledEnrichTick"
   severity>=ERROR' \
  --project yomi-prod \
  --freshness=24h \
  --limit=20
```

#### 4. 直近 ingest 件数確認

```bash
# 最後の scheduledIngestTick の written 件数
gcloud logging read \
  'resource.type="cloud_function"
   resource.labels.function_name="scheduledIngestTick"
   jsonPayload.written>0' \
  --project yomi-prod \
  --freshness=25h \
  --limit=5
```

### Cloud Monitoring アラート設定（初回のみ）

**所要目安: 約5分。** プロジェクトは **`yomi-prod`** を選択した状態で進める。

通知チャンネルが未作成なら先に **Alerting → Notification channels → Add channel → Email** で自分宛を登録する。

GCP Console → **Monitoring** → **Alerting** → **Create policy**。

#### アラート①: `scheduledEnrichTick` エラー検知

1. **Select a metric**
   - **Resource type:** `Cloud Run Revision`（2nd Gen Functions は Cloud Run として計測されることが多い）
   - **Metric:** `request_count`
   - **Filter:** `response_code_class != 2xx`
   - メトリクスが出ない・合わない場合は次を試す:
     - **Resource type:** `Cloud Function`
     - **Metric:** `cloudfunctions.googleapis.com/function/execution_count`（表示名は **execution_count** のことが多い）
     - **Filter:** `status != "ok"`
2. **Configure alert trigger**
   - **Condition type:** Threshold
   - **Threshold value:** `1`（1回でも失敗を拾う）
   - **Rolling window:** `60 minutes`
3. **Notifications** → 先に登録したメールチャンネルを追加
4. **Alert name:** `yomi-prod enrich error`

#### アラート②: `scheduledIngestTick` 実行なし（停止検知）

同様に **Create policy**。

1. **Select a metric**
   - **Resource type:** `Cloud Function`
   - **Metric:** `execution_count`
   - **Filter:** `function_name = "scheduledIngestTick"`
2. **Configure alert trigger**
   - **Condition type:** Absence（データなし検知）
   - **Duration:** `25 hours`
3. **Notifications** → 同じメールチャンネル
4. **Alert name:** `yomi-prod ingest stopped`

#### つまずきやすいポイント

| 症状 | 対処 |
|------|------|
| メトリクスが候補に出ない | 上部のプロジェクトが **`yomi-prod`** か確認する。関数が直近デプロイ済みか確認する。 |
| Cloud Run と Cloud Function のどちらか迷う | 2nd Gen は **Cloud Run Revision** に寄る。①はまず Cloud Run、ダメなら Cloud Function の `execution_count` + `status != "ok"`。 |
| Notification channel がない | **Alerting** → **Notification channels** → **Add channel** → **Email** で先に作成する。 |

### 閾値サマリ

| 指標 | 正常 | 要注意 | 異常（アラート） |
|------|------|--------|------------------|
| enrich pending/processing | ≤ 30件 | 31〜50件 | > 50件 × 1時間 |
| enrich_failure_count ≥ 3 | 0件 | — | 1件以上 |
| Claude / enrich 失敗（週次ログ確認の目安） | < 5% | 5〜10% | > 10% |
| ingest 実行なし | 毎日1回 | — | 25時間以上なし（Monitoring ②） |
| Monitoring ①（enrich） | — | — | 60分窓で非2xx または `status != ok` が閾値1回以上 |

### stg との使い分け

- 上記コマンドは `--project yomi-prod` で運用
- stg は手動デプロイ前の動作確認のみ（常時監視不要）

---

## B-3 Enrich チューニング

### 2026-04-16 第1軸: `ENRICH_JOBS_PER_TICK` 4 → 8

**診断根拠**

- `scheduledEnrichTick.done` の `pendingCandidates` が毎 Tick 上限（4）に張り付いていた
- `processedAttempts` も毎回 4、`staleRecovered` は 0（stale 起因の詰まりではない）

**変更**

- `functions/src/config.ts`: `ENRICH_JOBS_PER_TICK = 8`

**デプロイ**

- stg で smoke のあと prod へデプロイする

**観測期間**

- 目安 3〜5日（`gcloud logging read` 等で `scheduledEnrichTick.done` を継続確認）

**観測指標**

- `pendingCandidates` が 8 未満の Tick が混ざれば改善のサイン
- まだ毎回 8 で頭打ちなら次の軸（さらに増やす、または ingest 頻度・件数）を検討
- B-1 の enrich エラーアラートが増えたら **8 → 6** など一段戻して原因を切り分ける

**メモ**

- `recoverStaleProcessing` の `.limit(30)` は据え置き。`ENRICH_JOBS_PER_TICK` をさらに大きくし、`processing` の滞留が 30 を超えそうなら別軸で検討する
- 1 Tick 内のジョブ処理は直列のため、遅い記事が続くと `timeoutSeconds`（540）に近づく可能性がある。その場合は並列化などが次テーマになる

---

## 11. Backlog (tracked tasks)

- App Check: stg/prod で debug トークンを運用管理（アプリ README の手順に従う）。
- 依存の定期更新（`firebase-functions` / `firebase-admin` のメジャー追随は互換確認のうえで実施）。

### 非機能要件（コメント翻訳・体験）

- **有料フラグ**: Firestore `users/{uid}` に `isPremium: true` を置くと Callable がコメント BFS 上限 **50 件・深さ 5** を適用（無料・匿名は **15 件・深さ 2**）。書き込みはクライアント禁止（RevenueCat Webhook / 手動運用などで Admin 更新を想定）。ルールは本人 read のみ許可。
- **`translateHnComments` の App Check**: 現状は `yomi-prod` のみ `enforceAppCheck: true`。リリース時に Android SHA 登録・Play Integrity を揃えたうえで、stg も含めて方針を統一するか検討する。
- **レイテンシ**: 初回は HN 取得 + 未キャッシュ分の Claude 翻訳のため遅くなりやすい。`translateHnComments` は BFS をウェーブ単位で HN item を並列取得し、コメント本文の二重フェッチを避ける（それでも未キャッシュ翻訳は Claude 往復が支配的になり得る）。追加対策候補はフィード上の先読み、段階表示（原文先出し）、Firestore バッチ read など。
- **コスト・鮮度**: キュー投入時に全コメントを先翻訳する方式は、無駄翻訳とコメント増加による陳腐化に注意。採用するなら対象絞り（要約済み・高 `descendants` など）を前提に設計する。

### 翻訳・温めの優先度（S / A / B）

**分類に使う信号（実装時の定義）**

- **`topstories` 上位 N**: `GET /v0/topstories.json` の配列先頭からの **0-based インデックス**で判定するか、ingest 時に `hn_items` へ **`topstories_rank`**（または当時の順位スナップショット）を書いておく。
- **`descendants` 閾値**: HN item の `descendants`（無ければ 0）。
- **enrich 済み**: `hn_items.enrich_status == "completed"`（現行の enrich キュー完了）。
- **当日バズ（任意ブースター）**: 例として **同一 UTC 日**で `score` の増分が **+40 以上**、または **直近 6 時間で +30 以上**など。実装では `hn_items` に **`score_last_seen` / `score_observed_at`** を持ち差分を計算する。

**Tier 判定（初期パラメータ・ログで後調整）**

| Tier | 条件 |
| :--- | :--- |
| **S** | **enrich 済み** かつ（（**`topstories` 順位 ≤ 30** かつ **`descendants` ≥ 80**）**または** **当日バズ**が成立） |
| **A** | **enrich 済み** かつ **`topstories` 順位 ≤ 100** かつ **`descendants` ≥ 15** かつ **S に該当しない** |
| **B** | 上記以外（enrich 未完了を含む） |

**Tier ごとの自動化（タイトル / 要約 / コメント / 閲覧時）**

| Tier | タイトル（ユーザーに見せるもの） | 要約（enrich） | コメント温め（バックグラウンド） | 閲覧時 `translateHnComments` |
| :--- | :--- | :--- | :--- | :--- |
| **S** | **最安 LLM で下書き**（内部のみ・非表示）→ **Haiku（仕上げ）**で確定後にだけ `translations/ja/stories` 等へ反映しアプリは **仕上げのみ表示**。仕上げ失敗時は **英語タイトルのまま**（下書きは出さない）。 | **現行の enrich（Haiku 1-pass）を維持**。将来「下書き→仕上げ」に拡張する場合は **S から段階導入**。 | **最安 LLM でコメント本文を最大 50 件まで下書き**（内部・非表示）→ **Haiku でそのうち先頭 BFS 順 20 件を仕上げ**て `translations/ja/comments/{id}` に保存。以降の増分は差分のみ。 | **差分翻訳が主**（キャッシュヒット率高）。未仕上げが残っていれば **仕上げキューに積む**か **同期で不足分のみ Haiku**。 |
| **A** | **enrich が既に書く `title_ja` を表示**（現状踏襲）。任意で **最安下書きのみ**内部保存可。仕上げ Haiku は **夜間バッチで `descendants`≥40 の A のみ**などに限定してもよい。 | **現行 enrich（Haiku 1-pass）のみ**。 | **最安 LLM で最大 20 件まで下書き**（内部・非表示）。**Haiku 仕上げは原則しない**（コスト抑制）。 | **オンデマンド中心**（初回は遅くなり得る）。温め済み下書きがある場合は **仕上げに回す素材**として利用可。 |
| **B** | **enrich / 既存のタイトル翻訳パス**に従う（未 enrich は英題のまま）。 | **enrich キュー通過時のみ**（現状）。 | **なし**。 | **現状どおりフルオンデマンド**（未キャッシュは遅くなり得る）。 |

**運用メモ**

- **ジョブ優先度**: 温め・仕上げバッチは **S → A → B** の順でキュー投入（同一リソース内）。
- **二段翻訳のコスト**: 下書き＋仕上げを **常にフル**すると合算コストが増えるため、**仕上げは S（＋必要なら当日バズ昇格）に寄せる**のが初期の安全策。
- **「未訳と訳済の混在」**: 下書きはユーザー非表示のまま **Firestore にだけ溜める**と、フィード上の見えは **仕上げ完了分だけ**に揃えやすい。
- **パラメータ**: `30 / 100 / 80 / 15 / 50 / 20` は初期値。**`scheduledEnrichTick` や ingest のメトリクス**と一緒に 2 週間単位で見直す。

**設計レビュー（インフラ・体験・懸念の反映方針）**

1. **「最安下書き → Haiku 仕上げ」の費用対効果**
   - **コンテキスト重複**: 仕上げプロンプトに **原文＋下書きの両方**を入れると入力トークンが膨らみ、**一発 Haiku より高くなるケース**がある。採用前に **同量テキストで「1段 vs 2段」のトークン単価シミュ**を必ず一度行う。
   - **下書きの別用途（推奨案）**: 下書きを「表示用翻訳」ではなく **S 昇格のゲート／低品質・スパム的本文のフィルタ**に使うなら、最安 LLM の価値が明確で、**翻訳二段とコスト構造を分離**できる。
   - **仕上げ入力の最小化案**: 仕上げは **下書きのみ＋用語リスト**（原文は短い差分だけ）などに寄せると入力を抑えられる。効果はドメイン依存のため要検証。

2. **コメント温めと階層**
   - **BFS の妥当性**: トップレベル付近の多様な意見を先に拾う用途には BFS が合う、という前提は維持。
   - **`descendants` 増分トリガー**: S ランクではコメント増加が速いため、**前回温め時点からの増分**で「**新しく付いたストーリ直下の `kids`（トップレベル）**」を優先的に温めると、**最新議論の日本語化**に寄せられる。実装時は `hn_items` に **`last_comment_warm_descendants` / `last_comment_warm_at`** 等を持ち、差分のみ処理する。

3. **テックリード層の「納得感」**
   - **原文トグル**: コメント・タイトルは **常に原文を保持し UI で切替**（ホバーはモバイルで難しいため **長押し／トグル**を主）。既存の詳細 UI の延長で要件化する。
   - **用語の英語併記**: `enrich` およびコメント翻訳の system / user で **「重要技術用語は `日本語訳 (English)`」** 形式を指定し、信頼性と逆引き性を上げる（B-4 でプロンプト具体化）。

4. **Firestore Read 最適化**
   - **現状**: `translations/.../comments/{commentId}` は **1 コメント 1 Read** が乗りやすい。
   - **短期**: Callable 側で **`getAll`** 等のバッチ取得に寄せて往復と課金単位を整理する（設計は維持）。
   - **中期案**: ストーリー単位で **コメント翻訳を JSON チャンク**（例: 20 件ぶんを 1 doc）にまとめると Read は下がるが、**部分更新・TTL・競合**の複雑さが増える。S 温めのコスト試算後に判断。

5. **運用メトリクス（パラメータ調整用）**
   - **Haiku 仕上げ**: 成功率 / 失敗率 / タイムアウト（S 限定で `translateHnComments` または専用ワーカー）。
   - **キャッシュヒット率**: 閲覧時に **温め済み（仕上げ済み）**だった割合。低いなら **S 条件緩和**、**先読み**、**温め頻度**のどれを上げるかをデータで決める。
   - **二段翻訳の実コスト**: 1 記事あたり **下書きトークン＋仕上げトークン**の合算（S のみでも可）。

6. **ロングテール（人気薄）＝最安モデル／有料のみ「再翻訳（高品質）」**
   - **デフォルト**: 人気が薄い記事（Tier B 相当、または閾値未満）のコメント翻訳は **最安 LLM で一発**し、`translations/...` に **`translation_tier: "budget"`**（命名例）と **`source_model`** を保存。無料ユーザもまずはこれで読める。
   - **有料のみ**: 詳細画面に **「高品質で再翻訳」**（文言はプロダクトで調整）。Callable に **`retranslatePremium: true`** 等を渡し、**`users/{uid}.isPremium` 検証後のみ** Haiku（または現行の高品質パス）で **同一コメントを上書き**し、`translation_tier: "premium"` に更新。無料にはボタン非表示または課金導線のみ。
   - **データ構造**: 同一 `commentId` に **フィールドで tier 併存**（`budget_text` / `premium_text`）にするか、**上書き＋ `upgraded_at`** にするかは実装時に決定（Read 単価と UI の「元に戻す」を天秤）。
   - **乱用対策**: **ストーリーあたり 1 日 N 回**・**ユーザーあたり週 M 回**などの上限。ログに **`retranslate_haiku` 回数 / 失敗**を残し、メトリクスと合わせて N・M を調整。

### B-4 とセット（翻訳品質・コメント体験）

**スレッド要約（詳細画面内）**

- **方針**: 記事要約の品質調整（B-4）と同じフェーズで扱う。プロンプト・入力範囲・誤訳の見せ方をまとめてチューニングする。
- **入力の現状**: `translateHnComments` / `analyzeHnCommentTrends` は BFS（`collectCommentsBreadthFirst`）。上限は **無料・匿名 15 件・深さ 2** / **プレミアム 50 件・深さ 5**（`config.ts` の `COMMENT_CALLABLE_*`。クライアントの `limit` はティア上限でクランプ。未指定ならティア既定）。スレッド要約の網羅感はこの取得戦略に直結する（スコア順トップ N ではない）。
- **実装案の整理**:
  - **推奨**: 新規 Callable（または既存 Callable の拡張）でサーバーから Claude 呼び出し。**API キーをクライアントに置かない**。
  - **最小コスト案（非推奨）**: 詳細で翻訳済みコメントを受け取ったあとクライアントから Anthropic API を直接叩く → キー流出リスクのため原則避ける。
- **やらない（現フェーズ）**: フィード TOP にコメント要約を常設する。enrich パイプラインへの追加になり工数・コストが大きい → **Phase 2 以降**で要件見直し。
