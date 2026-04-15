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
exports.fetchTopStoryIds = fetchTopStoryIds;
exports.fetchItem = fetchItem;
exports.fetchItemsInBatches = fetchItemsInBatches;
const logger = __importStar(require("firebase-functions/logger"));
const HN_BASE = "https://hacker-news.firebaseio.com/v0";
async function fetchJson(path) {
    const url = `${HN_BASE}${path}`;
    const res = await fetch(url);
    if (res.status === 404) {
        return null;
    }
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`HN fetch failed ${res.status}: ${body.slice(0, 200)}`);
    }
    return (await res.json());
}
/** topstories の id 一覧（新しい順ではなく人気スコアベースのランキング） */
async function fetchTopStoryIds() {
    const ids = await fetchJson("/topstories.json");
    if (!ids || !Array.isArray(ids)) {
        throw new Error("HN topstories.json invalid");
    }
    return ids;
}
async function fetchItem(id) {
    return fetchJson(`/item/${id}.json`);
}
/**
 * 並列度を抑えつつ item を取得する。
 * 失敗した id はスキップし、ログに残す（1件で全体を落とさない）。
 */
async function fetchItemsInBatches(ids, concurrency) {
    const result = new Map();
    for (let i = 0; i < ids.length; i += concurrency) {
        const chunk = ids.slice(i, i + concurrency);
        const settled = await Promise.allSettled(chunk.map((id) => fetchItem(id)));
        for (let j = 0; j < chunk.length; j++) {
            const id = chunk[j];
            const outcome = settled[j];
            if (outcome.status === "fulfilled" &&
                outcome.value &&
                !outcome.value.deleted &&
                !outcome.value.dead) {
                result.set(id, outcome.value);
            }
            else if (outcome.status === "rejected") {
                logger.warn("hn.fetchItem failed", { id, err: String(outcome.reason) });
            }
        }
    }
    return result;
}
//# sourceMappingURL=client.js.map