import {defineSecret} from "firebase-functions/params";

/** Anthropic API key (set via `firebase functions:secrets:set`) */
export const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

export const CLAUDE_MODEL = "claude-haiku-4-5-20251001";
export const CACHE_TTL_HOURS = 24;
export const MAX_STORIES_PER_REQUEST = 20;
export const MAX_TITLE_LENGTH = 200;

/**
 * 要約・本文取得パイプラインの版。
 * 将来プロンプトやモデルを変えて再生成したいときに `story_summaries` 側と突き合わせる。
 */
export const ENRICH_PIPELINE_VERSION = 1;

/** 同一 identity・同一パイプラインで Enrich がこの回数失敗したら ingest は再キューしない */
export const ENRICH_MAX_FAILURES = 5;

/** Enrich ワーカー: 1 回のスケジュール実行で処理する最大件数 */
export const ENRICH_JOBS_PER_TICK = 3;

/** 外部 URL 取得のタイムアウト（ms） */
export const ENRICH_FETCH_TIMEOUT_MS = 12_000;

/** 外部 HTML の読み取り上限（バイト） */
export const ENRICH_FETCH_MAX_BYTES = 50_000;

/** プロンプトに含める本文テキスト上限（文字数） */
export const ENRICH_MAX_PROMPT_CHARS = 15_000;

/** `processing` のまま固まったジョブを再キューするまでの時間（ms） */
export const ENRICH_STALE_PROCESSING_MS = 45 * 60 * 1000;

/** スケジュール enrich 後にコメント事前分析する最小スコア */
export const COMMENT_ENRICH_MIN_SCORE = 100;
/** 同上: 最小 descendants（コメント無し近辺はスキップ） */
export const COMMENT_ENRICH_MIN_DESCENDANTS = 10;
/** 温め（scheduled enrich の comments_enrichment）: BFS 件数上限 */
export const COMMENT_ENRICH_MAX_COUNT = 15;
/** 温め: BFS の最大深さ（0=ストーリ直下のみ。2 なら直下〜孫まで） */
export const COMMENT_ENRICH_BFS_MAX_DEPTH = 2;

/** Callable `translateHnComments` / `analyzeHnCommentTrends`（無料・匿名）: BFS 件数 */
export const COMMENT_CALLABLE_FREE_MAX_COUNT = 15;
/** 同上: BFS 深さ上限 */
export const COMMENT_CALLABLE_FREE_BFS_MAX_DEPTH = 2;
/** Callable（プレミアム）: BFS 件数 */
export const COMMENT_CALLABLE_PREMIUM_MAX_COUNT = 50;
/** Callable（プレミアム）: BFS 深さ上限 */
export const COMMENT_CALLABLE_PREMIUM_BFS_MAX_DEPTH = 5;
/** 1 コメントあたりの本文上限（文字） */
export const COMMENT_ENRICH_MAX_TEXT_CHARS = 1200;
