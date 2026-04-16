/**
 * モデルが前後にゴミを付けた場合に最初の `{`〜最後の `}` を切り出して parse する。
 */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(unfenced) as unknown;
  } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start === -1 || end <= start) {
      throw new Error("json: no object found");
    }
    return JSON.parse(unfenced.slice(start, end + 1)) as unknown;
  }
}
