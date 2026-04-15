"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isEnrichSatisfiedForIdentity = isEnrichSatisfiedForIdentity;
exports.shouldSkipEnqueueDueToInFlightEnrich = shouldSkipEnqueueDueToInFlightEnrich;
exports.shouldSkipEnqueueDueToDeadLetter = shouldSkipEnqueueDueToDeadLetter;
const config_js_1 = require("../config.js");
/** 同一 identity で要約済みかつパイプライン版が一致（キュー不要） */
function isEnrichSatisfiedForIdentity(prev, docExists, identityFingerprint) {
    if (!docExists || !prev) {
        return false;
    }
    if (prev.identity_fingerprint !== identityFingerprint) {
        return false;
    }
    if (prev.article_pipeline_version !== config_js_1.ENRICH_PIPELINE_VERSION) {
        return false;
    }
    if (prev.enrich_status === "completed") {
        return true;
    }
    return (prev.article_enrich_complete === true &&
        (prev.enrich_status === undefined || prev.enrich_status === "idle"));
}
/**
 * 同一 identity で既にキュー済み・処理中なら再キューしない（ワーカー未接続でも enrich_queue が膨らまない）。
 */
function shouldSkipEnqueueDueToInFlightEnrich(prev, docExists, identityFingerprint) {
    if (!docExists || !prev) {
        return false;
    }
    if (prev.identity_fingerprint !== identityFingerprint) {
        return false;
    }
    return prev.enrich_status === "pending" || prev.enrich_status === "processing";
}
/**
 * 同一 identity で失敗が上限に達したらデッドレター（ingest は再キューしない）。
 * `article_pipeline_version` が無い失敗は「現在のパイプライン向け」とみなし、カウンタで抑止する。
 * 保存済みのパイプライン版が `ENRICH_PIPELINE_VERSION` と異なる場合は再挑戦（バージョンアップ）のためスキップしない。
 */
function shouldSkipEnqueueDueToDeadLetter(prev, docExists, identityFingerprint, maxFailures) {
    if (!docExists || !prev) {
        return false;
    }
    if (prev.identity_fingerprint !== identityFingerprint) {
        return false;
    }
    if (prev.enrich_status !== "failed") {
        return false;
    }
    const attemptedPipeline = prev.article_pipeline_version ?? config_js_1.ENRICH_PIPELINE_VERSION;
    if (attemptedPipeline !== config_js_1.ENRICH_PIPELINE_VERSION) {
        return false;
    }
    return (prev.enrich_failure_count ?? 0) >= maxFailures;
}
//# sourceMappingURL=enrichGate.js.map