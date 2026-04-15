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

- `npm run deploy`

## Functions

- **Callable:** `translateStories` — タイトル翻訳 + Firestore キャッシュ（既存どおり）
- **Scheduled:** `scheduledIngestTick` — HN 取り込み用のプレースホルダー（現状はログのみ）

## Callable API

- Function name: `translateStories`
- Input:
  - `stories`: `Record<string, string>` (required)
  - `lang`: `string` (optional, default `ja`)
- Output:
  - `translations`: `Record<string, string>`
  - `cachedCount`: `number`
  - `translatedCount`: `number`
