# yomi backend functions

Cloud Functions 用リポジトリ（Flutter アプリ `yomi` と別管理）。**ブランチ運用はアプリと揃える**ことを推奨します。

## ブランチ・デプロイ運用（yomi と同様）

```
main        本番リリース済み
stg         ステージング（Firebase yomi-stg へ載せるライン）
dev         日々の実装を積むライン
feature/*   任意
```

1. **`dev`** に小さくコミット・マージして進める。  
2. ステージングに出すとき **`dev` → `stg`** にマージ（まとめてでよい）。  
3. **`stg` ブランチをチェックアウトした状態**で `firebase deploy --only functions --project yomi-stg`（シークレット・Invoker は `RUNBOOK.md`）。  
4. 本番は **`stg` → `main`** の後、`--project yomi-prod` でデプロイ。

アプリ側の同じ方針は `yomi` リポジトリの README「ブランチ戦略」「Git / デプロイ運用（dev → stg）」を参照。

初回だけ `main` から `dev` / `stg` を作成して push する手順は、上記 `yomi` README の「ブランチの初期作成（初回のみ）」をそのまま使える（リポジトリ名だけ読み替え）。

## Git の作者（このリポジトリ）

コミット作者は GitHub の noreply を使います（ローカルで未設定なら次を実行）。

```bash
git config user.name "hawk-takaki-takemura"
git config user.email "hawk-takaki-takemura@users.noreply.github.com"
```

## Setup

1. Install dependencies.
   - `npm install`
2. Login and select Firebase project.
   - `firebase use <project-id>`
3. Set Anthropic API key as Functions secret.
   - `firebase functions:secrets:set ANTHROPIC_API_KEY`

## Local development

- `npm run build`
- `npm run serve`

## Deploy

初回、または `firestore.indexes.json` を変更したあとに **Firestore 複合インデックス**を先にデプロイし、コンソールで **Enabled** になるまで待ってから Functions をデプロイすることを推奨します（インデックス構築中は `scheduledEnrichTick` のクエリが失敗します）。

```bash
npm run build
firebase deploy --only firestore:indexes --project <project-id>
firebase deploy --only functions --project <project-id>
```

通常は `npm run deploy`（`package.json` では `firebase deploy --only functions`）でよいですが、上記インデックス手順は初回 Enrich ロールアウト時に必須です。

## Functions

| 種別 | 名前 | 説明 |
|------|------|------|
| Callable | `translateStories` | タイトル一括翻訳 + `translations/{lang}/stories/{id}` キャッシュ（App Check） |
| Scheduled | `scheduledIngestTick` | HN `topstories` / `newstories` → `hn_items` を merge、要約用に `enrich_queue` へ投入（毎日 04:00 `Asia/Tokyo`） |
| Scheduled | `scheduledEnrichTick` | `enrich_queue` を消化。本文取得または HN `text` を入力に Claude で要約 JSON を生成し `hn_items.enrichment` へ保存。成功時は `title_ja` を `translations/ja/stories/{id}` にも merge（15 分ごと `Asia/Tokyo`） |

**シークレット:** いずれも `ANTHROPIC_API_KEY` を使用（Enrich は記事要約・日本語タイトル生成に利用）。

**主な Firestore:**

- `hn_items` — ストーリー正本（`identity_fingerprint`、`enrich_status`、`enrichment` など）
- `enrich_queue` — 要約ジョブ（`status`、`queued_at` など）
- `translations/ja/stories/{storyId}` — Callable キャッシュ（Enrich 成功時に AI 生成 `title_ja` で上書きされうる）

本番・ステージングの手順・確認項目は `RUNBOOK.md` を参照してください。

## Callable API

- Function name: `translateStories`
- Input:
  - `stories`: `Record<string, string>` (required)
  - `lang`: `string` (optional, default `ja`)
- Output:
  - `translations`: `Record<string, string>`
  - `cachedCount`: `number`
  - `translatedCount`: `number`
