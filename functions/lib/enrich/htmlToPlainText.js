"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.htmlToPlainText = htmlToPlainText;
/**
 * HN `text` や粗い HTML からプレーンテキストへ（依存ライブラリなし）。
 */
function htmlToPlainText(html) {
    const withoutBlocks = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
    const stripped = withoutBlocks.replace(/<[^>]+>/g, " ");
    return stripped.replace(/\s+/g, " ").trim();
}
//# sourceMappingURL=htmlToPlainText.js.map