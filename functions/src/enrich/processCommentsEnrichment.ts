import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";

import {completeClaudeWithSystem} from "../anthropic.js";
import {
  CLAUDE_MODEL,
  COMMENT_ENRICH_MAX_COUNT,
  COMMENT_ENRICH_BFS_MAX_DEPTH,
  COMMENT_ENRICH_MAX_TEXT_CHARS,
  COMMENT_ENRICH_MIN_DESCENDANTS,
  COMMENT_ENRICH_MIN_SCORE,
} from "../config.js";
import {COMMENT_ENRICH_V1_SYSTEM_PROMPT} from "../prompts/commentEnrichV1System.js";
import {buildCommentEnrichUserMessage} from "./buildCommentEnrichUserMessage.js";
import {parseAndNormalizeCommentsEnrichmentV1} from "./commentEnrichmentTypes.js";
import {extractJsonObject} from "./extractJsonObject.js";
import {htmlToPlainText} from "./htmlToPlainText.js";
import {HN_ITEMS_COLLECTION} from "../firestoreCollections.js";
import {collectCommentsBreadthFirst} from "../hn/collectCommentsBreadthFirst.js";
import {isStoryHiddenByModeration} from "../hn/storyPolicy.js";
import type {HnItem} from "../hn/types.js";

/**
 * 記事 enrich 成功後にベストエフォートで実行する。
 * 失敗しても例外は投げない（記事側の completed は維持）。
 */
export async function tryProcessAndPersistCommentsEnrichment(args: {
  firestore: FirebaseFirestore.Firestore;
  storyId: number;
  item: HnItem;
  title: string;
  apiKey: string;
}): Promise<void> {
  const {firestore, storyId, item, title, apiKey} = args;

  if (isStoryHiddenByModeration(item)) {
    return;
  }
  const score = typeof item.score === "number" && Number.isFinite(item.score) ? item.score : 0;
  const descendants =
    typeof item.descendants === "number" && Number.isFinite(item.descendants)
      ? item.descendants
      : 0;
  if (score < COMMENT_ENRICH_MIN_SCORE || descendants < COMMENT_ENRICH_MIN_DESCENDANTS) {
    return;
  }
  if (!Array.isArray(item.kids) || item.kids.length === 0) {
    return;
  }

  let commentIds: number[];
  let itemsById: Map<number, HnItem>;
  try {
    const bfs = await collectCommentsBreadthFirst(item.kids, COMMENT_ENRICH_MAX_COUNT, {
      maxDepth: COMMENT_ENRICH_BFS_MAX_DEPTH,
    });
    commentIds = bfs.commentIds;
    itemsById = bfs.itemsById;
  } catch (e) {
    logger.warn("commentsEnrichment.bfsFailed", {storyId, err: String(e)});
    return;
  }

  const snippets: {commentId: number; text: string}[] = [];
  for (const commentId of commentIds) {
    const c = itemsById.get(commentId);
    if (!c || c.deleted || c.dead || c.type !== "comment" || !c.text) {
      continue;
    }
    const plain = htmlToPlainText(c.text).trim().slice(0, COMMENT_ENRICH_MAX_TEXT_CHARS);
    if (!plain) continue;
    snippets.push({commentId, text: plain});
  }
  if (snippets.length === 0) {
    return;
  }

  const user = buildCommentEnrichUserMessage({storyId, title, snippets});

  let text: string;
  try {
    const res = await completeClaudeWithSystem({
      apiKey,
      system: COMMENT_ENRICH_V1_SYSTEM_PROMPT,
      user,
      maxTokens: 2048,
    });
    text = res.text;
  } catch (e) {
    logger.warn("commentsEnrichment.claudeFailed", {storyId, err: String(e)});
    return;
  }

  let normalized;
  try {
    const raw = extractJsonObject(text);
    normalized = parseAndNormalizeCommentsEnrichmentV1(raw);
  } catch (e) {
    logger.warn("commentsEnrichment.parseFailed", {
      storyId,
      err: String(e),
      sample: text.slice(0, 400),
    });
    return;
  }

  const hnRef = firestore.collection(HN_ITEMS_COLLECTION).doc(String(storyId));
  const now = admin.firestore.FieldValue.serverTimestamp();
  try {
    await hnRef.set(
      {
        comments_enrichment: {
          ...normalized,
          analyzed_at: now,
          source_model: CLAUDE_MODEL,
        },
      },
      {merge: true},
    );
    logger.info("commentsEnrichment.saved", {storyId, snippetCount: snippets.length});
  } catch (e) {
    logger.warn("commentsEnrichment.firestoreFailed", {storyId, err: String(e)});
  }
}
