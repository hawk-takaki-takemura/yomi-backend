import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import {onSchedule} from "firebase-functions/v2/scheduler";

import {ENRICH_MAX_FAILURES, ENRICH_PIPELINE_VERSION} from "../config.js";
import {ENRICH_QUEUE_COLLECTION, HN_ITEMS_COLLECTION} from "../firestoreCollections.js";
import {fetchItemsInBatches, fetchNewStoryIds, fetchTopStoryIds} from "../hn/client.js";
import {
  isEnrichSatisfiedForIdentity,
  shouldSkipEnqueueDueToDeadLetter,
  shouldSkipEnqueueDueToInFlightEnrich,
  type HnItemEnrichFields,
} from "../hn/enrichGate.js";
import {isHnTextPost, isStoryHiddenByModeration} from "../hn/storyPolicy.js";
import type {HnItem} from "../hn/types.js";
import {signalsFingerprint, storyIdentityFingerprint} from "../util/fingerprint.js";

/** topstories から取り込む件数 */
const TOP_STORY_LIMIT = 120;
/** newstories から取り込む件数（配列先頭が最新） */
const NEW_STORY_LIMIT = 120;
/** HN item 取得の同時実行数 */
const FETCH_CONCURRENCY = 20;
/** Firestore バッチ上限 500 未満に抑える */
const FIRESTORE_BATCH_SIZE = 400;

export {ENRICH_QUEUE_COLLECTION, HN_ITEMS_COLLECTION} from "../firestoreCollections.js";

type HnItemPrev = HnItemEnrichFields & {
  first_ingested_at?: FirebaseFirestore.Timestamp;
};

type FeedMeta = {
  inTop: boolean;
  inNew: boolean;
  /** newstories スライス内の 0 始まりインデックス（小さいほど新しい）。inNew のときのみ */
  newRank?: number;
};

/** top / new の id をマージし、各 id のリスト所属メタを付与する */
function buildFeedMeta(topSlice: number[], newSlice: number[]): Map<number, FeedMeta> {
  const map = new Map<number, FeedMeta>();
  for (let i = 0; i < newSlice.length; i++) {
    const id = newSlice[i];
    map.set(id, {inTop: false, inNew: true, newRank: i});
  }
  for (const id of topSlice) {
    const prev = map.get(id);
    if (prev) {
      map.set(id, {...prev, inTop: true});
    } else {
      map.set(id, {inTop: true, inNew: false});
    }
  }
  return map;
}

/**
 * HN の topstories / newstories を定期取得し、`hn_items` に merge する。
 *
 * - **トップ**: `last_seen_in_top_at` が更新されたストーリーが直近のトップスナップショットに載ったもの。
 * - **新着**: `new_snapshot_at` + `new_snapshot_rank`（同一バッチは rank 昇順が自然）。
 *   Firestore の複合インデックスと読み取りコストを抑えたい場合は、`new_snapshot_at` のみクエリし rank はクライアントで 120 件ソートする手もある。
 * - **HOT**: `descendants` で並べ替え。過去の時点 HOT や全文検索が必要なら Algolia HN Search 等の同期を別途検討。
 *
 * **モデレーション**: `dead` / `deleted` に加え `[deleted]` 等のタイトルを取り込まない。
 * **Ask/Show**: `is_text_post` と `hn_text_char_count` を付与し、Enrich は URL 取得ではなく `text` を入力にできる。
 *
 * **Enrich**: `hn_items.enrich_status`（idle / pending / processing / completed / failed）で状態管理。
 * pending または processing のときは `enrich_queue` に載せない（ワーカー不在でもキュー増殖を防ぐ）。
 * キュー投入時は同一 merge で `enrich_status: pending` を書く。
 * **失敗**: `failed` かつ `enrich_failure_count` が `ENRICH_MAX_FAILURES` 以上（同一パイプライン版）のときは再キューしない。
 * identity またはパイプライン版が変わったら `enrich_failure_count` を 0 に戻す。
 */
export const scheduledIngestTick = onSchedule(
  {
    // 0,3,6,9,12,15,18,21 時（Asia/Tokyo）
    schedule: "0 */3 * * *",
    timeZone: "Asia/Tokyo",
    region: "asia-northeast1",
    timeoutSeconds: 300,
    memory: "512MiB",
  },
  async () => {
    const [topIds, newIds] = await Promise.all([fetchTopStoryIds(), fetchNewStoryIds()]);
    const topSlice = topIds.slice(0, TOP_STORY_LIMIT);
    const newSlice = newIds.slice(0, NEW_STORY_LIMIT);
    const feedMeta = buildFeedMeta(topSlice, newSlice);

    const uniqueIds = [...feedMeta.keys()];
    const items = await fetchItemsInBatches(uniqueIds, FETCH_CONCURRENCY);

    const firestore = admin.firestore();
    const newSnapshotAt = admin.firestore.Timestamp.now();

    let skipped = 0;
    let deadLetterSkipped = 0;

    type Entry = {
      ref: FirebaseFirestore.DocumentReference;
      item: HnItem;
      title: string;
      meta: FeedMeta;
    };
    const entries: Entry[] = [];

    for (const id of uniqueIds) {
      const item = items.get(id);
      if (!item) {
        skipped++;
        continue;
      }
      if (item.type !== "story" || isStoryHiddenByModeration(item)) {
        skipped++;
        continue;
      }
      const title = item.title!.trim();
      const ref = firestore.collection(HN_ITEMS_COLLECTION).doc(String(id));
      const meta = feedMeta.get(id)!;
      entries.push({ref, item, title, meta});
    }

    const snaps = await Promise.all(entries.map((e) => e.ref.get()));

    const hnWrites: Array<{ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown>}> = [];
    const queueWrites: Array<{ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown>}> = [];

    for (let i = 0; i < entries.length; i++) {
      const {ref, item, title, meta} = entries[i];
      const snap = snaps[i];
      const prev = snap.data() as HnItemPrev | undefined;

      const seconds = typeof item.time === "number" ? item.time : 0;
      const score = typeof item.score === "number" ? item.score : 0;
      const descendants = typeof item.descendants === "number" ? item.descendants : 0;
      const kidsCount = Array.isArray(item.kids) ? item.kids.length : 0;
      const url = item.url ?? null;

      const idFp = storyIdentityFingerprint(title, item);
      const sigFp = signalsFingerprint(score, descendants, kidsCount);
      const textPost = isHnTextPost(item);
      const hnTextCharCount = textPost ? (item.text ?? "").trim().length : 0;

      const firstIngested =
        prev?.first_ingested_at ?? admin.firestore.FieldValue.serverTimestamp();

      const data: Record<string, unknown> = {
        story_id: item.id,
        type: "story",
        title,
        url,
        score,
        by: item.by ?? null,
        time: admin.firestore.Timestamp.fromMillis(seconds * 1000),
        descendants,
        kids_count: kidsCount,
        identity_fingerprint: idFp,
        signals_fingerprint: sigFp,
        first_ingested_at: firstIngested,
        is_text_post: textPost,
        hn_text_char_count: hnTextCharCount,
      };

      if (meta.inTop) {
        data.last_seen_in_top_at = admin.firestore.FieldValue.serverTimestamp();
      }
      if (meta.inNew && meta.newRank !== undefined) {
        data.new_snapshot_at = newSnapshotAt;
        data.new_snapshot_rank = meta.newRank;
      }

      const identityUnchanged = snap.exists && prev?.identity_fingerprint === idFp;
      const identityChanged = !identityUnchanged;
      const pipelineVersionChanged =
        identityUnchanged &&
        prev?.article_pipeline_version !== undefined &&
        prev.article_pipeline_version !== ENRICH_PIPELINE_VERSION;

      if (identityChanged || pipelineVersionChanged) {
        data.enrich_failure_count = 0;
      }

      const enrichSatisfied = isEnrichSatisfiedForIdentity(prev, snap.exists, idFp);
      const skipEnqueueInFlight = shouldSkipEnqueueDueToInFlightEnrich(prev, snap.exists, idFp);
      const skipDeadLetter = shouldSkipEnqueueDueToDeadLetter(
        prev,
        snap.exists,
        idFp,
        ENRICH_MAX_FAILURES,
      );
      if (skipDeadLetter) {
        deadLetterSkipped++;
      }
      const shouldEnqueue = !enrichSatisfied && !skipEnqueueInFlight && !skipDeadLetter;

      if (shouldEnqueue) {
        data.enrich_status = "pending";
        queueWrites.push({
          ref: firestore.collection(ENRICH_QUEUE_COLLECTION).doc(String(item.id)),
          data: {
            story_id: item.id,
            kind: "article_summary",
            identity_fingerprint: idFp,
            pipeline_version: ENRICH_PIPELINE_VERSION,
            status: "pending",
            queued_at: admin.firestore.FieldValue.serverTimestamp(),
          },
        });
      }

      hnWrites.push({ref, data});
    }

    for (let i = 0; i < hnWrites.length; i += FIRESTORE_BATCH_SIZE) {
      const batch = firestore.batch();
      for (const w of hnWrites.slice(i, i + FIRESTORE_BATCH_SIZE)) {
        batch.set(w.ref, w.data, {merge: true});
      }
      await batch.commit();
    }

    for (let i = 0; i < queueWrites.length; i += FIRESTORE_BATCH_SIZE) {
      const batch = firestore.batch();
      for (const w of queueWrites.slice(i, i + FIRESTORE_BATCH_SIZE)) {
        batch.set(w.ref, w.data, {merge: true});
      }
      await batch.commit();
    }

    logger.info("scheduledIngestTick.done", {
      topListLen: topIds.length,
      newListLen: newIds.length,
      uniqueFetched: uniqueIds.length,
      written: hnWrites.length,
      skipped,
      enrichQueued: queueWrites.length,
      enrichDeadLetterSkipped: deadLetterSkipped,
    });
  },
);
