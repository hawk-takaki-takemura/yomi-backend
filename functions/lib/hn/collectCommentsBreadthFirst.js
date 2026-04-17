"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectCommentsBreadthFirst = collectCommentsBreadthFirst;
const client_js_1 = require("./client.js");
const HN_BFS_FETCH_CONCURRENCY = 12;
/**
 * ストーリ直下から BFS でコメントを収集。各層は `fetchItemsInBatches` で並列取得し、
 * 収集したコメント本文用の `HnItem` を二重フェッチしないよう返す。
 */
async function collectCommentsBreadthFirst(rootIds, limit, options) {
    const maxDepth = options?.maxDepth;
    const queue = [];
    for (const id of rootIds) {
        if (typeof id === "number" && id > 0) {
            queue.push({ id, depth: 0 });
        }
    }
    const visited = new Set();
    const commentIds = [];
    const itemsById = new Map();
    while (queue.length > 0 && commentIds.length < limit) {
        const wave = [];
        while (queue.length > 0 &&
            wave.length < HN_BFS_FETCH_CONCURRENCY &&
            commentIds.length < limit) {
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
        const fetched = await (0, client_js_1.fetchItemsInBatches)(waveIds, HN_BFS_FETCH_CONCURRENCY);
        for (const { id, depth } of wave) {
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
                        queue.push({ id: kid, depth: childDepth });
                    }
                }
            }
        }
    }
    return { commentIds, itemsById };
}
//# sourceMappingURL=collectCommentsBreadthFirst.js.map