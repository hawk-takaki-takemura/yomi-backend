import * as logger from "firebase-functions/logger";
import {onSchedule} from "firebase-functions/v2/scheduler";

/**
 * HN 取り込み・事前 Enrich の入口予定地。
 * 現状はログのみ。本番で負荷を抑えるため空タスクは 1 日 1 回（本格実装時に頻度を見直す）。
 */
export const scheduledIngestTick = onSchedule(
  {
    schedule: "every day 04:00",
    timeZone: "Asia/Tokyo",
    region: "asia-northeast1",
    timeoutSeconds: 60,
    memory: "256MiB",
  },
  async () => {
    logger.info("scheduledIngestTick: placeholder (no HN fetch yet)");
  },
);
