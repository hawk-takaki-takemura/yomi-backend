import {HttpsError} from "firebase-functions/v2/https";

import {CLAUDE_MODEL} from "./config.js";

/**
 * Batch-translate HN story titles via Claude Messages API.
 */
export async function translateTitlesWithClaude(
  stories: Record<string, string>,
  lang: string,
  apiKey: string,
): Promise<Record<string, string>> {
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
      model: CLAUDE_MODEL,
      max_tokens: 2048,
      messages: [{role: "user", content: prompt}],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new HttpsError("internal", `claude failed: ${response.status} ${body}`);
  }

  const data = await response.json() as {content?: Array<{text?: string}>};
  const text = data.content?.[0]?.text;
  if (!text) {
    throw new HttpsError("internal", "claude response is empty");
  }

  const parsed: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^ID:\s*/i, "");
    const sep = line.indexOf(": ");
    if (sep <= 0) continue;
    const id = line.slice(0, sep).trim();
    const title = line.slice(sep + 2).trim();
    if (id && title) parsed[id] = title;
  }
  return parsed;
}
