# yomi translation backend runbook

## Scope

Functions のローカル開発は **Node.js 22**（`.nvmrc` 参照）を前提とします。デプロイ前に `npm ci && npm run build && npm run lint` を通してください。

This runbook covers production rollout and rollback for translation backend using:

- Firebase Functions (`translateStories`)
- Cloud Run IAM (`roles/run.invoker` for `allUsers`)
- App Check enforcement
- Remote Config switch (`translation_backend`)

Region baseline: `asia-northeast1`

---

## 1. Preconditions

- `translateStories` is deployed from this directory.
- Function source uses `defineSecret("ANTHROPIC_API_KEY")`.
- Function config includes `enforceAppCheck: true`.
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

---

## 3. Deploy function (prod)

```bash
cd /Users/takaki/Projects/yomi-backend/functions
npm run build
firebase deploy --only functions --project yomi-prod
```

Success criteria:

- `functions[translateStories(asia-northeast1)] Successful update operation`
- `Deploy complete!`

---

## 4. Cloud Run invoker policy (prod)

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

## 4b. Staging mirror (yomi-stg)

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

## 4c. Cloud Build permission failures

If deploy fails with:

> missing permission on the build service account

Open the Cloud Build log URL printed by Firebase CLI, then grant the missing
roles to the project's default compute service account
(`PROJECT_NUMBER-compute@developer.gserviceaccount.com`) via Cloud Build
settings UI (same approach as staging).

Reference:
https://cloud.google.com/functions/docs/troubleshooting#build-service-account

---

## 5. App Check (prod)

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

## 6. Remote Config rollout (prod app repo)

From app repository (`/Users/takaki/Projects/yomi`):

```bash
make deploy-config-prod
```

Expected parameters:

- `translation_backend = remote`
- `translation_enabled = true`

---

## 7. Production verification

Run prod flavor app and verify:

- no `[firebase_functions/permission-denied]`
- translation returns expected localized titles
- function logs show translation requests
- fallback behavior remains safe on temporary backend failure

Useful logs:

```bash
firebase functions:log --project yomi-prod --only translateStories -n 100
```

---

## 8. Immediate rollback

Use Remote Config for instant mitigation:

- set `translation_backend = local` (skip remote translation, show original)
- if needed, set `translation_enabled = false`

Then deploy config:

```bash
cd /Users/takaki/Projects/yomi
make deploy-config-prod
```

---

## 9. Post-release follow-up

- rotate `ANTHROPIC_API_KEY` regularly
- monitor error rate / latency / translation volume
- keep Functions runtime aligned with Firebase supported Node releases (`firebase.json` の `runtime` と `package.json` の `engines.node`)

---

## 10. Backlog (tracked tasks)

- App Check: stg/prod で debug トークンを運用管理（アプリ README の手順に従う）。
- 依存の定期更新（`firebase-functions` / `firebase-admin` のメジャー追随は互換確認のうえで実施）。
