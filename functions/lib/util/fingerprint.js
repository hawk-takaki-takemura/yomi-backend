"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.storyIdentityFingerprint = storyIdentityFingerprint;
exports.signalsFingerprint = signalsFingerprint;
const node_crypto_1 = require("node:crypto");
function sha256Hex32(payload) {
    return (0, node_crypto_1.createHash)("sha256").update(payload, "utf8").digest("hex").slice(0, 32);
}
/**
 * ストーリー同一性（要約・本文取得の再実行判定）。
 * - 通常: title + url
 * - Ask/Show 等（url なし）: title + text 先頭（スクレイピング不要で Enrich に渡せる）
 * score / descendants は含めない。
 */
function storyIdentityFingerprint(title, item) {
    const url = item.url?.trim() ?? "";
    if (url) {
        return sha256Hex32(`${title}\n${url}`);
    }
    const snippet = (item.text ?? "").trim().slice(0, 4000);
    return sha256Hex32(`${title}\n\n${snippet}`);
}
/** 議論の活況度など。将来コメント要約の差分更新に使う（記事要約キューとは別判定可）。 */
function signalsFingerprint(score, descendants, kidsCount) {
    const payload = `${score}:${descendants}:${kidsCount}`;
    return (0, node_crypto_1.createHash)("sha256").update(payload, "utf8").digest("hex").slice(0, 32);
}
//# sourceMappingURL=fingerprint.js.map