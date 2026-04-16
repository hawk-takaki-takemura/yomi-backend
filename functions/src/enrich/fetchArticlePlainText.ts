import * as logger from "firebase-functions/logger";

import {htmlToPlainText} from "./htmlToPlainText.js";

/**
 * Cloudflare 等のボット判定を避けるため、一般的なデスクトップ Chrome に近い UA を使う。
 * 403 が多いときはここを更新して最新の安定版に合わせるとよい。
 */
const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export type FetchArticlePlainTextOptions = {
  timeoutMs: number;
  maxBytes: number;
};

/**
 * 記事 URL からプレーンテキストを取得（失敗時は null）。
 */
export async function fetchArticlePlainText(
  url: string,
  options: FetchArticlePlainTextOptions,
): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const res = await fetch(parsed.toString(), {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": DEFAULT_UA,
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) {
      logger.warn("enrich.fetchArticle.httpError", {status: res.status, url: parsed.origin});
      return null;
    }
    const buf = await res.arrayBuffer();
    const slice = buf.byteLength > options.maxBytes ? buf.slice(0, options.maxBytes) : buf;
    const charset =
      /charset=([^;]+)/i.exec(res.headers.get("content-type") ?? "")?.[1]?.trim() ?? "utf-8";
    let raw: string;
    try {
      raw = new TextDecoder(charset.replace(/['"]/g, "")).decode(slice);
    } catch {
      raw = new TextDecoder("utf-8").decode(slice);
    }
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    if (ct.includes("text/plain")) {
      return raw.replace(/\s+/g, " ").trim().slice(0, 120_000);
    }
    const text = htmlToPlainText(raw);
    return text.length > 0 ? text.slice(0, 120_000) : null;
  } catch (e) {
    logger.warn("enrich.fetchArticle.failed", {url: parsed.origin, err: String(e)});
    return null;
  } finally {
    clearTimeout(timer);
  }
}
