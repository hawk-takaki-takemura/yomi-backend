# Translation backend rollout

ブランチ運用は README の「ブランチ・デプロイ運用」に従い、**`dev` で細かく積み、`stg` にマージしてから**ステージングデプロイする想定です。

## Phase 1: staging deploy

1. Select staging Firebase project.
   - `firebase use <stg-project-id>`
2. Ensure Anthropic secret is configured.
   - `firebase functions:secrets:set ANTHROPIC_API_KEY`
3. Deploy function.
   - `npm run deploy`

## Phase 2: app staging verification

1. Build app with staging entrypoint.
2. Verify translation request succeeds via callable `translateStories`.
3. Verify fallback behavior:
   - if function returns error, app should continue showing original title.
4. Verify cache behavior:
   - first request should call Claude,
   - repeated request within 24 hours should be returned from Firestore cache.

## Phase 3: production deploy

1. Select production Firebase project.
2. Set `ANTHROPIC_API_KEY` secret for production.
3. Deploy same function artifact to production.

## Monitoring checklist

- Function success rate
- P95 latency
- `cachedCount` / `translatedCount` ratio
- Claude API failure count

## Rollback

- Disable translation feature flag on client if needed.
- Re-deploy previous function version if regression is confirmed.
