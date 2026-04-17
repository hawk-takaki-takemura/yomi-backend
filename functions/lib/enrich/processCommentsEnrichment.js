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
exports.tryProcessAndPersistCommentsEnrichment = tryProcessAndPersistCommentsEnrichment;
const admin = __importStar(require("firebase-admin"));
const logger = __importStar(require("firebase-functions/logger"));
const anthropic_js_1 = require("../anthropic.js");
const config_js_1 = require("../config.js");
const commentEnrichV1System_js_1 = require("../prompts/commentEnrichV1System.js");
const buildCommentEnrichUserMessage_js_1 = require("./buildCommentEnrichUserMessage.js");
const commentEnrichmentTypes_js_1 = require("./commentEnrichmentTypes.js");
const extractJsonObject_js_1 = require("./extractJsonObject.js");
const htmlToPlainText_js_1 = require("./htmlToPlainText.js");
const firestoreCollections_js_1 = require("../firestoreCollections.js");
const collectCommentsBreadthFirst_js_1 = require("../hn/collectCommentsBreadthFirst.js");
const storyPolicy_js_1 = require("../hn/storyPolicy.js");
/**
 * 記事 enrich 成功後にベストエフォートで実行する。
 * 失敗しても例外は投げない（記事側の completed は維持）。
 */
async function tryProcessAndPersistCommentsEnrichment(args) {
    const { firestore, storyId, item, title, apiKey } = args;
    if ((0, storyPolicy_js_1.isStoryHiddenByModeration)(item)) {
        return;
    }
    const score = typeof item.score === "number" && Number.isFinite(item.score) ? item.score : 0;
    const descendants = typeof item.descendants === "number" && Number.isFinite(item.descendants)
        ? item.descendants
        : 0;
    if (score < config_js_1.COMMENT_ENRICH_MIN_SCORE || descendants < config_js_1.COMMENT_ENRICH_MIN_DESCENDANTS) {
        return;
    }
    if (!Array.isArray(item.kids) || item.kids.length === 0) {
        return;
    }
    let commentIds;
    let itemsById;
    try {
        const bfs = await (0, collectCommentsBreadthFirst_js_1.collectCommentsBreadthFirst)(item.kids, config_js_1.COMMENT_ENRICH_MAX_COUNT, {
            maxDepth: config_js_1.COMMENT_ENRICH_BFS_MAX_DEPTH,
        });
        commentIds = bfs.commentIds;
        itemsById = bfs.itemsById;
    }
    catch (e) {
        logger.warn("commentsEnrichment.bfsFailed", { storyId, err: String(e) });
        return;
    }
    const snippets = [];
    for (const commentId of commentIds) {
        const c = itemsById.get(commentId);
        if (!c || c.deleted || c.dead || c.type !== "comment" || !c.text) {
            continue;
        }
        const plain = (0, htmlToPlainText_js_1.htmlToPlainText)(c.text).trim().slice(0, config_js_1.COMMENT_ENRICH_MAX_TEXT_CHARS);
        if (!plain)
            continue;
        snippets.push({ commentId, text: plain });
    }
    if (snippets.length === 0) {
        return;
    }
    const user = (0, buildCommentEnrichUserMessage_js_1.buildCommentEnrichUserMessage)({ storyId, title, snippets });
    let text;
    try {
        const res = await (0, anthropic_js_1.completeClaudeWithSystem)({
            apiKey,
            system: commentEnrichV1System_js_1.COMMENT_ENRICH_V1_SYSTEM_PROMPT,
            user,
            maxTokens: 2048,
        });
        text = res.text;
    }
    catch (e) {
        logger.warn("commentsEnrichment.claudeFailed", { storyId, err: String(e) });
        return;
    }
    let normalized;
    try {
        const raw = (0, extractJsonObject_js_1.extractJsonObject)(text);
        normalized = (0, commentEnrichmentTypes_js_1.parseAndNormalizeCommentsEnrichmentV1)(raw);
    }
    catch (e) {
        logger.warn("commentsEnrichment.parseFailed", {
            storyId,
            err: String(e),
            sample: text.slice(0, 400),
        });
        return;
    }
    const hnRef = firestore.collection(firestoreCollections_js_1.HN_ITEMS_COLLECTION).doc(String(storyId));
    const now = admin.firestore.FieldValue.serverTimestamp();
    try {
        await hnRef.set({
            comments_enrichment: {
                ...normalized,
                analyzed_at: now,
                source_model: config_js_1.CLAUDE_MODEL,
            },
        }, { merge: true });
        logger.info("commentsEnrichment.saved", { storyId, snippetCount: snippets.length });
    }
    catch (e) {
        logger.warn("commentsEnrichment.firestoreFailed", { storyId, err: String(e) });
    }
}
//# sourceMappingURL=processCommentsEnrichment.js.map