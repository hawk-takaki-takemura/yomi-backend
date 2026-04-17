"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.COMMENT_ENRICH_MAX_TEXT_CHARS = exports.COMMENT_CALLABLE_PREMIUM_BFS_MAX_DEPTH = exports.COMMENT_CALLABLE_PREMIUM_MAX_COUNT = exports.COMMENT_CALLABLE_FREE_BFS_MAX_DEPTH = exports.COMMENT_CALLABLE_FREE_MAX_COUNT = exports.COMMENT_ENRICH_BFS_MAX_DEPTH = exports.COMMENT_ENRICH_MAX_COUNT = exports.COMMENT_ENRICH_MIN_DESCENDANTS = exports.COMMENT_ENRICH_MIN_SCORE = exports.ENRICH_STALE_PROCESSING_MS = exports.ENRICH_MAX_PROMPT_CHARS = exports.ENRICH_FETCH_MAX_BYTES = exports.ENRICH_FETCH_TIMEOUT_MS = exports.ENRICH_JOBS_PER_TICK = exports.ENRICH_MAX_FAILURES = exports.ENRICH_PIPELINE_VERSION = exports.MAX_TITLE_LENGTH = exports.MAX_STORIES_PER_REQUEST = exports.CACHE_TTL_HOURS = exports.CLAUDE_MODEL = exports.ANTHROPIC_API_KEY = void 0;
const params_1 = require("firebase-functions/params");
/** Anthropic API key (set via `firebase functions:secrets:set`) */
exports.ANTHROPIC_API_KEY = (0, params_1.defineSecret)("ANTHROPIC_API_KEY");
exports.CLAUDE_MODEL = "claude-haiku-4-5-20251001";
exports.CACHE_TTL_HOURS = 24;
exports.MAX_STORIES_PER_REQUEST = 20;
exports.MAX_TITLE_LENGTH = 200;
/**
 * 要約・本文取得パイプラインの版。
 * 将来プロンプトやモデルを変えて再生成したいときに `story_summaries` 側と突き合わせる。
 */
exports.ENRICH_PIPELINE_VERSION = 1;
/** 同一 identity・同一パイプラインで Enrich がこの回数失敗したら ingest は再キューしない */
exports.ENRICH_MAX_FAILURES = 5;
/** Enrich ワーカー: 1 回のスケジュール実行で処理する最大件数 */
exports.ENRICH_JOBS_PER_TICK = 3;
/** 外部 URL 取得のタイムアウト（ms） */
exports.ENRICH_FETCH_TIMEOUT_MS = 12_000;
/** 外部 HTML の読み取り上限（バイト） */
exports.ENRICH_FETCH_MAX_BYTES = 50_000;
/** プロンプトに含める本文テキスト上限（文字数） */
exports.ENRICH_MAX_PROMPT_CHARS = 15_000;
/** `processing` のまま固まったジョブを再キューするまでの時間（ms） */
exports.ENRICH_STALE_PROCESSING_MS = 45 * 60 * 1000;
/** スケジュール enrich 後にコメント事前分析する最小スコア */
exports.COMMENT_ENRICH_MIN_SCORE = 100;
/** 同上: 最小 descendants（コメント無し近辺はスキップ） */
exports.COMMENT_ENRICH_MIN_DESCENDANTS = 10;
/** 温め（scheduled enrich の comments_enrichment）: BFS 件数上限 */
exports.COMMENT_ENRICH_MAX_COUNT = 15;
/** 温め: BFS の最大深さ（0=ストーリ直下のみ。2 なら直下〜孫まで） */
exports.COMMENT_ENRICH_BFS_MAX_DEPTH = 2;
/** Callable `translateHnComments` / `analyzeHnCommentTrends`（無料・匿名）: BFS 件数 */
exports.COMMENT_CALLABLE_FREE_MAX_COUNT = 15;
/** 同上: BFS 深さ上限 */
exports.COMMENT_CALLABLE_FREE_BFS_MAX_DEPTH = 2;
/** Callable（プレミアム）: BFS 件数 */
exports.COMMENT_CALLABLE_PREMIUM_MAX_COUNT = 50;
/** Callable（プレミアム）: BFS 深さ上限 */
exports.COMMENT_CALLABLE_PREMIUM_BFS_MAX_DEPTH = 5;
/** 1 コメントあたりの本文上限（文字） */
exports.COMMENT_ENRICH_MAX_TEXT_CHARS = 1200;
//# sourceMappingURL=config.js.map