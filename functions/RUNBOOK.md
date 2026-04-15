# yomi translation backend runbook

## Scope

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

Note: For debug validation only, temporary debug token registration is allowed, but remove before release.

### Pre-release checklist (stg + prod)

- Remove debug tokens that are no longer needed.
- Confirm production attestation providers are enabled (not debug).
- Smoke test Callable after switching off debug providers.

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
- upgrade runtime and dependencies before deprecation:
  - Node.js 20 -> supported newer runtime
  - `firebase-functions` -> latest compatible version

---

## 10. Backlog (tracked tasks)

- Finalize App Check for stg/prod (remove debug tokens before store release).
- Upgrade Node.js runtime for Functions (Node 20 deprecation timeline).
- Upgrade `firebase-functions` to latest compatible major (expect breaking changes).
