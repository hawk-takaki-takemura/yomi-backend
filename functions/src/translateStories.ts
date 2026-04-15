import * as admin from "firebase-admin";
import {HttpsError, onCall} from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";

import {translateTitlesWithClaude} from "./anthropic.js";
import {
  ANTHROPIC_API_KEY,
  CACHE_TTL_HOURS,
  CLAUDE_MODEL,
  MAX_STORIES_PER_REQUEST,
  MAX_TITLE_LENGTH,
} from "./config.js";

type TranslateStoriesRequest = {
  stories: Record<string, string>;
  lang?: string;
};

type TranslationDoc = {
  story_id: number;
  translated_title: string;
  cached_at: FirebaseFirestore.Timestamp;
  source_model?: string;
  ttl_hours?: number;
};

function assertPayload(data: unknown): TranslateStoriesRequest {
  if (typeof data !== "object" || data === null) {
    throw new HttpsError("invalid-argument", "payload must be object");
  }
  const candidate = data as Partial<TranslateStoriesRequest>;
  if (!candidate.stories || typeof candidate.stories !== "object") {
    throw new HttpsError("invalid-argument", "stories is required");
  }
  if (Object.keys(candidate.stories).length === 0) {
    throw new HttpsError("invalid-argument", "stories must not be empty");
  }
  if (Object.keys(candidate.stories).length > MAX_STORIES_PER_REQUEST) {
    throw new HttpsError("invalid-argument", "stories exceeds limit");
  }

  const normalized: Record<string, string> = {};
  for (const [id, rawTitle] of Object.entries(candidate.stories)) {
    if (!/^\d+$/.test(id)) {
      throw new HttpsError("invalid-argument", "story id must be numeric");
    }
    if (typeof rawTitle !== "string") {
      throw new HttpsError("invalid-argument", "title must be string");
    }
    const title = rawTitle.trim();
    if (!title) {
      throw new HttpsError("invalid-argument", "title must not be empty");
    }
    if (title.length > MAX_TITLE_LENGTH) {
      throw new HttpsError("invalid-argument", "title exceeds max length");
    }
    normalized[id] = title;
  }

  return {
    stories: normalized,
    lang: candidate.lang,
  };
}

/** Callable: translate story titles with Firestore cache (24h TTL). */
export const translateStories = onCall(
  {
    region: "asia-northeast1",
    timeoutSeconds: 60,
    memory: "256MiB",
    maxInstances: 20,
    enforceAppCheck: true,
    secrets: [ANTHROPIC_API_KEY],
  },
  async (request) => {
    const payload = assertPayload(request.data);
    logger.info("translateStories.start", {
      storyCount: Object.keys(payload.stories).length,
      lang: payload.lang?.trim() || "ja",
    });
    const lang = payload.lang?.trim() || "ja";
    const firestore = admin.firestore();
    const now = admin.firestore.Timestamp.now();
    const expiresBefore = now.toMillis() - CACHE_TTL_HOURS * 60 * 60 * 1000;

    const cachedResult: Record<string, string> = {};
    const needTranslation: Record<string, string> = {};

    await Promise.all(
      Object.entries(payload.stories).map(async ([storyId, title]) => {
        const docRef = firestore
          .collection("translations")
          .doc(lang)
          .collection("stories")
          .doc(storyId);
        const snap = await docRef.get();
        if (!snap.exists) {
          needTranslation[storyId] = title;
          return;
        }

        const data = snap.data() as Partial<TranslationDoc> | undefined;
        const cachedAt = data?.cached_at;
        const translatedTitle = data?.translated_title;
        if (!translatedTitle || !cachedAt || cachedAt.toMillis() < expiresBefore) {
          needTranslation[storyId] = title;
          return;
        }
        cachedResult[storyId] = translatedTitle;
      }),
    );

    let translatedCount = 0;
    if (Object.keys(needTranslation).length > 0) {
      const apiKey = ANTHROPIC_API_KEY.value();
      if (!apiKey) {
        throw new HttpsError("failed-precondition", "ANTHROPIC_API_KEY is not set");
      }
      const translated = await translateTitlesWithClaude(needTranslation, lang, apiKey);
      translatedCount = Object.keys(translated).length;

      const batch = firestore.batch();
      for (const [storyId, translatedTitle] of Object.entries(translated)) {
        cachedResult[storyId] = translatedTitle;
        const docRef = firestore
          .collection("translations")
          .doc(lang)
          .collection("stories")
          .doc(storyId);
        const doc: TranslationDoc = {
          story_id: Number(storyId),
          translated_title: translatedTitle,
          cached_at: now,
          source_model: CLAUDE_MODEL,
          ttl_hours: CACHE_TTL_HOURS,
        };
        batch.set(docRef, doc, {merge: true});
      }
      await batch.commit();
    }

    return {
      translations: cachedResult,
      cachedCount: Object.keys(cachedResult).length - translatedCount,
      translatedCount,
    };
  },
);
