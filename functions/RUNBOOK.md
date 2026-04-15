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

## 11. Backlog (tracked tasks)

- App Check: stg/prod で debug トークンを運用管理（アプリ README の手順に従う）。
- 依存の定期更新（`firebase-functions` / `firebase-admin` のメジャー追随は互換確認のうえで実施）。
