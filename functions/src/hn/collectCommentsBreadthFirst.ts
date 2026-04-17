import {fetchItemsInBatches} from "./client.js";
import type {HnItem} from "./types.js";

const HN_BFS_FETCH_CONCURRENCY = 12;

type QueuedNode = {id: number; depth: number};

export type CollectCommentsBreadthFirstOptions = {
  /**
   * ストーリ直下の `kids` を深さ 0 とする。子は `depth+1`。
   * 指定時、子の enqueue は `depth <= maxDepth` のときのみ（子は `parentDepth+1` が上限を超えない場合のみキューへ）。
   * 省略時は深さ無制限（従来どおり）。
   */
  maxDepth?: number;
};

/**
 * ストーリ直下から BFS でコメントを収集。各層は `fetchItemsInBatches` で並列取得し、
 * 収集したコメント本文用の `HnItem` を二重フェッチしないよう返す。
 */
export async function collectCommentsBreadthFirst(
  rootIds: number[],
  limit: number,
  options?: CollectCommentsBreadthFirstOptions,
): Promise<{commentIds: number[]; itemsById: Map<number, HnItem>}> {
  const maxDepth = options?.maxDepth;
  const queue: QueuedNode[] = [];
  for (const id of rootIds) {
    if (typeof id === "number" && id > 0) {
      queue.push({id, depth: 0});
    }
  }
  const visited = new Set<number>();
  const commentIds: number[] = [];
  const itemsById = new Map<number, HnItem>();

  while (queue.length > 0 && commentIds.length < limit) {
    const wave: QueuedNode[] = [];
    while (
      queue.length > 0 &&
      wave.length < HN_BFS_FETCH_CONCURRENCY &&
      commentIds.length < limit
    ) {
      const next = queue.shift();
      if (!next || visited.has(next.id)) {
        continue;
      }
      visited.add(next.id);
      wave.push(next);
    }
    if (wave.length === 0) {
      break;
    }

    const waveIds = wave.map((w) => w.id);
    const fetched = await fetchItemsInBatches(waveIds, HN_BFS_FETCH_CONCURRENCY);

    for (const {id, depth} of wave) {
      if (commentIds.length >= limit) {
        break;
      }
      const item = fetched.get(id);
      if (!item || item.deleted || item.dead) {
        continue;
      }
      if (item.type === "comment") {
        commentIds.push(id);
        itemsById.set(id, item);
      }
      if (Array.isArray(item.kids)) {
        const childDepth = depth + 1;
        if (maxDepth !== undefined && childDepth > maxDepth) {
          continue;
        }
        for (const kid of item.kids) {
          if (typeof kid === "number" && kid > 0 && !visited.has(kid)) {
            queue.push({id: kid, depth: childDepth});
          }
        }
      }
    }
  }
  return {commentIds, itemsById};
}
