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
exports.getRecommendedFeed = void 0;
const admin = __importStar(require("firebase-admin"));
const https_1 = require("firebase-functions/v2/https");
const logger = __importStar(require("firebase-functions/logger"));
const firestoreCollections_js_1 = require("./firestoreCollections.js");
const MAX_LIMIT = 60;
const DEFAULT_LIMIT = 30;
const QUERY_POOL = 120;
/** Flutter `TopicGenre.name` と enrich V1 タグの対応 */
const GENRE_TO_TAGS = {
    ai: ["AI/LLM"],
    startup: ["Startup/Business"],
    webDev: ["WebDev", "Programming"],
    mobile: ["Mobile"],
    security: ["Security"],
    science: ["Science"],
};
function assertPayload(data) {
    if (typeof data !== "object" || data === null) {
        throw new https_1.HttpsError("invalid-argument", "payload must be object");
    }
    const candidate = data;
    const rawGenres = candidate.genres;
    if (!Array.isArray(rawGenres) || rawGenres.length === 0) {
        throw new https_1.HttpsError("invalid-argument", "genres must be a non-empty array");
    }
    const genres = [];
    for (const g of rawGenres) {
        if (typeof g !== "string" || !g.trim()) {
            throw new https_1.HttpsError("invalid-argument", "genre must be non-empty string");
        }
        genres.push(g.trim());
    }
    if (genres.length > 20) {
        throw new https_1.HttpsError("invalid-argument", "too many genres");
    }
    let limit = DEFAULT_LIMIT;
    if (candidate.limit !== undefined && candidate.limit !== null) {
        if (typeof candidate.limit !== "number" || !Number.isFinite(candidate.limit)) {
            throw new https_1.HttpsError("invalid-argument", "limit must be a number");
        }
        limit = Math.floor(candidate.limit);
        if (limit < 1 || limit > MAX_LIMIT) {
            throw new https_1.HttpsError("invalid-argument", `limit must be 1..${MAX_LIMIT}`);
        }
    }
    return { genres, limit };
}
function unionTagsForGenres(genres) {
    const out = new Set();
    for (const g of genres) {
        const tags = GENRE_TO_TAGS[g];
        if (!tags) {
            logger.warn("getRecommendedFeed.unknown_genre", { genre: g });
            continue;
        }
        for (const t of tags) {
            out.add(t);
        }
    }
    return [...out];
}
function timeToUnixSeconds(raw) {
    if (raw === undefined)
        return 0;
    if (typeof raw === "number" && Number.isFinite(raw))
        return Math.floor(raw);
    if (raw instanceof admin.firestore.Timestamp)
        return raw.seconds;
    return 0;
}
function serializeDoc(doc) {
    const d = doc.data();
    const enrichRaw = d.enrichment;
    let enrichment;
    if (enrichRaw &&
        enrichRaw.schema_version === 1 &&
        typeof enrichRaw.title_ja === "string" &&
        typeof enrichRaw.summary_short === "string" &&
        Array.isArray(enrichRaw.summary_points) &&
        Array.isArray(enrichRaw.tags) &&
        typeof enrichRaw.hot_topic_score === "number" &&
        typeof enrichRaw.confidence_score === "number") {
        enrichment = enrichRaw;
    }
    return {
        id: Number(doc.id),
        title: typeof d.title === "string" ? d.title : "",
        url: d.url ?? null,
        by: typeof d.by === "string" ? d.by : "",
        score: typeof d.score === "number" ? d.score : 0,
        descendants: typeof d.descendants === "number" ? d.descendants : 0,
        time: timeToUnixSeconds(d.time),
        type: typeof d.type === "string" ? d.type : "story",
        enrich_status: typeof d.enrich_status === "string" ? d.enrich_status : "idle",
        enrichment: enrichment ?? null,
    };
}
function rankScore(d) {
    const enrich = d.enrichment;
    const hot = typeof enrich?.hot_topic_score === "number" ? enrich.hot_topic_score : 0;
    const score = typeof d.score === "number" ? d.score : 0;
    return hot * 10_000 + score;
}
/**
 * Callable: ジャンルに沿ったおすすめ記事一覧（Firestore `hn_items` の enrich 済みを主に使用）。
 * クライアントは即時表示したい場合に先に HN 生を出し、後から差し替える用途にも使える。
 */
exports.getRecommendedFeed = (0, https_1.onCall)({
    region: "asia-northeast1",
    timeoutSeconds: 30,
    memory: "256MiB",
    maxInstances: 20,
    enforceAppCheck: true,
}, async (request) => {
    const { genres, limit } = assertPayload(request.data);
    const tagUnion = unionTagsForGenres(genres);
    if (tagUnion.length === 0) {
        throw new https_1.HttpsError("invalid-argument", "no known genres after normalization");
    }
    if (tagUnion.length > 10) {
        throw new https_1.HttpsError("failed-precondition", "internal: genre tag union exceeds Firestore array-contains-any limit");
    }
    const firestore = admin.firestore();
    const snap = await firestore
        .collection(firestoreCollections_js_1.HN_ITEMS_COLLECTION)
        .where("enrich_status", "==", "completed")
        .where("enrichment.tags", "array-contains-any", tagUnion)
        .limit(QUERY_POOL)
        .get();
    const docs = [...snap.docs];
    docs.sort((a, b) => rankScore(b.data()) - rankScore(a.data()));
    const sliced = docs.slice(0, limit);
    const stories = sliced.map((doc) => serializeDoc(doc));
    logger.info("getRecommendedFeed.done", {
        genres,
        limit,
        tagUnion,
        matched: docs.length,
        returned: stories.length,
    });
    return {
        stories,
        matchedCount: docs.length,
        returnedCount: stories.length,
    };
});
//# sourceMappingURL=getRecommendedFeed.js.map