"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ENRICH_QUEUE_COLLECTION = exports.HN_ITEMS_COLLECTION = void 0;
/** Firestore: ストーリー正本（トップ／新着の両方から merge 更新） */
exports.HN_ITEMS_COLLECTION = "hn_items";
/** 本文取得・要約など「重い処理」のキュー（差分のみ積む） */
exports.ENRICH_QUEUE_COLLECTION = "enrich_queue";
//# sourceMappingURL=firestoreCollections.js.map