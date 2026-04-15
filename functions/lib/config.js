"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ENRICH_PIPELINE_VERSION = exports.MAX_TITLE_LENGTH = exports.MAX_STORIES_PER_REQUEST = exports.CACHE_TTL_HOURS = exports.CLAUDE_MODEL = exports.ANTHROPIC_API_KEY = void 0;
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
//# sourceMappingURL=config.js.map