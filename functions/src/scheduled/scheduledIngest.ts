import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import {onSchedule} from "firebase-functions/v2/scheduler";

import {ENRICH_PIPELINE_VERSION} from "../config.js";
import {fetchItemsInBatches, fetchTopStoryIds} from "../hn/client.js";
import type {HnItem} from "../hn/types.js";
import {identityFingerprint, signalsFingerprint} from "../util/fingerprint.js";

/** 1 回のスケジュールで取り込む top ストーリー件数（HN API 負荷と書き込み量のバランス） */
const TOP_STORY_LIMIT = 120;
/** HN item 取得の同時実行数 */
const FETCH_CONCURRENCY = 20;
/** Firestore バッチ上限 500 未満に抑える */
const FIRESTORE_BATCH_SIZE = 400;

/** Firestore: ランキング由来の生ストーリー（要約・翻訳は enrich 側） */
export const HN_ITEMS_COLLECTION = "hn_items";

/** 本文取得・要約など「重い処理」のキュー（差分のみ積む） */
export const ENRICH_QUEUE_COLLECTION = "enrich_queue";

type HnItemPrev = {
  first_ingested_at?: FirebaseFirestore.Timestamp;
  identity_fingerprint?: string;
};

/**
 * HN topstories を定期取得し、Firestore `hn_items` に upsert する。
 * 同一性フィンガープリントが変わったときだけ `enrich_queue` に積み、要約・LLM は差分のみ走らせる前提とする。
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

    type Entry = {ref: FirebaseFirestore.DocumentReference; item: HnItem; title: string};
    const entries: Entry[] = [];

    for (const [, item] of items) {
      const title = item.title?.trim();
      if (item.type !== "story" || !title || item.deleted || item.dead) {
        skipped++;
        continue;
      }
      const ref = firestore.collection(HN_ITEMS_COLLECTION).doc(String(item.id));
      entries.push({ref, item, title});
    }

    const snaps = await Promise.all(entries.map((e) => e.ref.get()));

    const hnWrites: Array<{ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown>}> = [];
    const queueWrites: Array<{ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown>}> = [];

    for (let i = 0; i < entries.length; i++) {
      const {ref, item, title} = entries[i];
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

      hnWrites.push({
        ref,
        data: {
          story_id: item.id,
          type: "story",
          title,
          url,
          score,
          by: item.by ?? null,
          time: admin.firestore.Timestamp.fromMillis(seconds * 1000),
          descendants,
          kids_count: kidsCount,
          source: "topstories",
          identity_fingerprint: idFp,
          signals_fingerprint: sigFp,
          last_seen_in_top_at: admin.firestore.FieldValue.serverTimestamp(),
          first_ingested_at: firstIngested,
        },
      });

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
      fetched: items.size,
      written: hnWrites.length,
      skipped,
      enrichQueued: queueWrites.length,
    });
  },
);
