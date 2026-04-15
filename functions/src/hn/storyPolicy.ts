import type {HnItem} from "./types.js";

/**
 * HN の deleted / dead に加え、タイトルだけが [deleted] 等になっているケースを除外する。
 * @see https://github.com/HackerNews/API/blob/master/README.md （dead / deleted）
 */
export function isStoryHiddenByModeration(item: HnItem): boolean {
  if (item.deleted === true || item.dead === true) {
    return true;
  }
  const raw = item.title?.trim();
  if (!raw) {
    return true;
  }
  const lower = raw.toLowerCase();
  return (
    lower.startsWith("[deleted]") ||
    lower.startsWith("[flagged]") ||
    lower.startsWith("[dead]") ||
    lower === "[deleted]" ||
    lower === "[flagged]"
  );
}

/** Ask HN / Show HN など、url が無く `text` に本文がある投稿 */
export function isHnTextPost(item: HnItem): boolean {
  const hasUrl = Boolean(item.url?.trim());
  const hasText = Boolean(item.text?.trim());
  return !hasUrl && hasText;
}
