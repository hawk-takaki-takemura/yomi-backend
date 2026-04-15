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
exports.scheduledIngestTick = exports.ENRICH_QUEUE_COLLECTION = exports.HN_ITEMS_COLLECTION = void 0;
const admin = __importStar(require("firebase-admin"));
const logger = __importStar(require("firebase-functions/logger"));
const scheduler_1 = require("firebase-functions/v2/scheduler");
const config_js_1 = require("../config.js");
const client_js_1 = require("../hn/client.js");
const fingerprint_js_1 = require("../util/fingerprint.js");
/** 1 回のスケジュールで取り込む top ストーリー件数（HN API 負荷と書き込み量のバランス） */
const TOP_STORY_LIMIT = 120;
/** HN item 取得の同時実行数 */
const FETCH_CONCURRENCY = 20;
/** Firestore バッチ上限 500 未満に抑える */
const FIRESTORE_BATCH_SIZE = 400;
/** Firestore: ランキング由来の生ストーリー（要約・翻訳は enrich 側） */
exports.HN_ITEMS_COLLECTION = "hn_items";
/** 本文取得・要約など「重い処理」のキュー（差分のみ積む） */
exports.ENRICH_QUEUE_COLLECTION = "enrich_queue";
/**
 * HN topstories を定期取得し、Firestore `hn_items` に upsert する。
 * 同一性フィンガープリントが変わったときだけ `enrich_queue` に積み、要約・LLM は差分のみ走らせる前提とする。
 */
exports.scheduledIngestTick = (0, scheduler_1.onSchedule)({
    schedule: "every day 04:00",
    timeZone: "Asia/Tokyo",
    region: "asia-northeast1",
    timeoutSeconds: 300,
    memory: "512MiB",
}, async () => {
    const topIds = await (0, client_js_1.fetchTopStoryIds)();
    const slice = topIds.slice(0, TOP_STORY_LIMIT);
    const items = await (0, client_js_1.fetchItemsInBatches)(slice, FETCH_CONCURRENCY);
    const firestore = admin.firestore();
    let skipped = 0;
    const entries = [];
    for (const [, item] of items) {
        const title = item.title?.trim();
        if (item.type !== "story" || !title || item.deleted || item.dead) {
            skipped++;
            continue;
        }
        const ref = firestore.collection(exports.HN_ITEMS_COLLECTION).doc(String(item.id));
        entries.push({ ref, item, title });
    }
    const snaps = await Promise.all(entries.map((e) => e.ref.get()));
    const hnWrites = [];
    const queueWrites = [];
    for (let i = 0; i < entries.length; i++) {
        const { ref, item, title } = entries[i];
        const snap = snaps[i];
        const prev = snap.data();
        const seconds = typeof item.time === "number" ? item.time : 0;
        const score = typeof item.score === "number" ? item.score : 0;
        const descendants = typeof item.descendants === "number" ? item.descendants : 0;
        const kidsCount = Array.isArray(item.kids) ? item.kids.length : 0;
        const url = item.url ?? null;
        const idFp = (0, fingerprint_js_1.identityFingerprint)(title, url);
        const sigFp = (0, fingerprint_js_1.signalsFingerprint)(score, descendants, kidsCount);
        const firstIngested = prev?.first_ingested_at ?? admin.firestore.FieldValue.serverTimestamp();
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
                ref: firestore.collection(exports.ENRICH_QUEUE_COLLECTION).doc(String(item.id)),
                data: {
                    story_id: item.id,
                    kind: "article_summary",
                    identity_fingerprint: idFp,
                    pipeline_version: config_js_1.ENRICH_PIPELINE_VERSION,
                    status: "pending",
                    queued_at: admin.firestore.FieldValue.serverTimestamp(),
                },
            });
        }
    }
    for (let i = 0; i < hnWrites.length; i += FIRESTORE_BATCH_SIZE) {
        const batch = firestore.batch();
        for (const w of hnWrites.slice(i, i + FIRESTORE_BATCH_SIZE)) {
            batch.set(w.ref, w.data, { merge: true });
        }
        await batch.commit();
    }
    for (let i = 0; i < queueWrites.length; i += FIRESTORE_BATCH_SIZE) {
        const batch = firestore.batch();
        for (const w of queueWrites.slice(i, i + FIRESTORE_BATCH_SIZE)) {
            batch.set(w.ref, w.data, { merge: true });
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
});
//# sourceMappingURL=scheduledIngest.js.map