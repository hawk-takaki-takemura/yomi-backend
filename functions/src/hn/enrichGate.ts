import {ENRICH_PIPELINE_VERSION} from "../config.js";

/**
 * `hn_items` 上の Enrich ライフサイクル。
 *
 * **ワーカー想定**（ingest と同一 `hn_items` doc を merge）:
 * - ジョブ開始: `enrich_status: "processing"`
 * - 成功: `enrich_status: "completed"`, `article_pipeline_version: ENRICH_PIPELINE_VERSION`、
 *   `enrich_failure_count: 0`（または FieldValue.delete）、`article_enrich_complete: true` は任意
 * - 失敗: `enrich_status: "failed"`, `enrich_failure_count: FieldValue.increment(1)`、
 *   `enrich_last_failed_at: serverTimestamp()`（任意）、`article_pipeline_version` は試行した版を記録推奨
 *
 * ingest はキュー投入時のみ `enrich_status: "pending"` を書く。`pending` / `processing` 中は `enrich_queue` へ載せない。
 * `failed` かつ失敗回数が上限に達したものはデッドレターとして再キューしない（同一パイプライン版のときのみ）。
 */
export type EnrichStatus = "idle" | "pending" | "processing" | "completed" | "failed";

/** ingest / ワーカーが参照する Enrich 関連フィールド */
export type HnItemEnrichFields = {
  identity_fingerprint?: string;
  /** @deprecated enrich_status === completed に移行 */
  article_enrich_complete?: boolean;
  article_pipeline_version?: number;
  enrich_status?: EnrichStatus;
  /** ワーカーが失敗のたびに increment。ingest は identity / パイプライン変更時に 0 に戻す */
  enrich_failure_count?: number;
};

/** 同一 identity で要約済みかつパイプライン版が一致（キュー不要） */
export function isEnrichSatisfiedForIdentity(
  prev: HnItemEnrichFields | undefined,
  docExists: boolean,
  identityFingerprint: string,
): boolean {
  if (!docExists || !prev) {
    return false;
  }
  if (prev.identity_fingerprint !== identityFingerprint) {
    return false;
  }
  if (prev.article_pipeline_version !== ENRICH_PIPELINE_VERSION) {
    return false;
  }
  if (prev.enrich_status === "completed") {
    return true;
  }
  return (
    prev.article_enrich_complete === true &&
    (prev.enrich_status === undefined || prev.enrich_status === "idle")
  );
}

/**
 * 同一 identity で既にキュー済み・処理中なら再キューしない（ワーカー未接続でも enrich_queue が膨らまない）。
 */
export function shouldSkipEnqueueDueToInFlightEnrich(
  prev: HnItemEnrichFields | undefined,
  docExists: boolean,
  identityFingerprint: string,
): boolean {
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
export function shouldSkipEnqueueDueToDeadLetter(
  prev: HnItemEnrichFields | undefined,
  docExists: boolean,
  identityFingerprint: string,
  maxFailures: number,
): boolean {
  if (!docExists || !prev) {
    return false;
  }
  if (prev.identity_fingerprint !== identityFingerprint) {
    return false;
  }
  if (prev.enrich_status !== "failed") {
    return false;
  }
  const attemptedPipeline = prev.article_pipeline_version ?? ENRICH_PIPELINE_VERSION;
  if (attemptedPipeline !== ENRICH_PIPELINE_VERSION) {
    return false;
  }
  return (prev.enrich_failure_count ?? 0) >= maxFailures;
}
