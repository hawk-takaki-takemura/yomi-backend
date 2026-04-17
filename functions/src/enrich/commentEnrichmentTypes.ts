/** Firestore `hn_items.comments_enrichment` ネスト（V1、analyzed_at / source_model は保存時に付与） */
export type CommentsEnrichmentV1 = {
  schema_version: 1;
  sentiment: {
    positive: number;
    neutral: number;
    negative: number;
  };
  summary: string;
  keywords: string[];
  top_comments: Array<{
    id: number;
    text_ja: string;
    sentiment: "positive" | "neutral" | "negative";
  }>;
};

function normalizeTriple(p: number, n: number, neg: number): {positive: number; neutral: number; negative: number} {
  const clip = (x: number) =>
    Math.max(0, Math.min(100, Math.round(Number.isFinite(x) ? x : 0)));
  let a = clip(p);
  let b = clip(n);
  let c = clip(neg);
  const sum = a + b + c;
  if (sum === 100) return {positive: a, neutral: b, negative: c};
  if (sum <= 0) return {positive: 34, neutral: 33, negative: 33};
  a = Math.round((a * 100) / sum);
  b = Math.round((b * 100) / sum);
  c = 100 - a - b;
  return {positive: a, neutral: b, negative: Math.max(0, c)};
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return t.slice(0, max);
}

const SENTIMENTS = new Set<string>(["positive", "neutral", "negative"]);

/**
 * Claude 返却 JSON を検証し、Firestore 保存用に正規化する。
 */
export function parseAndNormalizeCommentsEnrichmentV1(raw: unknown): CommentsEnrichmentV1 {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("comments_enrichment: not an object");
  }
  const o = raw as Record<string, unknown>;
  if (o.schema_version !== 1) {
    throw new Error("comments_enrichment: schema_version must be 1");
  }

  const sentRaw = o.sentiment;
  if (typeof sentRaw !== "object" || sentRaw === null) {
    throw new Error("comments_enrichment: sentiment must be object");
  }
  const s = sentRaw as Record<string, unknown>;
  const num = (v: unknown): number => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "") {
      const x = Number(v);
      return Number.isFinite(x) ? x : 0;
    }
    return 0;
  };
  const sentiment = normalizeTriple(num(s.positive), num(s.neutral), num(s.negative));

  if (typeof o.summary !== "string") {
    throw new Error("comments_enrichment: summary must be string");
  }

  const kwRaw = o.keywords;
  const keywords: string[] = [];
  if (Array.isArray(kwRaw)) {
    for (const k of kwRaw) {
      if (keywords.length >= 12) break;
      if (typeof k !== "string") continue;
      const t = k.trim();
      if (t) keywords.push(truncate(t, 40));
    }
  }

  const tcRaw = o.top_comments;
  const top_comments: CommentsEnrichmentV1["top_comments"] = [];
  if (Array.isArray(tcRaw)) {
    for (const row of tcRaw) {
      if (top_comments.length >= 20) break;
      if (typeof row !== "object" || row === null) continue;
      const r = row as Record<string, unknown>;
      const idRaw = r.id ?? r.comment_id;
      const id =
        typeof idRaw === "number" && Number.isInteger(idRaw) && idRaw > 0
          ? idRaw
          : typeof idRaw === "string" && /^\d+$/.test(idRaw.trim())
            ? Number(idRaw.trim())
            : 0;
      if (!id) continue;
      const textJa = typeof r.text_ja === "string" ? truncate(r.text_ja, 2000) : "";
      if (!textJa) continue;
      const sent = typeof r.sentiment === "string" ? r.sentiment.trim() : "";
      if (!SENTIMENTS.has(sent)) continue;
      top_comments.push({
        id,
        text_ja: textJa,
        sentiment: sent as "positive" | "neutral" | "negative",
      });
    }
  }

  if (top_comments.length === 0) {
    throw new Error("comments_enrichment: top_comments empty");
  }

  return {
    schema_version: 1,
    sentiment,
    summary: truncate(o.summary, 100),
    keywords,
    top_comments,
  };
}
