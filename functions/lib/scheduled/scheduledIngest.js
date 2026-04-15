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
const storyPolicy_js_1 = require("../hn/storyPolicy.js");
const fingerprint_js_1 = require("../util/fingerprint.js");
/** topstories から取り込む件数 */
const TOP_STORY_LIMIT = 120;
/** newstories から取り込む件数（配列先頭が最新） */
const NEW_STORY_LIMIT = 120;
/** HN item 取得の同時実行数 */
const FETCH_CONCURRENCY = 20;
/** Firestore バッチ上限 500 未満に抑える */
const FIRESTORE_BATCH_SIZE = 400;
/** Firestore: ストーリー正本（トップ／新着の両方から merge 更新） */
exports.HN_ITEMS_COLLECTION = "hn_items";
/** 本文取得・要約など「重い処理」のキュー（差分のみ積む） */
exports.ENRICH_QUEUE_COLLECTION = "enrich_queue";
/** top / new の id をマージし、各 id のリスト所属メタを付与する */
function buildFeedMeta(topSlice, newSlice) {
    const map = new Map();
    for (let i = 0; i < newSlice.length; i++) {
        const id = newSlice[i];
        map.set(id, { inTop: false, inNew: true, newRank: i });
    }
    for (const id of topSlice) {
        const prev = map.get(id);
        if (prev) {
            map.set(id, { ...prev, inTop: true });
        }
        else {
            map.set(id, { inTop: true, inNew: false });
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
 */
exports.scheduledIngestTick = (0, scheduler_1.onSchedule)({
    schedule: "every day 04:00",
    timeZone: "Asia/Tokyo",
    region: "asia-northeast1",
    timeoutSeconds: 300,
    memory: "512MiB",
}, async () => {
    const [topIds, newIds] = await Promise.all([(0, client_js_1.fetchTopStoryIds)(), (0, client_js_1.fetchNewStoryIds)()]);
    const topSlice = topIds.slice(0, TOP_STORY_LIMIT);
    const newSlice = newIds.slice(0, NEW_STORY_LIMIT);
    const feedMeta = buildFeedMeta(topSlice, newSlice);
    const uniqueIds = [...feedMeta.keys()];
    const items = await (0, client_js_1.fetchItemsInBatches)(uniqueIds, FETCH_CONCURRENCY);
    const firestore = admin.firestore();
    const newSnapshotAt = admin.firestore.Timestamp.now();
    let skipped = 0;
    const entries = [];
    for (const id of uniqueIds) {
        const item = items.get(id);
        if (!item) {
            skipped++;
            continue;
        }
        if (item.type !== "story" || (0, storyPolicy_js_1.isStoryHiddenByModeration)(item)) {
            skipped++;
            continue;
        }
        const title = item.title.trim();
        const ref = firestore.collection(exports.HN_ITEMS_COLLECTION).doc(String(id));
        const meta = feedMeta.get(id);
        entries.push({ ref, item, title, meta });
    }
    const snaps = await Promise.all(entries.map((e) => e.ref.get()));
    const hnWrites = [];
    const queueWrites = [];
    for (let i = 0; i < entries.length; i++) {
        const { ref, item, title, meta } = entries[i];
        const snap = snaps[i];
        const prev = snap.data();
        const seconds = typeof item.time === "number" ? item.time : 0;
        const score = typeof item.score === "number" ? item.score : 0;
        const descendants = typeof item.descendants === "number" ? item.descendants : 0;
        const kidsCount = Array.isArray(item.kids) ? item.kids.length : 0;
        const url = item.url ?? null;
        const idFp = (0, fingerprint_js_1.storyIdentityFingerprint)(title, item);
        const sigFp = (0, fingerprint_js_1.signalsFingerprint)(score, descendants, kidsCount);
        const textPost = (0, storyPolicy_js_1.isHnTextPost)(item);
        const hnTextCharCount = textPost ? (item.text ?? "").trim().length : 0;
        const firstIngested = prev?.first_ingested_at ?? admin.firestore.FieldValue.serverTimestamp();
        const data = {
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
        hnWrites.push({ ref, data });
        /**
         * Claude を無駄に叩かない: 同一 identity で要約済みかつパイプライン版が一致ならキューしない。
         * 要約ワーカー未デプロイ時は毎回キューに載るが merge のみ（日次なら許容。高頻度取り込みならキュー doc の status で抑止を検討）。
         */
        const enrichAlreadyOk = snap.exists &&
            prev?.identity_fingerprint === idFp &&
            prev?.article_enrich_complete === true &&
            prev?.article_pipeline_version === config_js_1.ENRICH_PIPELINE_VERSION;
        if (!enrichAlreadyOk) {
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
        newListLen: newIds.length,
        uniqueFetched: uniqueIds.length,
        written: hnWrites.length,
        skipped,
        enrichQueued: queueWrites.length,
    });
});
//# sourceMappingURL=scheduledIngest.js.map