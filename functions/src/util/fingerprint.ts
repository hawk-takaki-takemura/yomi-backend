import {createHash} from "node:crypto";

/**
 * タイトル・URL ベースの同一性（同一記事の要約・本文取得の再実行判定に使う）。
 * score / descendants は含めない（ランキング変動で無駄な LLM を避ける）。
 */
export function identityFingerprint(title: string, url: string | null): string {
  const payload = `${title}\n${url ?? ""}`;
  return createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 32);
}

/** 議論の活況度など。将来コメント要約の差分更新に使う（記事要約キューとは別判定可）。 */
export function signalsFingerprint(score: number, descendants: number, kidsCount: number): string {
  const payload = `${score}:${descendants}:${kidsCount}`;
  return createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 32);
}
