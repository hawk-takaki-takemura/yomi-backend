"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchArticlePlainText = fetchArticlePlainText;
const logger = __importStar(require("firebase-functions/logger"));
const htmlToPlainText_js_1 = require("./htmlToPlainText.js");
/**
 * Cloudflare 等のボット判定を避けるため、一般的なデスクトップ Chrome に近い UA を使う。
 * 403 が多いときはここを更新して最新の安定版に合わせるとよい。
 */
const DEFAULT_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
/**
 * 記事 URL からプレーンテキストを取得（失敗時は null）。
 */
async function fetchArticlePlainText(url, options) {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
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
                accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
                "accept-language": "en-US,en;q=0.9",
            },
        });
        if (!res.ok) {
            logger.warn("enrich.fetchArticle.httpError", { status: res.status, url: parsed.origin });
            return null;
        }
        const buf = await res.arrayBuffer();
        const slice = buf.byteLength > options.maxBytes ? buf.slice(0, options.maxBytes) : buf;
        const charset = /charset=([^;]+)/i.exec(res.headers.get("content-type") ?? "")?.[1]?.trim() ?? "utf-8";
        let raw;
        try {
            raw = new TextDecoder(charset.replace(/['"]/g, "")).decode(slice);
        }
        catch {
            raw = new TextDecoder("utf-8").decode(slice);
        }
        const ct = (res.headers.get("content-type") ?? "").toLowerCase();
        if (ct.includes("text/plain")) {
            return raw.replace(/\s+/g, " ").trim().slice(0, 120_000);
        }
        const text = (0, htmlToPlainText_js_1.htmlToPlainText)(raw);
        return text.length > 0 ? text.slice(0, 120_000) : null;
    }
    catch (e) {
        logger.warn("enrich.fetchArticle.failed", { url: parsed.origin, err: String(e) });
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
//# sourceMappingURL=fetchArticlePlainText.js.map