"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildEnrichUserMessage = buildEnrichUserMessage;
/**
 * Claude `user` メッセージ（日本語テンプレ）。プレースホルダは実装側で埋める。
 */
function buildEnrichUserMessage(payload) {
    const hn = payload.hnText.trim();
    const ext = payload.extractedText.trim();
    return [
        "以下は Hacker News の1件です。指示どおり JSON のみを返してください。",
        "",
        `Title: ${payload.title}`,
        `URL: ${payload.url}`,
        `Type: ${payload.type}`,
        "",
        "HN の投稿本文（Ask/Show/テキスト系のとき。無ければ空）:",
        hn || "(空)",
        "",
        "外部記事から抽出した本文（取得済みのとき。無ければ空）:",
        ext || "(空)",
        "",
        "補足:",
        "- Type は story / ask / show など API の値のまま渡します。",
        "- 外部本文と HN 本文の両方がある場合は、外部本文を優先し、HN 本文は補足として使ってください。",
        "- 両方空に近い場合は、タイトルと URL から確定できる範囲だけに限定し、推測はしないでください。",
    ].join("\n");
}
//# sourceMappingURL=buildEnrichUserMessage.js.map