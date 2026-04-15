/**
 * HN `text` や粗い HTML からプレーンテキストへ（依存ライブラリなし）。
 */
export function htmlToPlainText(html: string): string {
  const withoutBlocks = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  const stripped = withoutBlocks.replace(/<[^>]+>/g, " ");
  return stripped.replace(/\s+/g, " ").trim();
}
