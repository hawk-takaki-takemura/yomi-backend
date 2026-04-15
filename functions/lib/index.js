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
exports.translateStories = void 0;
const admin = __importStar(require("firebase-admin"));
const https_1 = require("firebase-functions/v2/https");
const params_1 = require("firebase-functions/params");
const logger = __importStar(require("firebase-functions/logger"));
const ANTHROPIC_API_KEY = (0, params_1.defineSecret)("ANTHROPIC_API_KEY");
const CLAUDE_MODEL = "claude-haiku-4-5-20251001";
const CACHE_TTL_HOURS = 24;
const MAX_STORIES_PER_REQUEST = 20;
const MAX_TITLE_LENGTH = 200;
if (!admin.apps.length) {
    admin.initializeApp();
}
function assertPayload(data) {
    if (typeof data !== "object" || data === null) {
        throw new https_1.HttpsError("invalid-argument", "payload must be object");
    }
    const candidate = data;
    if (!candidate.stories || typeof candidate.stories !== "object") {
        throw new https_1.HttpsError("invalid-argument", "stories is required");
    }
    if (Object.keys(candidate.stories).length === 0) {
        throw new https_1.HttpsError("invalid-argument", "stories must not be empty");
    }
    if (Object.keys(candidate.stories).length > MAX_STORIES_PER_REQUEST) {
        throw new https_1.HttpsError("invalid-argument", "stories exceeds limit");
    }
    const normalized = {};
    for (const [id, rawTitle] of Object.entries(candidate.stories)) {
        if (!/^\d+$/.test(id)) {
            throw new https_1.HttpsError("invalid-argument", "story id must be numeric");
        }
        if (typeof rawTitle !== "string") {
            throw new https_1.HttpsError("invalid-argument", "title must be string");
        }
        const title = rawTitle.trim();
        if (!title) {
            throw new https_1.HttpsError("invalid-argument", "title must not be empty");
        }
        if (title.length > MAX_TITLE_LENGTH) {
            throw new https_1.HttpsError("invalid-argument", "title exceeds max length");
        }
        normalized[id] = title;
    }
    return {
        stories: normalized,
        lang: candidate.lang,
    };
}
async function translateWithClaude(stories, lang, apiKey) {
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
            messages: [{ role: "user", content: prompt }],
        }),
    });
    if (!response.ok) {
        const body = await response.text();
        throw new https_1.HttpsError("internal", `claude failed: ${response.status} ${body}`);
    }
    const data = await response.json();
    const text = data.content?.[0]?.text;
    if (!text) {
        throw new https_1.HttpsError("internal", "claude response is empty");
    }
    const parsed = {};
    for (const raw of text.split("\n")) {
        const line = raw.trim().replace(/^ID:\s*/i, "");
        const sep = line.indexOf(": ");
        if (sep <= 0)
            continue;
        const id = line.slice(0, sep).trim();
        const title = line.slice(sep + 2).trim();
        if (id && title)
            parsed[id] = title;
    }
    return parsed;
}
exports.translateStories = (0, https_1.onCall)({
    region: "asia-northeast1",
    timeoutSeconds: 60,
    memory: "256MiB",
    maxInstances: 20,
    enforceAppCheck: true,
    secrets: [ANTHROPIC_API_KEY],
}, async (request) => {
    const payload = assertPayload(request.data);
    logger.info("translateStories.start", {
        storyCount: Object.keys(payload.stories).length,
        lang: payload.lang?.trim() || "ja",
    });
    const lang = payload.lang?.trim() || "ja";
    const firestore = admin.firestore();
    const now = admin.firestore.Timestamp.now();
    const expiresBefore = now.toMillis() - CACHE_TTL_HOURS * 60 * 60 * 1000;
    const cachedResult = {};
    const needTranslation = {};
    await Promise.all(Object.entries(payload.stories).map(async ([storyId, title]) => {
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
        const data = snap.data();
        const cachedAt = data?.cached_at;
        const translatedTitle = data?.translated_title;
        if (!translatedTitle || !cachedAt || cachedAt.toMillis() < expiresBefore) {
            needTranslation[storyId] = title;
            return;
        }
        cachedResult[storyId] = translatedTitle;
    }));
    let translatedCount = 0;
    if (Object.keys(needTranslation).length > 0) {
        const apiKey = ANTHROPIC_API_KEY.value();
        if (!apiKey) {
            throw new https_1.HttpsError("failed-precondition", "ANTHROPIC_API_KEY is not set");
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
            const doc = {
                story_id: Number(storyId),
                translated_title: translatedTitle,
                cached_at: now,
                source_model: CLAUDE_MODEL,
                ttl_hours: CACHE_TTL_HOURS,
            };
            batch.set(docRef, doc, { merge: true });
        }
        await batch.commit();
    }
    return {
        translations: cachedResult,
        cachedCount: Object.keys(cachedResult).length - translatedCount,
        translatedCount,
    };
});
//# sourceMappingURL=index.js.map