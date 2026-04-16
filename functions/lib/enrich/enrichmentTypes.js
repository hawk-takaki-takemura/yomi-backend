"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ENRICH_V1_ALLOWED_TAGS = void 0;
exports.parseAndNormalizeEnrichmentV1 = parseAndNormalizeEnrichmentV1;
exports.ENRICH_V1_ALLOWED_TAGS = [
    "AI/LLM",
    "Programming",
    "Security",
    "Startup/Business",
    "Hardware",
    "OS/Kernel",
    "Networking",
    "WebDev",
    "Mobile",
    "Science",
    "Career",
    "Show HN",
    "Others",
];
const ALLOWED_SET = new Set(exports.ENRICH_V1_ALLOWED_TAGS);
function clamp01(n) {
    if (Number.isNaN(n))
        return 0;
    return Math.min(1, Math.max(0, n));
}
function truncate(s, max) {
    const t = s.trim();
    if (t.length <= max)
        return t;
    return t.slice(0, max);
}
/**
 * Claude 返却 JSON を検証し、Firestore 保存用に正規化する。
 */
function parseAndNormalizeEnrichmentV1(raw) {
    if (typeof raw !== "object" || raw === null) {
        throw new Error("enrichment: not an object");
    }
    const o = raw;
    if (o.schema_version !== 1) {
        throw new Error("enrichment: schema_version must be 1");
    }
    if (typeof o.title_ja !== "string") {
        throw new Error("enrichment: title_ja must be string");
    }
    if (typeof o.summary_short !== "string") {
        throw new Error("enrichment: summary_short must be string");
    }
    if (!Array.isArray(o.summary_points)) {
        throw new Error("enrichment: summary_points must be array");
    }
    if (!Array.isArray(o.tags)) {
        throw new Error("enrichment: tags must be array");
    }
    if (typeof o.hot_topic_score !== "number") {
        throw new Error("enrichment: hot_topic_score must be number");
    }
    if (typeof o.confidence_score !== "number") {
        throw new Error("enrichment: confidence_score must be number");
    }
    const pointsIn = o.summary_points.filter((x) => typeof x === "string");
    let points = pointsIn.map((p) => truncate(p, 80)).filter((p) => p.length > 0);
    if (points.length > 4) {
        points = points.slice(0, 4);
    }
    if (points.length === 0) {
        points = ["（本文情報が不足しています）", "（要約できません）"];
    }
    else if (points.length === 1) {
        points = [points[0], "（追加の独立した要点は検出されませんでした）"];
    }
    const tagIn = o.tags.filter((x) => typeof x === "string");
    const tags = [];
    for (const t of tagIn) {
        const tag = ALLOWED_SET.has(t) ? t : "Others";
        if (!tags.includes(tag)) {
            tags.push(tag);
        }
        if (tags.length >= 3)
            break;
    }
    if (tags.length === 0) {
        tags.push("Others");
    }
    return {
        schema_version: 1,
        title_ja: truncate(o.title_ja, 300),
        summary_short: truncate(o.summary_short, 140),
        summary_points: points.slice(0, 4),
        tags,
        hot_topic_score: clamp01(o.hot_topic_score),
        confidence_score: clamp01(o.confidence_score),
    };
}
//# sourceMappingURL=enrichmentTypes.js.map