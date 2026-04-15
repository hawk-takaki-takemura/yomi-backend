"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.identityFingerprint = identityFingerprint;
exports.signalsFingerprint = signalsFingerprint;
const node_crypto_1 = require("node:crypto");
/**
 * タイトル・URL ベースの同一性（同一記事の要約・本文取得の再実行判定に使う）。
 * score / descendants は含めない（ランキング変動で無駄な LLM を避ける）。
 */
function identityFingerprint(title, url) {
    const payload = `${title}\n${url ?? ""}`;
    return (0, node_crypto_1.createHash)("sha256").update(payload, "utf8").digest("hex").slice(0, 32);
}
/** 議論の活況度など。将来コメント要約の差分更新に使う（記事要約キューとは別判定可）。 */
function signalsFingerprint(score, descendants, kidsCount) {
    const payload = `${score}:${descendants}:${kidsCount}`;
    return (0, node_crypto_1.createHash)("sha256").update(payload, "utf8").digest("hex").slice(0, 32);
}
//# sourceMappingURL=fingerprint.js.map