import * as admin from "firebase-admin";
import {HttpsError, onCall} from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";

import {translateTextsWithClaude} from "./anthropic.js";
import {ANTHROPIC_API_KEY, CACHE_TTL_HOURS, CLAUDE_MODEL} from "./config.js";
import {htmlToPlainText} from "./enrich/htmlToPlainText.js";
import {fetchItem} from "./hn/client.js";

const MAX_COMMENTS_PER_REQUEST = 30;
const MAX_COMMENT_LENGTH = 1200;

/** 本番のみ App Check 必須。stg はエミュレータ・debug token 周りで弾かれやすいため緩める。 */
const projectId =
  process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? "";
const enforceAppCheckTranslateComments = projectId === "yomi-prod";

type TranslateHnCommentsRequest = {
  storyId: number;
  lang?: string;
  limit?: number;
};

type CommentTranslationDoc = {
  comment_id: number;
  story_id: number;
  original_text: string;
  translated_text: string;
  cached_at: FirebaseFirestore.Timestamp;
  source_model?: string;
  ttl_hours?: number;
};

function assertPayload(data: unknown): TranslateHnCommentsRequest {
  if (typeof data !== "object" || data === null) {
    throw new HttpsError("invalid-argument", "payload must be object");
  }
  const candidate = data as Partial<TranslateHnCommentsRequest>;
  if (typeof candidate.storyId !== "number" || !Number.isInteger(candidate.storyId)) {
    throw new HttpsError("invalid-argument", "storyId must be integer");
  }
  if (candidate.storyId <= 0) {
    throw new HttpsError("invalid-argument", "storyId must be positive");
  }

  if (candidate.limit !== undefined) {
    if (typeof candidate.limit !== "number" || !Number.isInteger(candidate.limit)) {
      throw new HttpsError("invalid-argument", "limit must be integer");
    }
    if (candidate.limit <= 0 || candidate.limit > MAX_COMMENTS_PER_REQUEST) {
      throw new HttpsError("invalid-argument", "limit exceeds range");
    }
  }

  return {
    storyId: candidate.storyId,
    lang: candidate.lang,
    limit: candidate.limit,
  };
}

async function collectCommentIdsBreadthFirst(
  rootIds: number[],
  limit: number,
): Promise<number[]> {
  const queue = [...rootIds];
  const visited = new Set<number>();
  const collected: number[] = [];

  while (queue.length > 0 && collected.length < limit) {
    const id = queue.shift();
    if (!id || visited.has(id)) continue;
    visited.add(id);

    const item = await fetchItem(id);
    if (!item || item.deleted || item.dead) {
      continue;
    }
    if (item.type === "comment") {
      collected.push(id);
    }
    if (Array.isArray(item.kids)) {
      for (const kid of item.kids) {
        if (typeof kid === "number" && !visited.has(kid)) {
          queue.push(kid);
        }
      }
    }
  }
  return collected;
}

/** Callable: 上位HNコメントを翻訳して返す（Firestoreキャッシュ付き）。 */
export const translateHnComments = onCall(
  {
    region: "asia-northeast1",
    timeoutSeconds: 60,
    memory: "256MiB",
    maxInstances: 20,
    enforceAppCheck: enforceAppCheckTranslateComments,
    secrets: [ANTHROPIC_API_KEY],
  },
  async (request) => {
    const payload = assertPayload(request.data);
    const lang = payload.lang?.trim() || "ja";
    const limit = payload.limit ?? 20;

    logger.info("translateHnComments.start", {
      storyId: payload.storyId,
      lang,
      limit,
    });

    const story = await fetchItem(payload.storyId);
    if (!story || !Array.isArray(story.kids) || story.kids.length === 0) {
      return {
        storyId: payload.storyId,
        comments: [],
        cachedCount: 0,
        translatedCount: 0,
      };
    }

    const commentIds = await collectCommentIdsBreadthFirst(story.kids, limit);
    const commentItems = await Promise.all(commentIds.map((id) => fetchItem(id)));

    const commentTexts: Record<string, string> = {};
    for (let i = 0; i < commentIds.length; i++) {
      const commentId = commentIds[i];
      const item = commentItems[i];
      if (!item || item.deleted || item.dead || item.type !== "comment" || !item.text) {
        continue;
      }
      const plain = htmlToPlainText(item.text).trim();
      if (!plain) continue;
      commentTexts[String(commentId)] = plain.slice(0, MAX_COMMENT_LENGTH);
    }

    const firestore = admin.firestore();
    const now = admin.firestore.Timestamp.now();
    const expiresBefore = now.toMillis() - CACHE_TTL_HOURS * 60 * 60 * 1000;

    const cachedResult: Record<string, string> = {};
    const needTranslation: Record<string, string> = {};

    await Promise.all(
      Object.entries(commentTexts).map(async ([commentId, text]) => {
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

        const data = snap.data() as Partial<CommentTranslationDoc> | undefined;
        const cachedAt = data?.cached_at;
        const translatedText = data?.translated_text;
        if (!translatedText || !cachedAt || cachedAt.toMillis() < expiresBefore) {
          needTranslation[commentId] = text;
          return;
        }
        cachedResult[commentId] = translatedText;
      }),
    );

    let translatedCount = 0;
    if (Object.keys(needTranslation).length > 0) {
      const apiKey = ANTHROPIC_API_KEY.value();
      if (!apiKey) {
        throw new HttpsError("failed-precondition", "ANTHROPIC_API_KEY is not set");
      }

      const translated = await translateTextsWithClaude(needTranslation, lang, apiKey);
      translatedCount = Object.keys(translated).length;

      const batch = firestore.batch();
      for (const [commentId, translatedText] of Object.entries(translated)) {
        cachedResult[commentId] = translatedText;
        const docRef = firestore
          .collection("translations")
          .doc(lang)
          .collection("comments")
          .doc(commentId);
        const doc: CommentTranslationDoc = {
          comment_id: Number(commentId),
          story_id: payload.storyId,
          original_text: needTranslation[commentId] ?? "",
          translated_text: translatedText,
          cached_at: now,
          source_model: CLAUDE_MODEL,
          ttl_hours: CACHE_TTL_HOURS,
        };
        batch.set(docRef, doc, {merge: true});
      }
      await batch.commit();
    }

    const comments = commentIds
      .map((commentId) => {
        const original = commentTexts[String(commentId)];
        const translated = cachedResult[String(commentId)];
        if (!original || !translated) return null;
        return {
          commentId,
          originalText: original,
          translatedText: translated,
        };
      })
      .filter((v): v is {commentId: number; originalText: string; translatedText: string} => v !== null);

    return {
      storyId: payload.storyId,
      comments,
      cachedCount: Object.keys(cachedResult).length - translatedCount,
      translatedCount,
    };
  },
);
