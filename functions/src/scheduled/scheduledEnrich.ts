import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import {onSchedule} from "firebase-functions/v2/scheduler";

import {completeClaudeWithSystem} from "../anthropic.js";
import {
  ANTHROPIC_API_KEY,
  CACHE_TTL_HOURS,
  CLAUDE_MODEL,
  ENRICH_FETCH_MAX_BYTES,
  ENRICH_MAX_PROMPT_CHARS,
  ENRICH_FETCH_TIMEOUT_MS,
  ENRICH_JOBS_PER_TICK,
  ENRICH_PIPELINE_VERSION,
  ENRICH_STALE_PROCESSING_MS,
} from "../config.js";
import {buildEnrichUserMessage} from "../enrich/buildEnrichUserMessage.js";
import {parseAndNormalizeEnrichmentV1} from "../enrich/enrichmentTypes.js";
import {extractJsonObject} from "../enrich/extractJsonObject.js";
import {fetchArticlePlainText} from "../enrich/fetchArticlePlainText.js";
import {htmlToPlainText} from "../enrich/htmlToPlainText.js";
import {ENRICH_QUEUE_COLLECTION, HN_ITEMS_COLLECTION} from "../firestoreCollections.js";
import {fetchItem} from "../hn/client.js";
import {isHnTextPost, isStoryHiddenByModeration} from "../hn/storyPolicy.js";
import type {HnItem} from "../hn/types.js";
import {ENRICH_V1_SYSTEM_PROMPT} from "../prompts/enrichV1System.js";
import {storyIdentityFingerprint} from "../util/fingerprint.js";

type ClaimResult =
  | {kind: "skip"}
  | {kind: "obsolete"}
  | {kind: "claimed"; identityFingerprint: string; pipelineVersion: number};

function truncateForPrompt(s: string): string {
  if (s.length <= ENRICH_MAX_PROMPT_CHARS) return s;
  return `${s.slice(0, ENRICH_MAX_PROMPT_CHARS)}\n\n[truncated]`;
}

async function recoverStaleProcessing(firestore: FirebaseFirestore.Firestore): Promise<number> {
  const threshold = admin.firestore.Timestamp.fromMillis(Date.now() - ENRICH_STALE_PROCESSING_MS);
  const snap = await firestore
    .collection(ENRICH_QUEUE_COLLECTION)
    .where("status", "==", "processing")
    .where("processing_started_at", "<", threshold)
    .limit(30)
    .get();

  let n = 0;
  for (const doc of snap.docs) {
    const storyId = doc.data().story_id as number | undefined;
    if (storyId === undefined) continue;
    const hnRef = firestore.collection(HN_ITEMS_COLLECTION).doc(String(storyId));
    const hnSnap = await hnRef.get();
    const hn = hnSnap.data() as {enrich_status?: string} | undefined;
    const batch = firestore.batch();

    if (hn?.enrich_status === "completed") {
      batch.set(
        doc.ref,
        {
          status: "completed",
          completed_at: admin.firestore.FieldValue.serverTimestamp(),
          completed_reason: "reconcile_hn_completed",
          processing_started_at: admin.firestore.FieldValue.delete(),
        },
        {merge: true},
      );
    } else if (hn?.enrich_status === "processing") {
      batch.set(
        doc.ref,
        {
          status: "pending",
          processing_started_at: admin.firestore.FieldValue.delete(),
          stale_recovered_at: admin.firestore.FieldValue.serverTimestamp(),
        },
        {merge: true},
      );
      batch.set(
        hnRef,
        {
          enrich_status: "pending",
          enrich_processing_started_at: admin.firestore.FieldValue.delete(),
        },
        {merge: true},
      );
    } else if (hn?.enrich_status === "failed") {
      batch.set(
        doc.ref,
        {
          status: "failed",
          processing_started_at: admin.firestore.FieldValue.delete(),
          stale_recovered_at: admin.firestore.FieldValue.serverTimestamp(),
          last_worker_error: "stale_processing_reconcile",
        },
        {merge: true},
      );
    } else {
      batch.set(
        doc.ref,
        {
          status: "pending",
          processing_started_at: admin.firestore.FieldValue.delete(),
          stale_recovered_at: admin.firestore.FieldValue.serverTimestamp(),
        },
        {merge: true},
      );
    }
    await batch.commit();
    n++;
  }
  return n;
}

async function tryClaimJob(
  firestore: FirebaseFirestore.Firestore,
  storyId: number,
): Promise<ClaimResult> {
  const queueRef = firestore.collection(ENRICH_QUEUE_COLLECTION).doc(String(storyId));
  const hnRef = firestore.collection(HN_ITEMS_COLLECTION).doc(String(storyId));

  let result: ClaimResult = {kind: "skip"};
  await firestore.runTransaction(async (tx) => {
    const qSnap = await tx.get(queueRef);
    if (!qSnap.exists) {
      result = {kind: "skip"};
      return;
    }
    const q = qSnap.data() as {
      status?: string;
      identity_fingerprint?: string;
      pipeline_version?: number;
    };
    if (q.status !== "pending") {
      result = {kind: "skip"};
      return;
    }

    const hnSnap = await tx.get(hnRef);
    if (!hnSnap.exists) {
      result = {kind: "skip"};
      return;
    }
    const hn = hnSnap.data() as {
      enrich_status?: string;
      identity_fingerprint?: string;
    };

    if (hn.enrich_status !== "pending") {
      result = {kind: "skip"};
      return;
    }

    if (
      typeof q.identity_fingerprint === "string" &&
      typeof hn.identity_fingerprint === "string" &&
      q.identity_fingerprint !== hn.identity_fingerprint
    ) {
      tx.set(
        queueRef,
        {
          status: "completed",
          completed_at: admin.firestore.FieldValue.serverTimestamp(),
          completed_reason: "identity_mismatch",
          processing_started_at: admin.firestore.FieldValue.delete(),
        },
        {merge: true},
      );
      tx.set(hnRef, {enrich_status: "idle"}, {merge: true});
      result = {kind: "obsolete"};
      return;
    }

    if (
      typeof q.pipeline_version === "number" &&
      q.pipeline_version !== ENRICH_PIPELINE_VERSION
    ) {
      tx.set(
        queueRef,
        {
          status: "completed",
          completed_at: admin.firestore.FieldValue.serverTimestamp(),
          completed_reason: "pipeline_mismatch",
          processing_started_at: admin.firestore.FieldValue.delete(),
        },
        {merge: true},
      );
      tx.set(hnRef, {enrich_status: "idle"}, {merge: true});
      result = {kind: "obsolete"};
      return;
    }

    tx.set(
      hnRef,
      {
        enrich_status: "processing",
        enrich_processing_started_at: admin.firestore.FieldValue.serverTimestamp(),
      },
      {merge: true},
    );
    tx.set(
      queueRef,
      {
        status: "processing",
        processing_started_at: admin.firestore.FieldValue.serverTimestamp(),
      },
      {merge: true},
    );

    result = {
      kind: "claimed",
      identityFingerprint: q.identity_fingerprint ?? "",
      pipelineVersion: q.pipeline_version ?? ENRICH_PIPELINE_VERSION,
    };
  });

  return result;
}

function fallbackEnrichmentUnavailable(): ReturnType<typeof parseAndNormalizeEnrichmentV1> {
  return parseAndNormalizeEnrichmentV1({
    schema_version: 1,
    title_ja: "",
    summary_short: "参照元が利用できないため要約できません。",
    summary_points: ["モデレーションまたは削除により参照できません", "要約対象外です"],
    tags: ["Others"],
    hot_topic_score: 0,
    confidence_score: 0,
  });
}

async function buildContentStrings(item: HnItem): Promise<{hnText: string; extractedText: string}> {
  const hnHtml = (item.text ?? "").trim();
  const hnText = hnHtml ? truncateForPrompt(htmlToPlainText(hnHtml)) : "";

  if (isHnTextPost(item)) {
    return {hnText, extractedText: ""};
  }

  const url = item.url?.trim();
  if (!url) {
    return {hnText, extractedText: ""};
  }

  const extracted = await fetchArticlePlainText(url, {
    timeoutMs: ENRICH_FETCH_TIMEOUT_MS,
    maxBytes: ENRICH_FETCH_MAX_BYTES,
  });
  const extractedText = extracted ? truncateForPrompt(extracted) : "";

  return {hnText, extractedText};
}

async function persistSuccess(
  firestore: FirebaseFirestore.Firestore,
  storyId: number,
  enrichment: ReturnType<typeof parseAndNormalizeEnrichmentV1>,
): Promise<void> {
  const queueRef = firestore.collection(ENRICH_QUEUE_COLLECTION).doc(String(storyId));
  const hnRef = firestore.collection(HN_ITEMS_COLLECTION).doc(String(storyId));
  const now = admin.firestore.FieldValue.serverTimestamp();

  const batch = firestore.batch();
  batch.set(
    hnRef,
    {
      enrichment: {
        ...enrichment,
        enriched_at: now,
        source_model: CLAUDE_MODEL,
      },
      enrich_status: "completed",
      enrich_failure_count: 0,
      article_pipeline_version: ENRICH_PIPELINE_VERSION,
      enrich_processing_started_at: admin.firestore.FieldValue.delete(),
    },
    {merge: true},
  );
  batch.set(
    queueRef,
    {
      status: "completed",
      completed_at: now,
      last_worker_error: admin.firestore.FieldValue.delete(),
    },
    {merge: true},
  );

  if (enrichment.title_ja.trim().length > 0) {
    const transRef = firestore
      .collection("translations")
      .doc("ja")
      .collection("stories")
      .doc(String(storyId));
    batch.set(
      transRef,
      {
        story_id: storyId,
        translated_title: enrichment.title_ja.trim(),
        cached_at: now,
        source_model: CLAUDE_MODEL,
        ttl_hours: CACHE_TTL_HOURS,
      },
      {merge: true},
    );
  }

  await batch.commit();
}

async function persistFailure(
  firestore: FirebaseFirestore.Firestore,
  storyId: number,
  message: string,
  attemptedPipelineVersion: number = ENRICH_PIPELINE_VERSION,
): Promise<void> {
  const queueRef = firestore.collection(ENRICH_QUEUE_COLLECTION).doc(String(storyId));
  const hnRef = firestore.collection(HN_ITEMS_COLLECTION).doc(String(storyId));
  const now = admin.firestore.FieldValue.serverTimestamp();

  const batch = firestore.batch();
  batch.set(
    hnRef,
    {
      enrich_status: "failed",
      enrich_failure_count: admin.firestore.FieldValue.increment(1),
      enrich_last_failed_at: now,
      article_pipeline_version: attemptedPipelineVersion,
      enrich_processing_started_at: admin.firestore.FieldValue.delete(),
    },
    {merge: true},
  );
  batch.set(
    queueRef,
    {
      status: "failed",
      last_worker_error: message.slice(0, 500),
      processing_started_at: admin.firestore.FieldValue.delete(),
    },
    {merge: true},
  );
  await batch.commit();
}

async function processStory(storyId: number, apiKey: string): Promise<void> {
  const firestore = admin.firestore();
  const claim = await tryClaimJob(firestore, storyId);
  if (claim.kind !== "claimed") {
    return;
  }

  const hnRef = firestore.collection(HN_ITEMS_COLLECTION).doc(String(storyId));
  const hnSnap = await hnRef.get();
  const hnRow = hnSnap.data() as {title?: string} | undefined;
  const item = await fetchItem(storyId);

  const title =
    (hnRow?.title ?? "").trim() || (item?.title ?? "").trim() || "(no title)";

  if (!item || isStoryHiddenByModeration(item)) {
    await persistSuccess(firestore, storyId, fallbackEnrichmentUnavailable());
    return;
  }

  const liveFp = storyIdentityFingerprint(title, item);
  if (liveFp !== claim.identityFingerprint) {
    logger.warn("enrich.identityDriftAfterClaim", {storyId});
    await persistFailure(
      firestore,
      storyId,
      "identity_changed_after_claim",
      claim.pipelineVersion,
    );
    return;
  }

  const {hnText, extractedText} = await buildContentStrings(item);
  const user = buildEnrichUserMessage({
    title,
    url: item.url?.trim() ?? "",
    type: item.type ?? "story",
    hnText,
    extractedText,
  });

  let enrichmentRaw: unknown;
  try {
    const {text} = await completeClaudeWithSystem({
      apiKey,
      system: ENRICH_V1_SYSTEM_PROMPT,
      user,
      maxTokens: 4096,
    });
    enrichmentRaw = extractJsonObject(text);
  } catch (e) {
    logger.warn("enrich.claudeOrParseFailed", {storyId, err: String(e)});
    await persistFailure(
      firestore,
      storyId,
      `claude_or_parse: ${String(e)}`,
      claim.pipelineVersion,
    );
    return;
  }

  let enrichment: ReturnType<typeof parseAndNormalizeEnrichmentV1>;
  try {
    enrichment = parseAndNormalizeEnrichmentV1(enrichmentRaw);
  } catch (e) {
    logger.warn("enrich.normalizeFailed", {storyId, err: String(e)});
    await persistFailure(firestore, storyId, `normalize: ${String(e)}`, claim.pipelineVersion);
    return;
  }

  await persistSuccess(firestore, storyId, enrichment);
}

/**
 * `enrich_queue` を消化し、`hn_items.enrichment`（V1）と Enrich 状態を更新する。
 *
 * - 取得: 本文 URL または HN `text`（Ask/Show）
 * - 成功: `enrich_status: completed` / `article_pipeline_version` / 翻訳キャッシュ `translations/ja/stories/{id}` へ `title_ja` を merge
 * - 失敗: `enrich_status: failed` + `enrich_failure_count` increment（ingest のデッドレターと整合）
 * - `processing` の長時間放置は `ENRICH_STALE_PROCESSING_MS` 経過後に再キューまたは整合
 */
export const scheduledEnrichTick = onSchedule(
  {
    schedule: "every 15 minutes",
    timeZone: "Asia/Tokyo",
    region: "asia-northeast1",
    timeoutSeconds: 540,
    memory: "512MiB",
    secrets: [ANTHROPIC_API_KEY],
  },
  async () => {
    const apiKey = ANTHROPIC_API_KEY.value();
    if (!apiKey) {
      logger.error("scheduledEnrichTick.missingApiKey");
      return;
    }

    const firestore = admin.firestore();
    const stale = await recoverStaleProcessing(firestore);

    const pendingSnap = await firestore
      .collection(ENRICH_QUEUE_COLLECTION)
      .where("status", "==", "pending")
      .orderBy("queued_at", "asc")
      .limit(ENRICH_JOBS_PER_TICK)
      .get();

    let processed = 0;
    let skipped = 0;
    for (const doc of pendingSnap.docs) {
      const storyId = doc.data().story_id as number | undefined;
      if (storyId === undefined) {
        skipped++;
        continue;
      }
      try {
        await processStory(storyId, apiKey);
        processed++;
      } catch (e) {
        logger.error("enrich.jobFailed", {storyId, err: String(e)});
        try {
          await persistFailure(firestore, storyId, `unexpected: ${String(e)}`);
        } catch (e2) {
          logger.error("enrich.persistFailureFailed", {storyId, err: String(e2)});
        }
      }
    }

    logger.info("scheduledEnrichTick.done", {
      staleRecovered: stale,
      pendingCandidates: pendingSnap.size,
      processedAttempts: processed,
      skipped,
    });
  },
);
