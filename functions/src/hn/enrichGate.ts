import {ENRICH_PIPELINE_VERSION} from "../config.js";

/**
 * `hn_items` 上の Enrich ライフサイクル。
 *
 * **ワーカー想定**（ingest と同一 `hn_items` doc を merge）:
 * - ジョブ開始: `enrich_status: "processing"`
 * - 成功: `enrich_status: "completed"`, `article_pipeline_version: ENRICH_PIPELINE_VERSION`（`article_enrich_complete: true` は任意・レガシー互換）
 * - 失敗: `enrich_status: "failed"`（ingest が同一 identity なら再キュー可能）
 *
 * ingest はキュー投入時のみ `enrich_status: "pending"` を書く。`pending` / `processing` 中は `enrich_queue` へ載せない。
 */
export type EnrichStatus = "idle" | "pending" | "processing" | "completed" | "failed";

/** ingest / ワーカーが参照する Enrich 関連フィールド */
export type HnItemEnrichFields = {
  identity_fingerprint?: string;
  /** @deprecated enrich_status === completed に移行 */
  article_enrich_complete?: boolean;
  article_pipeline_version?: number;
  enrich_status?: EnrichStatus;
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
