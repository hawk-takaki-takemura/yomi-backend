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
exports.translateHnComments = void 0;
const admin = __importStar(require("firebase-admin"));
const https_1 = require("firebase-functions/v2/https");
const logger = __importStar(require("firebase-functions/logger"));
const anthropic_js_1 = require("./anthropic.js");
const config_js_1 = require("./config.js");
const htmlToPlainText_js_1 = require("./enrich/htmlToPlainText.js");
const client_js_1 = require("./hn/client.js");
/** 無料（匿名含む）のコメント翻訳・取得上限（BFS での件数）。 */
const FREE_COMMENT_TRANSLATION_LIMIT = 20;
/** 有料: `users/{uid}.isPremium == true` のときの上限（バズ記事向け）。 */
const PREMIUM_COMMENT_TRANSLATION_LIMIT = 150;
const MAX_COMMENTS_PER_REQUEST = PREMIUM_COMMENT_TRANSLATION_LIMIT;
const MAX_COMMENT_LENGTH = 1200;
/** BFS の各ウェーブで並列取得する件数（HN Firebase API への負荷とレイテンシのバランス）。 */
const HN_BFS_FETCH_CONCURRENCY = 12;
/** 本番のみ App Check 必須。stg はエミュレータ・debug token 周りで弾かれやすいため緩める。 */
const projectId = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? "";
const enforceAppCheckTranslateComments = projectId === "yomi-prod";
function assertPayload(data) {
    if (typeof data !== "object" || data === null) {
        throw new https_1.HttpsError("invalid-argument", "payload must be object");
    }
    const candidate = data;
    if (typeof candidate.storyId !== "number" || !Number.isInteger(candidate.storyId)) {
        throw new https_1.HttpsError("invalid-argument", "storyId must be integer");
    }
    if (candidate.storyId <= 0) {
        throw new https_1.HttpsError("invalid-argument", "storyId must be positive");
    }
    if (candidate.limit !== undefined) {
        if (typeof candidate.limit !== "number" || !Number.isInteger(candidate.limit)) {
            throw new https_1.HttpsError("invalid-argument", "limit must be integer");
        }
        if (candidate.limit <= 0 || candidate.limit > MAX_COMMENTS_PER_REQUEST) {
            throw new https_1.HttpsError("invalid-argument", "limit exceeds range");
        }
    }
    return {
        storyId: candidate.storyId,
        lang: candidate.lang,
        limit: candidate.limit,
    };
}
/**
 * ストーリ直下から BFS でコメントを収集。各層は `fetchItemsInBatches` で並列取得し、
 * 収集したコメント本文用の `HnItem` を二重フェッチしないよう返す。
 */
async function collectCommentsBreadthFirst(rootIds, limit) {
    const queue = [...rootIds];
    const visited = new Set();
    const commentIds = [];
    const itemsById = new Map();
    while (queue.length > 0 && commentIds.length < limit) {
        const wave = [];
        while (queue.length > 0 &&
            wave.length < HN_BFS_FETCH_CONCURRENCY &&
            commentIds.length < limit) {
            const id = queue.shift();
            if (!id || visited.has(id)) {
                continue;
            }
            visited.add(id);
            wave.push(id);
        }
        if (wave.length === 0) {
            break;
        }
        const fetched = await (0, client_js_1.fetchItemsInBatches)(wave, HN_BFS_FETCH_CONCURRENCY);
        for (const id of wave) {
            if (commentIds.length >= limit) {
                break;
            }
            const item = fetched.get(id);
            if (!item || item.deleted || item.dead) {
                continue;
            }
            if (item.type === "comment") {
                commentIds.push(id);
                itemsById.set(id, item);
            }
            if (Array.isArray(item.kids)) {
                for (const kid of item.kids) {
                    if (typeof kid === "number" && !visited.has(kid)) {
                        queue.push(kid);
                    }
                }
            }
        }
    }
    return { commentIds, itemsById };
}
async function maxCommentTranslationLimitForCaller(request) {
    const uid = request.auth?.uid;
    if (!uid) {
        return FREE_COMMENT_TRANSLATION_LIMIT;
    }
    try {
        const snap = await admin.firestore().collection("users").doc(uid).get();
        const isPremium = snap.exists && snap.data()?.isPremium === true;
        return isPremium ? PREMIUM_COMMENT_TRANSLATION_LIMIT : FREE_COMMENT_TRANSLATION_LIMIT;
    }
    catch (e) {
        logger.warn("translateHnComments.premiumLookupFailed", { uid, err: String(e) });
        return FREE_COMMENT_TRANSLATION_LIMIT;
    }
}
/** Callable: 上位HNコメントを翻訳して返す（Firestoreキャッシュ付き）。 */
exports.translateHnComments = (0, https_1.onCall)({
    region: "asia-northeast1",
    timeoutSeconds: 120,
    memory: "512MiB",
    maxInstances: 20,
    enforceAppCheck: enforceAppCheckTranslateComments,
    secrets: [config_js_1.ANTHROPIC_API_KEY],
}, async (request) => {
    const payload = assertPayload(request.data);
    const lang = payload.lang?.trim() || "ja";
    const tierCap = await maxCommentTranslationLimitForCaller(request);
    const requested = payload.limit ?? tierCap;
    const limit = Math.min(requested, tierCap);
    logger.info("translateHnComments.start", {
        storyId: payload.storyId,
        lang,
        limit,
        tierCap,
    });
    const story = await (0, client_js_1.fetchItem)(payload.storyId);
    if (!story || !Array.isArray(story.kids) || story.kids.length === 0) {
        return {
            storyId: payload.storyId,
            comments: [],
            cachedCount: 0,
            translatedCount: 0,
        };
    }
    const { commentIds, itemsById } = await collectCommentsBreadthFirst(story.kids, limit);
    const commentTexts = {};
    for (const commentId of commentIds) {
        const item = itemsById.get(commentId);
        if (!item || item.deleted || item.dead || item.type !== "comment" || !item.text) {
            continue;
        }
        const plain = (0, htmlToPlainText_js_1.htmlToPlainText)(item.text).trim();
        if (!plain)
            continue;
        commentTexts[String(commentId)] = plain.slice(0, MAX_COMMENT_LENGTH);
    }
    const firestore = admin.firestore();
    const now = admin.firestore.Timestamp.now();
    const expiresBefore = now.toMillis() - config_js_1.CACHE_TTL_HOURS * 60 * 60 * 1000;
    const cachedResult = {};
    const needTranslation = {};
    await Promise.all(Object.entries(commentTexts).map(async ([commentId, text]) => {
        const docRef = firestore
            .collection("translations")
            .doc(lang)
            .collection("comments")
            .doc(commentId);
        const snap = await docRef.get();
        if (!snap.exists) {
            needTranslation[commentId] = text;
            return;
        }
        const data = snap.data();
        const cachedAt = data?.cached_at;
        const translatedText = data?.translated_text;
        if (!translatedText || !cachedAt || cachedAt.toMillis() < expiresBefore) {
            needTranslation[commentId] = text;
            return;
        }
        cachedResult[commentId] = translatedText;
    }));
    let translatedCount = 0;
    if (Object.keys(needTranslation).length > 0) {
        const apiKey = config_js_1.ANTHROPIC_API_KEY.value();
        if (!apiKey) {
            throw new https_1.HttpsError("failed-precondition", "ANTHROPIC_API_KEY is not set");
        }
        const translated = await (0, anthropic_js_1.translateTextsWithClaude)(needTranslation, lang, apiKey);
        translatedCount = Object.keys(translated).length;
        const batch = firestore.batch();
        for (const [commentId, translatedText] of Object.entries(translated)) {
            cachedResult[commentId] = translatedText;
            const docRef = firestore
                .collection("translations")
                .doc(lang)
                .collection("comments")
                .doc(commentId);
            const doc = {
                comment_id: Number(commentId),
                story_id: payload.storyId,
                original_text: needTranslation[commentId] ?? "",
                translated_text: translatedText,
                cached_at: now,
                source_model: config_js_1.CLAUDE_MODEL,
                ttl_hours: config_js_1.CACHE_TTL_HOURS,
            };
            batch.set(docRef, doc, { merge: true });
        }
        await batch.commit();
    }
    const comments = commentIds
        .map((commentId) => {
        const original = commentTexts[String(commentId)];
        const translated = cachedResult[String(commentId)];
        if (!original || !translated)
            return null;
        return {
            commentId,
            originalText: original,
            translatedText: translated,
        };
    })
        .filter((v) => v !== null);
    return {
        storyId: payload.storyId,
        comments,
        cachedCount: Object.keys(cachedResult).length - translatedCount,
        translatedCount,
    };
});
//# sourceMappingURL=translateHnComments.js.map