import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import {onSchedule} from "firebase-functions/v2/scheduler";

import {ENRICH_PIPELINE_VERSION} from "../config.js";
import {fetchItemsInBatches, fetchNewStoryIds, fetchTopStoryIds} from "../hn/client.js";
import type {HnItem} from "../hn/types.js";
import {identityFingerprint, signalsFingerprint} from "../util/fingerprint.js";

/** topstories から取り込む件数 */
const TOP_STORY_LIMIT = 120;
/** newstories から取り込む件数（配列先頭が最新） */
const NEW_STORY_LIMIT = 120;
/** HN item 取得の同時実行数 */
const FETCH_CONCURRENCY = 20;
/** Firestore バッチ上限 500 未満に抑える */
const FIRESTORE_BATCH_SIZE = 400;

/** Firestore: ストーリー正本（トップ／新着の両方から merge 更新） */
export const HN_ITEMS_COLLECTION = "hn_items";

/** 本文取得・要約など「重い処理」のキュー（差分のみ積む） */
export const ENRICH_QUEUE_COLLECTION = "enrich_queue";

type HnItemPrev = {
  first_ingested_at?: FirebaseFirestore.Timestamp;
  identity_fingerprint?: string;
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
 * - **トップ**: `last_seen_in_top_at` が更新されたストーリーが直近のトップスナップショットに載ったもの。
 * - **新着**: `new_snapshot_at` + `new_snapshot_rank` で「その取得バッチ内の新しい順」を再現（同一バッチは rank 昇順、バッチ跨ぎは snapshot 降順など）。
 * - **HOT（コメント多い順）**: HN の `descendants` をそのまま載せる。並び替えはクライアントまたは `orderBy('descendants')` のクエリで行う。
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
    const [topIds, newIds] = await Promise.all([fetchTopStoryIds(), fetchNewStoryIds()]);
    const topSlice = topIds.slice(0, TOP_STORY_LIMIT);
    const newSlice = newIds.slice(0, NEW_STORY_LIMIT);
    const feedMeta = buildFeedMeta(topSlice, newSlice);

    const uniqueIds = [...feedMeta.keys()];
    const items = await fetchItemsInBatches(uniqueIds, FETCH_CONCURRENCY);

    const firestore = admin.firestore();
    const newSnapshotAt = admin.firestore.Timestamp.now();

    let skipped = 0;

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
      const title = item.title?.trim();
      if (item.type !== "story" || !title || item.deleted || item.dead) {
        skipped++;
        continue;
      }
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

      const idFp = identityFingerprint(title, url);
      const sigFp = signalsFingerprint(score, descendants, kidsCount);

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
      };

      if (meta.inTop) {
        data.last_seen_in_top_at = admin.firestore.FieldValue.serverTimestamp();
      }
      if (meta.inNew && meta.newRank !== undefined) {
        data.new_snapshot_at = newSnapshotAt;
        data.new_snapshot_rank = meta.newRank;
      }

      hnWrites.push({ref, data});

      const needArticleEnrich = !snap.exists || prev?.identity_fingerprint !== idFp;
      if (needArticleEnrich) {
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
    });
  },
);
