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
exports.analyzeHnCommentTrends = void 0;
const admin = __importStar(require("firebase-admin"));
const https_1 = require("firebase-functions/v2/https");
const logger = __importStar(require("firebase-functions/logger"));
const anthropic_js_1 = require("./anthropic.js");
const config_js_1 = require("./config.js");
const commentCallableTier_js_1 = require("./commentCallableTier.js");
const extractJsonObject_js_1 = require("./enrich/extractJsonObject.js");
const htmlToPlainText_js_1 = require("./enrich/htmlToPlainText.js");
const firestoreCollections_js_1 = require("./firestoreCollections.js");
const collectCommentsBreadthFirst_js_1 = require("./hn/collectCommentsBreadthFirst.js");
const client_js_1 = require("./hn/client.js");
/** クライアントが `limit` を省略したときのデフォルトはティア別（handler で決定）。 */
const MAX_SNIPPETS = config_js_1.COMMENT_CALLABLE_PREMIUM_MAX_COUNT;
/** 1 コメントあたりの最大文字（プロンプト肥大化防止）。 */
const MAX_TEXT_LEN = 2000;
function commentTrendsCacheFieldName(kind) {
    return kind === "premium" ? "comment_trends_cache_premium" : "comment_trends_cache_free";
}
const projectId = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? "";
const enforceAppCheckAnalyzeTrends = projectId === "yomi-prod";
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
        if (candidate.limit <= 0 || candidate.limit > MAX_SNIPPETS) {
            throw new https_1.HttpsError("invalid-argument", "limit exceeds range");
        }
    }
    return {
        storyId: candidate.storyId,
        limit: candidate.limit,
        comments: candidate.comments,
    };
}
function parseCommentSnippets(raw, cap) {
    if (!Array.isArray(raw))
        return null;
    const out = [];
    for (const row of raw) {
        if (out.length >= cap)
            break;
        if (typeof row !== "object" || row === null)
            continue;
        const o = row;
        const idRaw = o.commentId ?? o["comment_id"];
        const textRaw = o.text;
        if (typeof idRaw !== "number" || !Number.isInteger(idRaw) || idRaw <= 0)
            continue;
        if (typeof textRaw !== "string")
            continue;
        const text = textRaw.trim().slice(0, MAX_TEXT_LEN);
        if (!text)
            continue;
        out.push({ commentId: idRaw, text });
    }
    return out.length ? out : null;
}
async function loadSnippetsFromHn(storyId, limit, maxDepth) {
    const story = await (0, client_js_1.fetchItem)(storyId);
    if (!story || !Array.isArray(story.kids) || story.kids.length === 0) {
        return [];
    }
    const { commentIds, itemsById } = await (0, collectCommentsBreadthFirst_js_1.collectCommentsBreadthFirst)(story.kids, limit, {
        maxDepth,
    });
    const out = [];
    for (const commentId of commentIds) {
        const item = itemsById.get(commentId);
        if (!item || item.deleted || item.dead || item.type !== "comment" || !item.text) {
            continue;
        }
        const plain = (0, htmlToPlainText_js_1.htmlToPlainText)(item.text).trim().slice(0, MAX_TEXT_LEN);
        if (!plain)
            continue;
        out.push({ commentId, text: plain });
    }
    return out;
}
function normalizePercents(p, n, c) {
    const clip = (x) => Math.max(0, Math.min(100, Math.round(Number.isFinite(x) ? x : 0)));
    let a = clip(p);
    let b = clip(n);
    let d = clip(c);
    const sum = a + b + d;
    if (sum === 100)
        return { p: a, n: b, c: d };
    if (sum <= 0)
        return { p: 34, n: 33, c: 33 };
    a = Math.round((a * 100) / sum);
    b = Math.round((b * 100) / sum);
    d = 100 - a - b;
    return { p: a, n: b, c: Math.max(0, d) };
}
function coerceTrendJson(obj) {
    if (typeof obj !== "object" || obj === null) {
        throw new https_1.HttpsError("internal", "trend json invalid");
    }
    const m = obj;
    const num = (v) => {
        if (typeof v === "number" && Number.isFinite(v))
            return v;
        if (typeof v === "string" && v.trim() !== "") {
            const x = Number(v);
            return Number.isFinite(x) ? x : 0;
        }
        return 0;
    };
    const str = (camel, snake) => {
        const v = m[camel] ?? m[snake];
        return typeof v === "string" ? v.trim() : "";
    };
    const p = num(m.positivePercent ?? m.positive_percent);
    const n = num(m.neutralPercent ?? m.neutral_percent);
    const c = num(m.criticalPercent ?? m.critical_percent);
    const { p: pn, n: nn, c: cn } = normalizePercents(p, n, c);
    const kwRaw = m.keywords ?? m.keyword_list;
    const keywords = [];
    if (Array.isArray(kwRaw)) {
        for (const k of kwRaw) {
            if (keywords.length >= 16)
                break;
            if (typeof k !== "string")
                continue;
            const t = k.trim();
            if (t)
                keywords.push(t.slice(0, 40));
        }
    }
    return {
        positivePercent: pn,
        neutralPercent: nn,
        criticalPercent: cn,
        positiveOpinion: str("positiveOpinion", "positive_opinion"),
        neutralOpinion: str("neutralOpinion", "neutral_opinion"),
        criticalOpinion: str("criticalOpinion", "critical_opinion"),
        keywords,
    };
}
const SYSTEM_PROMPT = `あなたは Hacker News コメント欄の編集アナリストです。
与えられたコメント一覧のみに基づき、全体の傾向を日本語で要約してください。
コメントに現れない主張や個人名・誹謗の新規生成は禁止です。
出力は次の JSON オブジェクトのみ（前後に説明文やコードフェンスを付けない）:
{
  "positivePercent": <0-100の整数>,
  "neutralPercent": <0-100の整数>,
  "criticalPercent": <0-100の整数>,
  "positiveOpinion": "<肯定的な立場の要約を日本語1文>",
  "neutralOpinion": "<事実提示・条件付き・様子見など中立的な要約を日本語1文>",
  "criticalOpinion": "<懸念・反論・批判的な要約を日本語1文>",
  "keywords": ["<名詞句>", ...]
}
positivePercent + neutralPercent + criticalPercent は必ず 100。
keywords は 5〜12 個程度の名詞句（日本語可）。`;
/** Callable: 上位コメントをまとめて 1 往復の LLM で傾向（％・意見・キーワード）を返す。 */
exports.analyzeHnCommentTrends = (0, https_1.onCall)({
    region: "asia-northeast1",
    timeoutSeconds: 90,
    memory: "512MiB",
    maxInstances: 20,
    enforceAppCheck: enforceAppCheckAnalyzeTrends,
    secrets: [config_js_1.ANTHROPIC_API_KEY],
}, async (request) => {
    const payload = assertPayload(request.data);
    const tier = await (0, commentCallableTier_js_1.resolveCommentCallableBfsTier)(request);
    const limit = Math.min(payload.limit ?? tier.maxCount, tier.maxCount);
    const fromClient = parseCommentSnippets(payload.comments, tier.maxCount);
    let snippets;
    /** クライアント任意コメントは入力が不定のため hn_items キャッシュの対象外 */
    let cacheEligible = false;
    if (fromClient) {
        snippets = fromClient.slice(0, limit);
    }
    else {
        snippets = await loadSnippetsFromHn(payload.storyId, limit, tier.maxDepth);
        cacheEligible = true;
    }
    if (snippets.length === 0) {
        logger.info("analyzeHnCommentTrends.empty", { storyId: payload.storyId });
        return { storyId: payload.storyId, trend: null };
    }
    const firestore = admin.firestore();
    const hnRef = firestore.collection(firestoreCollections_js_1.HN_ITEMS_COLLECTION).doc(String(payload.storyId));
    const cacheField = commentTrendsCacheFieldName(tier.kind);
    const ttlMs = config_js_1.TRENDS_CACHE_TTL_HOURS * 60 * 60 * 1000;
    const expiresBefore = Date.now() - ttlMs;
    if (cacheEligible) {
        const hnSnap = await hnRef.get();
        const cached = hnSnap.data()?.[cacheField];
        if (cached?.trend &&
            cached.cached_at &&
            typeof cached.limit === "number" &&
            typeof cached.max_depth === "number" &&
            cached.limit === limit &&
            cached.max_depth === tier.maxDepth &&
            cached.cached_at.toMillis() > expiresBefore) {
            logger.info("analyzeHnCommentTrends.cacheHit", {
                storyId: payload.storyId,
                tier: tier.kind,
            });
            return { storyId: payload.storyId, trend: cached.trend };
        }
    }
    const apiKey = config_js_1.ANTHROPIC_API_KEY.value();
    if (!apiKey) {
        throw new https_1.HttpsError("failed-precondition", "ANTHROPIC_API_KEY is not set");
    }
    const numbered = snippets.map((s, i) => `${i + 1}. (id:${s.commentId}) ${s.text}`).join("\n\n");
    const user = [
        `storyId: ${payload.storyId}`,
        `以下は分析対象のコメント（全${snippets.length}件）です。`,
        "",
        numbered,
    ].join("\n");
    logger.info("analyzeHnCommentTrends.start", {
        storyId: payload.storyId,
        snippetCount: snippets.length,
    });
    const { text } = await (0, anthropic_js_1.completeClaudeWithSystem)({
        apiKey,
        system: SYSTEM_PROMPT,
        user,
        maxTokens: 1200,
    });
    let parsed;
    try {
        parsed = (0, extractJsonObject_js_1.extractJsonObject)(text);
    }
    catch (e) {
        logger.error("analyzeHnCommentTrends.jsonParseFailed", {
            storyId: payload.storyId,
            err: String(e),
            sample: text.slice(0, 400),
        });
        throw new https_1.HttpsError("internal", "failed to parse model output");
    }
    const trend = coerceTrendJson(parsed);
    if (cacheEligible) {
        try {
            await hnRef.set({
                [cacheField]: {
                    trend,
                    cached_at: admin.firestore.FieldValue.serverTimestamp(),
                    ttl_hours: config_js_1.TRENDS_CACHE_TTL_HOURS,
                    limit,
                    max_depth: tier.maxDepth,
                },
            }, { merge: true });
        }
        catch (e) {
            logger.warn("analyzeHnCommentTrends.cacheWriteFailed", {
                storyId: payload.storyId,
                err: String(e),
            });
        }
    }
    return {
        storyId: payload.storyId,
        trend,
    };
});
//# sourceMappingURL=analyzeHnCommentTrends.js.map