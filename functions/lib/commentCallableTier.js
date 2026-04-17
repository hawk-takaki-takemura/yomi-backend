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
exports.resolveCommentCallableBfsTier = resolveCommentCallableBfsTier;
const admin = __importStar(require("firebase-admin"));
const logger = __importStar(require("firebase-functions/logger"));
const config_js_1 = require("./config.js");
/**
 * `translateHnComments` / `analyzeHnCommentTrends` など、HN コメント BFS のティア別上限。
 * 無料・匿名: 件数少・浅め（概観）。プレミアム: 件数多・深め（深い議論まで）。
 */
async function resolveCommentCallableBfsTier(request) {
    const uid = request.auth?.uid;
    if (!uid) {
        return {
            maxCount: config_js_1.COMMENT_CALLABLE_FREE_MAX_COUNT,
            maxDepth: config_js_1.COMMENT_CALLABLE_FREE_BFS_MAX_DEPTH,
        };
    }
    try {
        const snap = await admin.firestore().collection("users").doc(uid).get();
        const isPremium = snap.exists && snap.data()?.isPremium === true;
        if (isPremium) {
            return {
                maxCount: config_js_1.COMMENT_CALLABLE_PREMIUM_MAX_COUNT,
                maxDepth: config_js_1.COMMENT_CALLABLE_PREMIUM_BFS_MAX_DEPTH,
            };
        }
    }
    catch (e) {
        logger.warn("commentCallableTier.premiumLookupFailed", { uid, err: String(e) });
    }
    return {
        maxCount: config_js_1.COMMENT_CALLABLE_FREE_MAX_COUNT,
        maxDepth: config_js_1.COMMENT_CALLABLE_FREE_BFS_MAX_DEPTH,
    };
}
//# sourceMappingURL=commentCallableTier.js.map