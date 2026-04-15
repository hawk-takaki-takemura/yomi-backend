import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import {onSchedule} from "firebase-functions/v2/scheduler";

import {fetchItemsInBatches, fetchTopStoryIds} from "../hn/client.js";
import type {HnItem} from "../hn/types.js";

/** 1 回のスケジュールで取り込む top ストーリー件数（HN API 負荷と書き込み量のバランス） */
const TOP_STORY_LIMIT = 120;
/** HN item 取得の同時実行数 */
const FETCH_CONCURRENCY = 20;
/** Firestore バッチ上限 500 未満に抑える */
const FIRESTORE_BATCH_SIZE = 400;

/** Firestore: ランキング由来の生ストーリー（要約・翻訳は別ジョブで付与） */
export const HN_ITEMS_COLLECTION = "hn_items";

type HnItemDoc = {
  story_id: number;
  type: string;
  title: string;
  url: string | null;
  score: number;
  by: string | null;
  time: admin.firestore.Timestamp;
  descendants: number;
  kids_count: number;
  source: "topstories";
  ingested_at: admin.firestore.FieldValue;
};

function toItemDoc(item: HnItem): HnItemDoc | null {
  if (item.type !== "story") {
    return null;
  }
  if (!item.title || item.deleted || item.dead) {
    return null;
  }
  const seconds = typeof item.time === "number" ? item.time : 0;
  return {
    story_id: item.id,
    type: "story",
    title: item.title,
    url: item.url ?? null,
    score: typeof item.score === "number" ? item.score : 0,
    by: item.by ?? null,
    time: admin.firestore.Timestamp.fromMillis(seconds * 1000),
    descendants: typeof item.descendants === "number" ? item.descendants : 0,
    kids_count: Array.isArray(item.kids) ? item.kids.length : 0,
    source: "topstories",
    ingested_at: admin.firestore.FieldValue.serverTimestamp(),
  };
}

/**
 * HN topstories を定期取得し、Firestore `hn_items` に upsert する。
 * 以降の Enrich（要約・翻訳・コメント）は別タスクでこのコレクションを入力にする。
 */
export const scheduledIngestTick = onSchedule(
  {
    schedule: "every day 04:00",
    timeZone: "Asia/Tokyo",
    region: "asia-northeast1",
    timeoutSeconds: 300,
    memory: "512MiB",
  },
  async () => {
    const topIds = await fetchTopStoryIds();
    const slice = topIds.slice(0, TOP_STORY_LIMIT);
    const items = await fetchItemsInBatches(slice, FETCH_CONCURRENCY);

    const firestore = admin.firestore();
    let skipped = 0;

    const writes: Array<{ref: FirebaseFirestore.DocumentReference; data: HnItemDoc}> = [];
    for (const [, item] of items) {
      const doc = toItemDoc(item);
      if (!doc) {
        skipped++;
        continue;
      }
      writes.push({
        ref: firestore.collection(HN_ITEMS_COLLECTION).doc(String(item.id)),
        data: doc,
      });
    }

    for (let i = 0; i < writes.length; i += FIRESTORE_BATCH_SIZE) {
      const batch = firestore.batch();
      for (const w of writes.slice(i, i + FIRESTORE_BATCH_SIZE)) {
        batch.set(w.ref, w.data, {merge: true});
      }
      await batch.commit();
    }

    logger.info("scheduledIngestTick.done", {
      topListLen: topIds.length,
      fetched: items.size,
      written: writes.length,
      skipped,
    });
  },
);
