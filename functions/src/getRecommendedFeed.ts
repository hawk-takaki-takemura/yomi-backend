import * as admin from "firebase-admin";
import {HttpsError, onCall} from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";

import {HN_ITEMS_COLLECTION} from "./firestoreCollections.js";

const MAX_LIMIT = 60;
const DEFAULT_LIMIT = 30;
const QUERY_POOL = 120;

/** Flutter `TopicGenre.name` と enrich V1 タグの対応 */
const GENRE_TO_TAGS: Record<string, readonly string[]> = {
  ai: ["AI/LLM"],
  startup: ["Startup/Business"],
  webDev: ["WebDev", "Programming"],
  mobile: ["Mobile"],
  security: ["Security"],
  science: ["Science"],
};

type RecommendedFeedRequest = {
  genres?: unknown;
  limit?: unknown;
};

type StoryEnrichmentV1 = {
  schema_version: 1;
  title_ja: string;
  summary_short: string;
  summary_points: string[];
  tags: string[];
  hot_topic_score: number;
  confidence_score: number;
};

function assertPayload(data: unknown): {genres: string[]; limit: number} {
  if (typeof data !== "object" || data === null) {
    throw new HttpsError("invalid-argument", "payload must be object");
  }
  const candidate = data as RecommendedFeedRequest;
  const rawGenres = candidate.genres;
  if (!Array.isArray(rawGenres) || rawGenres.length === 0) {
    throw new HttpsError("invalid-argument", "genres must be a non-empty array");
  }
  const genres: string[] = [];
  for (const g of rawGenres) {
    if (typeof g !== "string" || !g.trim()) {
      throw new HttpsError("invalid-argument", "genre must be non-empty string");
    }
    genres.push(g.trim());
  }
  if (genres.length > 20) {
    throw new HttpsError("invalid-argument", "too many genres");
  }

  let limit = DEFAULT_LIMIT;
  if (candidate.limit !== undefined && candidate.limit !== null) {
    if (typeof candidate.limit !== "number" || !Number.isFinite(candidate.limit)) {
      throw new HttpsError("invalid-argument", "limit must be a number");
    }
    limit = Math.floor(candidate.limit);
    if (limit < 1 || limit > MAX_LIMIT) {
      throw new HttpsError("invalid-argument", `limit must be 1..${MAX_LIMIT}`);
    }
  }

  return {genres, limit};
}

function unionTagsForGenres(genres: string[]): string[] {
  const out = new Set<string>();
  for (const g of genres) {
    const tags = GENRE_TO_TAGS[g];
    if (!tags) {
      logger.warn("getRecommendedFeed.unknown_genre", {genre: g});
      continue;
    }
    for (const t of tags) {
      out.add(t);
    }
  }
  return [...out];
}

function timeToUnixSeconds(
  raw: FirebaseFirestore.Timestamp | number | undefined,
): number {
  if (raw === undefined) return 0;
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.floor(raw);
  if (raw instanceof admin.firestore.Timestamp) return raw.seconds;
  return 0;
}

function serializeDoc(doc: FirebaseFirestore.QueryDocumentSnapshot): Record<string, unknown> {
  const d = doc.data();
  const enrichRaw = d.enrichment as Record<string, unknown> | undefined;
  let enrichment: StoryEnrichmentV1 | undefined;
  if (
    enrichRaw &&
    enrichRaw.schema_version === 1 &&
    typeof enrichRaw.title_ja === "string" &&
    typeof enrichRaw.summary_short === "string" &&
    Array.isArray(enrichRaw.summary_points) &&
    Array.isArray(enrichRaw.tags) &&
    typeof enrichRaw.hot_topic_score === "number" &&
    typeof enrichRaw.confidence_score === "number"
  ) {
    enrichment = enrichRaw as unknown as StoryEnrichmentV1;
  }

  return {
    id: Number(doc.id),
    title: typeof d.title === "string" ? d.title : "",
    url: d.url ?? null,
    by: typeof d.by === "string" ? d.by : "",
    score: typeof d.score === "number" ? d.score : 0,
    descendants: typeof d.descendants === "number" ? d.descendants : 0,
    time: timeToUnixSeconds(d.time as FirebaseFirestore.Timestamp | number | undefined),
    type: typeof d.type === "string" ? d.type : "story",
    enrich_status: typeof d.enrich_status === "string" ? d.enrich_status : "idle",
    enrichment: enrichment ?? null,
  };
}

function rankScore(d: FirebaseFirestore.DocumentData): number {
  const enrich = d.enrichment as {hot_topic_score?: number} | undefined;
  const hot = typeof enrich?.hot_topic_score === "number" ? enrich.hot_topic_score : 0;
  const score = typeof d.score === "number" ? d.score : 0;
  return hot * 10_000 + score;
}

/**
 * Callable: ジャンルに沿ったおすすめ記事一覧（Firestore `hn_items` の enrich 済みを主に使用）。
 * クライアントは即時表示したい場合に先に HN 生を出し、後から差し替える用途にも使える。
 */
export const getRecommendedFeed = onCall(
  {
    region: "asia-northeast1",
    timeoutSeconds: 30,
    memory: "256MiB",
    maxInstances: 20,
    enforceAppCheck: true,
  },
  async (request) => {
    const {genres, limit} = assertPayload(request.data);
    const tagUnion = unionTagsForGenres(genres);
    if (tagUnion.length === 0) {
      throw new HttpsError("invalid-argument", "no known genres after normalization");
    }
    if (tagUnion.length > 10) {
      throw new HttpsError(
        "failed-precondition",
        "internal: genre tag union exceeds Firestore array-contains-any limit",
      );
    }

    const firestore = admin.firestore();
    const snap = await firestore
      .collection(HN_ITEMS_COLLECTION)
      .where("enrich_status", "==", "completed")
      .where("enrichment.tags", "array-contains-any", tagUnion)
      .limit(QUERY_POOL)
      .get();

    const docs = [...snap.docs];
    docs.sort((a, b) => rankScore(b.data()) - rankScore(a.data()));

    const sliced = docs.slice(0, limit);
    const stories = sliced.map((doc) => serializeDoc(doc));

    logger.info("getRecommendedFeed.done", {
      genres,
      limit,
      tagUnion,
      matched: docs.length,
      returned: stories.length,
    });

    return {
      stories,
      matchedCount: docs.length,
      returnedCount: stories.length,
    };
  },
);
