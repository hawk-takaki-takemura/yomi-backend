"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.scheduledEnrichTick = void 0;
const admin = __importStar(require("firebase-admin"));
const logger = __importStar(require("firebase-functions/logger"));
const scheduler_1 = require("firebase-functions/v2/scheduler");
const anthropic_js_1 = require("../anthropic.js");
const config_js_1 = require("../config.js");
const buildEnrichUserMessage_js_1 = require("../enrich/buildEnrichUserMessage.js");
const enrichmentTypes_js_1 = require("../enrich/enrichmentTypes.js");
const extractJsonObject_js_1 = require("../enrich/extractJsonObject.js");
const fetchArticlePlainText_js_1 = require("../enrich/fetchArticlePlainText.js");
const htmlToPlainText_js_1 = require("../enrich/htmlToPlainText.js");
const firestoreCollections_js_1 = require("../firestoreCollections.js");
const client_js_1 = require("../hn/client.js");
const storyPolicy_js_1 = require("../hn/storyPolicy.js");
const enrichV1System_js_1 = require("../prompts/enrichV1System.js");
const fingerprint_js_1 = require("../util/fingerprint.js");
function truncateForPrompt(s) {
    if (s.length <= config_js_1.ENRICH_MAX_PROMPT_CHARS)
        return s;
    return `${s.slice(0, config_js_1.ENRICH_MAX_PROMPT_CHARS)}\n\n[truncated]`;
}
async function recoverStaleProcessing(firestore) {
    const threshold = admin.firestore.Timestamp.fromMillis(Date.now() - config_js_1.ENRICH_STALE_PROCESSING_MS);
    const snap = await firestore
        .collection(firestoreCollections_js_1.ENRICH_QUEUE_COLLECTION)
        .where("status", "==", "processing")
        .where("processing_started_at", "<", threshold)
        .limit(30)
        .get();
    let n = 0;
    for (const doc of snap.docs) {
        const storyId = doc.data().story_id;
        if (storyId === undefined)
            continue;
        const hnRef = firestore.collection(firestoreCollections_js_1.HN_ITEMS_COLLECTION).doc(String(storyId));
        const hnSnap = await hnRef.get();
        const hn = hnSnap.data();
        const batch = firestore.batch();
        if (hn?.enrich_status === "completed") {
            batch.set(doc.ref, {
                status: "completed",
                completed_at: admin.firestore.FieldValue.serverTimestamp(),
                completed_reason: "reconcile_hn_completed",
                processing_started_at: admin.firestore.FieldValue.delete(),
            }, { merge: true });
        }
        else if (hn?.enrich_status === "processing") {
            batch.set(doc.ref, {
                status: "pending",
                processing_started_at: admin.firestore.FieldValue.delete(),
                stale_recovered_at: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
            batch.set(hnRef, {
                enrich_status: "pending",
                enrich_processing_started_at: admin.firestore.FieldValue.delete(),
            }, { merge: true });
        }
        else if (hn?.enrich_status === "failed") {
            batch.set(doc.ref, {
                status: "failed",
                processing_started_at: admin.firestore.FieldValue.delete(),
                stale_recovered_at: admin.firestore.FieldValue.serverTimestamp(),
                last_worker_error: "stale_processing_reconcile",
            }, { merge: true });
        }
        else {
            batch.set(doc.ref, {
                status: "pending",
                processing_started_at: admin.firestore.FieldValue.delete(),
                stale_recovered_at: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
        }
        await batch.commit();
        n++;
    }
    return n;
}
async function tryClaimJob(firestore, storyId) {
    const queueRef = firestore.collection(firestoreCollections_js_1.ENRICH_QUEUE_COLLECTION).doc(String(storyId));
    const hnRef = firestore.collection(firestoreCollections_js_1.HN_ITEMS_COLLECTION).doc(String(storyId));
    let result = { kind: "skip" };
    await firestore.runTransaction(async (tx) => {
        const qSnap = await tx.get(queueRef);
        if (!qSnap.exists) {
            result = { kind: "skip" };
            return;
        }
        const q = qSnap.data();
        if (q.status !== "pending") {
            result = { kind: "skip" };
            return;
        }
        const hnSnap = await tx.get(hnRef);
        if (!hnSnap.exists) {
            result = { kind: "skip" };
            return;
        }
        const hn = hnSnap.data();
        if (hn.enrich_status !== "pending") {
            result = { kind: "skip" };
            return;
        }
        if (typeof q.identity_fingerprint === "string" &&
            typeof hn.identity_fingerprint === "string" &&
            q.identity_fingerprint !== hn.identity_fingerprint) {
            tx.set(queueRef, {
                status: "completed",
                completed_at: admin.firestore.FieldValue.serverTimestamp(),
                completed_reason: "identity_mismatch",
                processing_started_at: admin.firestore.FieldValue.delete(),
            }, { merge: true });
            tx.set(hnRef, { enrich_status: "idle" }, { merge: true });
            result = { kind: "obsolete" };
            return;
        }
        if (typeof q.pipeline_version === "number" &&
            q.pipeline_version !== config_js_1.ENRICH_PIPELINE_VERSION) {
            tx.set(queueRef, {
                status: "completed",
                completed_at: admin.firestore.FieldValue.serverTimestamp(),
                completed_reason: "pipeline_mismatch",
                processing_started_at: admin.firestore.FieldValue.delete(),
            }, { merge: true });
            tx.set(hnRef, { enrich_status: "idle" }, { merge: true });
            result = { kind: "obsolete" };
            return;
        }
        tx.set(hnRef, {
            enrich_status: "processing",
            enrich_processing_started_at: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        tx.set(queueRef, {
            status: "processing",
            processing_started_at: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        result = {
            kind: "claimed",
            identityFingerprint: q.identity_fingerprint ?? "",
            pipelineVersion: q.pipeline_version ?? config_js_1.ENRICH_PIPELINE_VERSION,
        };
    });
    return result;
}
function fallbackEnrichmentUnavailable() {
    return (0, enrichmentTypes_js_1.parseAndNormalizeEnrichmentV1)({
        schema_version: 1,
        title_ja: "",
        summary_short: "参照元が利用できないため要約できません。",
        summary_points: ["モデレーションまたは削除により参照できません", "要約対象外です"],
        tags: ["Others"],
        hot_topic_score: 0,
        confidence_score: 0,
    });
}
async function buildContentStrings(item) {
    const hnHtml = (item.text ?? "").trim();
    const hnText = hnHtml ? truncateForPrompt((0, htmlToPlainText_js_1.htmlToPlainText)(hnHtml)) : "";
    if ((0, storyPolicy_js_1.isHnTextPost)(item)) {
        return { hnText, extractedText: "" };
    }
    const url = item.url?.trim();
    if (!url) {
        return { hnText, extractedText: "" };
    }
    const extracted = await (0, fetchArticlePlainText_js_1.fetchArticlePlainText)(url, {
        timeoutMs: config_js_1.ENRICH_FETCH_TIMEOUT_MS,
        maxBytes: config_js_1.ENRICH_FETCH_MAX_BYTES,
    });
    const extractedText = extracted ? truncateForPrompt(extracted) : "";
    return { hnText, extractedText };
}
async function persistSuccess(firestore, storyId, enrichment) {
    const queueRef = firestore.collection(firestoreCollections_js_1.ENRICH_QUEUE_COLLECTION).doc(String(storyId));
    const hnRef = firestore.collection(firestoreCollections_js_1.HN_ITEMS_COLLECTION).doc(String(storyId));
    const now = admin.firestore.FieldValue.serverTimestamp();
    const batch = firestore.batch();
    batch.set(hnRef, {
        enrichment: {
            ...enrichment,
            enriched_at: now,
            source_model: config_js_1.CLAUDE_MODEL,
        },
        enrich_status: "completed",
        enrich_failure_count: 0,
        article_pipeline_version: config_js_1.ENRICH_PIPELINE_VERSION,
        enrich_processing_started_at: admin.firestore.FieldValue.delete(),
    }, { merge: true });
    batch.set(queueRef, {
        status: "completed",
        completed_at: now,
        last_worker_error: admin.firestore.FieldValue.delete(),
    }, { merge: true });
    if (enrichment.title_ja.trim().length > 0) {
        const transRef = firestore
            .collection("translations")
            .doc("ja")
            .collection("stories")
            .doc(String(storyId));
        batch.set(transRef, {
            story_id: storyId,
            translated_title: enrichment.title_ja.trim(),
            cached_at: now,
            source_model: config_js_1.CLAUDE_MODEL,
            ttl_hours: config_js_1.CACHE_TTL_HOURS,
        }, { merge: true });
    }
    await batch.commit();
}
async function persistFailure(firestore, storyId, message, attemptedPipelineVersion = config_js_1.ENRICH_PIPELINE_VERSION) {
    const queueRef = firestore.collection(firestoreCollections_js_1.ENRICH_QUEUE_COLLECTION).doc(String(storyId));
    const hnRef = firestore.collection(firestoreCollections_js_1.HN_ITEMS_COLLECTION).doc(String(storyId));
    const now = admin.firestore.FieldValue.serverTimestamp();
    const batch = firestore.batch();
    batch.set(hnRef, {
        enrich_status: "failed",
        enrich_failure_count: admin.firestore.FieldValue.increment(1),
        enrich_last_failed_at: now,
        article_pipeline_version: attemptedPipelineVersion,
        enrich_processing_started_at: admin.firestore.FieldValue.delete(),
    }, { merge: true });
    batch.set(queueRef, {
        status: "failed",
        last_worker_error: message.slice(0, 500),
        processing_started_at: admin.firestore.FieldValue.delete(),
    }, { merge: true });
    await batch.commit();
}
async function processStory(storyId, apiKey) {
    const firestore = admin.firestore();
    const claim = await tryClaimJob(firestore, storyId);
    if (claim.kind !== "claimed") {
        return;
    }
    const hnRef = firestore.collection(firestoreCollections_js_1.HN_ITEMS_COLLECTION).doc(String(storyId));
    const hnSnap = await hnRef.get();
    const hnRow = hnSnap.data();
    const item = await (0, client_js_1.fetchItem)(storyId);
    const title = (hnRow?.title ?? "").trim() || (item?.title ?? "").trim() || "(no title)";
    if (!item || (0, storyPolicy_js_1.isStoryHiddenByModeration)(item)) {
        await persistSuccess(firestore, storyId, fallbackEnrichmentUnavailable());
        return;
    }
    const liveFp = (0, fingerprint_js_1.storyIdentityFingerprint)(title, item);
    if (liveFp !== claim.identityFingerprint) {
        logger.warn("enrich.identityDriftAfterClaim", { storyId });
        await persistFailure(firestore, storyId, "identity_changed_after_claim", claim.pipelineVersion);
        return;
    }
    const { hnText, extractedText } = await buildContentStrings(item);
    const user = (0, buildEnrichUserMessage_js_1.buildEnrichUserMessage)({
        title,
        url: item.url?.trim() ?? "",
        type: item.type ?? "story",
        hnText,
        extractedText,
    });
    let enrichmentRaw;
    try {
        const { text } = await (0, anthropic_js_1.completeClaudeWithSystem)({
            apiKey,
            system: enrichV1System_js_1.ENRICH_V1_SYSTEM_PROMPT,
            user,
            maxTokens: 4096,
        });
        enrichmentRaw = (0, extractJsonObject_js_1.extractJsonObject)(text);
    }
    catch (e) {
        logger.warn("enrich.claudeOrParseFailed", { storyId, err: String(e) });
        await persistFailure(firestore, storyId, `claude_or_parse: ${String(e)}`, claim.pipelineVersion);
        return;
    }
    let enrichment;
    try {
        enrichment = (0, enrichmentTypes_js_1.parseAndNormalizeEnrichmentV1)(enrichmentRaw);
    }
    catch (e) {
        logger.warn("enrich.normalizeFailed", { storyId, err: String(e) });
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
exports.scheduledEnrichTick = (0, scheduler_1.onSchedule)({
    schedule: "every 15 minutes",
    timeZone: "Asia/Tokyo",
    region: "asia-northeast1",
    timeoutSeconds: 540,
    memory: "512MiB",
    secrets: [config_js_1.ANTHROPIC_API_KEY],
}, async () => {
    const apiKey = config_js_1.ANTHROPIC_API_KEY.value();
    if (!apiKey) {
        logger.error("scheduledEnrichTick.missingApiKey");
        return;
    }
    const firestore = admin.firestore();
    const stale = await recoverStaleProcessing(firestore);
    const pendingSnap = await firestore
        .collection(firestoreCollections_js_1.ENRICH_QUEUE_COLLECTION)
        .where("status", "==", "pending")
        .orderBy("queued_at", "asc")
        .limit(config_js_1.ENRICH_JOBS_PER_TICK)
        .get();
    let processed = 0;
    let skipped = 0;
    for (const doc of pendingSnap.docs) {
        const storyId = doc.data().story_id;
        if (storyId === undefined) {
            skipped++;
            continue;
        }
        try {
            await processStory(storyId, apiKey);
            processed++;
        }
        catch (e) {
            logger.error("enrich.jobFailed", { storyId, err: String(e) });
            try {
                await persistFailure(firestore, storyId, `unexpected: ${String(e)}`);
            }
            catch (e2) {
                logger.error("enrich.persistFailureFailed", { storyId, err: String(e2) });
            }
        }
    }
    logger.info("scheduledEnrichTick.done", {
        staleRecovered: stale,
        pendingCandidates: pendingSnap.size,
        processedAttempts: processed,
        skipped,
    });
});
//# sourceMappingURL=scheduledEnrich.js.map