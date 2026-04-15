import {createHash} from "node:crypto";

import type {HnItem} from "../hn/types.js";

function sha256Hex32(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 32);
}

/**
 * ストーリー同一性（要約・本文取得の再実行判定）。
 * Firestore のドキュメント ID は HN の storyId（不変）。タイトル修正などで指紋だけ変われば同一 doc を update し再 Enrich する想定。
 * - 通常: title + url
 * - Ask/Show 等（url なし）: title + text 先頭（スクレイピング不要で Enrich に渡せる）
 * score / descendants は含めない。
 */
export function storyIdentityFingerprint(title: string, item: Pick<HnItem, "url" | "text">): string {
  const url = item.url?.trim() ?? "";
  if (url) {
    return sha256Hex32(`${title}\n${url}`);
  }
  const snippet = (item.text ?? "").trim().slice(0, 4000);
  return sha256Hex32(`${title}\n\n${snippet}`);
}

/** 議論の活況度など。将来コメント要約の差分更新に使う（記事要約キューとは別判定可）。 */
export function signalsFingerprint(score: number, descendants: number, kidsCount: number): string {
  const payload = `${score}:${descendants}:${kidsCount}`;
  return createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 32);
}
