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
