import * as admin from "firebase-admin";
import {HttpsError, onCall} from "firebase-functions/v2/https";
import {defineSecret} from "firebase-functions/params";
import * as logger from "firebase-functions/logger";

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
const CLAUDE_MODEL = "claude-haiku-4-5-20251001";
const CACHE_TTL_HOURS = 24;
const MAX_STORIES_PER_REQUEST = 20;
const MAX_TITLE_LENGTH = 200;

if (!admin.apps.length) {
  admin.initializeApp();
}

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

async function translateWithClaude(
  stories: Record<string, string>,
  lang: string,
  apiKey: string,
): Promise<Record<string, string>> {
  const lines = Object.entries(stories).map(([id, title]) => `ID: ${id}: ${title}`);
  const prompt = [
    `Translate the following English titles to ${lang} language.`,
    'Return ONLY in the format "ID: <number>: <translated title>", one per line.',
    "No explanation needed.",
    "",
    ...lines,
  ].join("\n");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 2048,
      messages: [{role: "user", content: prompt}],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new HttpsError("internal", `claude failed: ${response.status} ${body}`);
  }

  const data = await response.json() as { content?: Array<{text?: string}> };
  const text = data.content?.[0]?.text;
  if (!text) {
    throw new HttpsError("internal", "claude response is empty");
  }

  const parsed: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^ID:\s*/i, "");
    const sep = line.indexOf(": ");
    if (sep <= 0) continue;
    const id = line.slice(0, sep).trim();
    const title = line.slice(sep + 2).trim();
    if (id && title) parsed[id] = title;
  }
  return parsed;
}

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
      const translated = await translateWithClaude(needTranslation, lang, apiKey);
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
