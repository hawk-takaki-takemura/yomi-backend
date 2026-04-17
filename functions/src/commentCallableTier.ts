import * as admin from "firebase-admin";
import {CallableRequest} from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";

import {
  COMMENT_CALLABLE_FREE_BFS_MAX_DEPTH,
  COMMENT_CALLABLE_FREE_MAX_COUNT,
  COMMENT_CALLABLE_PREMIUM_BFS_MAX_DEPTH,
  COMMENT_CALLABLE_PREMIUM_MAX_COUNT,
} from "./config.js";

export type CommentCallableBfsTier = {
  maxCount: number;
  maxDepth: number;
  /** Firestore キャッシュ等のキー分離用 */
  kind: "free" | "premium";
};

/**
 * `translateHnComments` / `analyzeHnCommentTrends` など、HN コメント BFS のティア別上限。
 * 無料・匿名: 件数少・浅め（概観）。プレミアム: 件数多・深め（深い議論まで）。
 */
export async function resolveCommentCallableBfsTier(
  request: CallableRequest,
): Promise<CommentCallableBfsTier> {
  const uid = request.auth?.uid;
  if (!uid) {
    return {
      maxCount: COMMENT_CALLABLE_FREE_MAX_COUNT,
      maxDepth: COMMENT_CALLABLE_FREE_BFS_MAX_DEPTH,
      kind: "free",
    };
  }
  try {
    const snap = await admin.firestore().collection("users").doc(uid).get();
    const isPremium = snap.exists && snap.data()?.isPremium === true;
    if (isPremium) {
      return {
        maxCount: COMMENT_CALLABLE_PREMIUM_MAX_COUNT,
        maxDepth: COMMENT_CALLABLE_PREMIUM_BFS_MAX_DEPTH,
        kind: "premium",
      };
    }
  } catch (e) {
    logger.warn("commentCallableTier.premiumLookupFailed", {uid, err: String(e)});
  }
  return {
    maxCount: COMMENT_CALLABLE_FREE_MAX_COUNT,
    maxDepth: COMMENT_CALLABLE_FREE_BFS_MAX_DEPTH,
    kind: "free",
  };
}
