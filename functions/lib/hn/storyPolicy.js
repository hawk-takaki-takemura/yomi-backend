"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isStoryHiddenByModeration = isStoryHiddenByModeration;
exports.isHnTextPost = isHnTextPost;
/**
 * HN の deleted / dead に加え、タイトルだけが [deleted] 等になっているケースを除外する。
 * @see https://github.com/HackerNews/API/blob/master/README.md （dead / deleted）
 */
function isStoryHiddenByModeration(item) {
    if (item.deleted === true || item.dead === true) {
        return true;
    }
    const raw = item.title?.trim();
    if (!raw) {
        return true;
    }
    const lower = raw.toLowerCase();
    return (lower.startsWith("[deleted]") ||
        lower.startsWith("[flagged]") ||
        lower.startsWith("[dead]") ||
        lower === "[deleted]" ||
        lower === "[flagged]");
}
/** Ask HN / Show HN など、url が無く `text` に本文がある投稿 */
function isHnTextPost(item) {
    const hasUrl = Boolean(item.url?.trim());
    const hasText = Boolean(item.text?.trim());
    return !hasUrl && hasText;
}
//# sourceMappingURL=storyPolicy.js.map