import type { Logger } from "pino";
import type { LlmClient } from "../ai/llm.js";
import type { ApprovalService } from "../approvals/service.js";
import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import type { EventBus } from "../events.js";
import type { JobRunner } from "../jobs/queue.js";
import type { TelegramBot } from "../telegram/bot.js";

/** What every feature module gets when it registers its handlers and jobs. */
export interface FeatureDeps {
  config: Config;
  db: Database;
  logger: Logger;
  runner: JobRunner;
  events: EventBus;
  llm: LlmClient;
  bot: TelegramBot | null;
  approvals: ApprovalService;
  /** Current time; replaced in tests. */
  now: () => Date;
}
