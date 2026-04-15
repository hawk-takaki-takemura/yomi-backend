"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.translateTitlesWithClaude = translateTitlesWithClaude;
const https_1 = require("firebase-functions/v2/https");
const config_js_1 = require("./config.js");
/**
 * Batch-translate HN story titles via Claude Messages API.
 */
async function translateTitlesWithClaude(stories, lang, apiKey) {
    const lines = Object.entries(stories).map(([id, title]) => `ID: ${id}: ${title}`);
    const prompt = [
        `Translate the following English titles to ${lang} language.`,
        'Return ONLY in the format "ID: <number>: <translated title>", one per line.',
        "No explanation needed.",
        "",
        ...lines,
    ].join("\n");
    const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        body: JSON.stringify({
            model: config_js_1.CLAUDE_MODEL,
            max_tokens: 2048,
            messages: [{ role: "user", content: prompt }],
        }),
    });
    if (!response.ok) {
        const body = await response.text();
        throw new https_1.HttpsError("internal", `claude failed: ${response.status} ${body}`);
    }
    const data = await response.json();
    const text = data.content?.[0]?.text;
    if (!text) {
        throw new https_1.HttpsError("internal", "claude response is empty");
    }
    const parsed = {};
    for (const raw of text.split("\n")) {
        const line = raw.trim().replace(/^ID:\s*/i, "");
        const sep = line.indexOf(": ");
        if (sep <= 0)
            continue;
        const id = line.slice(0, sep).trim();
        const title = line.slice(sep + 2).trim();
        if (id && title)
            parsed[id] = title;
    }
    return parsed;
}
//# sourceMappingURL=anthropic.js.map