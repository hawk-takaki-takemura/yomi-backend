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
exports.scheduledIngestTick = exports.HN_ITEMS_COLLECTION = void 0;
const admin = __importStar(require("firebase-admin"));
const logger = __importStar(require("firebase-functions/logger"));
const scheduler_1 = require("firebase-functions/v2/scheduler");
const client_js_1 = require("../hn/client.js");
/** 1 回のスケジュールで取り込む top ストーリー件数（HN API 負荷と書き込み量のバランス） */
const TOP_STORY_LIMIT = 120;
/** HN item 取得の同時実行数 */
const FETCH_CONCURRENCY = 20;
/** Firestore バッチ上限 500 未満に抑える */
const FIRESTORE_BATCH_SIZE = 400;
/** Firestore: ランキング由来の生ストーリー（要約・翻訳は別ジョブで付与） */
exports.HN_ITEMS_COLLECTION = "hn_items";
function toItemDoc(item) {
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
    const writes = [];
    for (const [, item] of items) {
        const doc = toItemDoc(item);
        if (!doc) {
            skipped++;
            continue;
        }
        writes.push({
            ref: firestore.collection(exports.HN_ITEMS_COLLECTION).doc(String(item.id)),
            data: doc,
        });
    }
    for (let i = 0; i < writes.length; i += FIRESTORE_BATCH_SIZE) {
        const batch = firestore.batch();
        for (const w of writes.slice(i, i + FIRESTORE_BATCH_SIZE)) {
            batch.set(w.ref, w.data, { merge: true });
        }
        await batch.commit();
    }
    logger.info("scheduledIngestTick.done", {
        topListLen: topIds.length,
        fetched: items.size,
        written: writes.length,
        skipped,
    });
});
//# sourceMappingURL=scheduledIngest.js.map