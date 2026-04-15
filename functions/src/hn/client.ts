import * as logger from "firebase-functions/logger";

import type {HnItem} from "./types.js";

const HN_BASE = "https://hacker-news.firebaseio.com/v0";

async function fetchJson<T>(path: string): Promise<T | null> {
  const url = `${HN_BASE}${path}`;
  const res = await fetch(url);
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HN fetch failed ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/** topstories の id 一覧（新しい順ではなく人気スコアベースのランキング） */
export async function fetchTopStoryIds(): Promise<number[]> {
  const ids = await fetchJson<number[]>("/topstories.json");
  if (!ids || !Array.isArray(ids)) {
    throw new Error("HN topstories.json invalid");
  }
  return ids;
}

export async function fetchItem(id: number): Promise<HnItem | null> {
  return fetchJson<HnItem>(`/item/${id}.json`);
}

/**
 * 並列度を抑えつつ item を取得する。
 * 失敗した id はスキップし、ログに残す（1件で全体を落とさない）。
 */
export async function fetchItemsInBatches(
  ids: number[],
  concurrency: number,
): Promise<Map<number, HnItem>> {
  const result = new Map<number, HnItem>();
  for (let i = 0; i < ids.length; i += concurrency) {
    const chunk = ids.slice(i, i + concurrency);
    const settled = await Promise.allSettled(chunk.map((id) => fetchItem(id)));
    for (let j = 0; j < chunk.length; j++) {
      const id = chunk[j];
      const outcome = settled[j];
      if (
        outcome.status === "fulfilled" &&
        outcome.value &&
        !outcome.value.deleted &&
        !outcome.value.dead
      ) {
        result.set(id, outcome.value);
      } else if (outcome.status === "rejected") {
        logger.warn("hn.fetchItem failed", {id, err: String(outcome.reason)});
      }
    }
  }
  return result;
}
