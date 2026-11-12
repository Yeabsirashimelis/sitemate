/**
 * Composition root. Builds every long-lived part of the backend in one
 * place, so the server, the scheduled job runner and the tests all wire the
 * system the same way and tests can replace outside services with fakes.
 */

import type { FastifyInstance } from "fastify";
import type { Logger } from "pino";
import { z } from "zod";
import { DisabledLlm, GeminiClient, type LlmClient } from "./ai/llm.js";
import { ApprovalService } from "./approvals/service.js";
import { buildApp } from "./app.js";
import type { Config } from "./config.js";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { EMBEDDING_DIMENSIONS } from "./db/schema.js";
import { EventBus } from "./events.js";
import { registerNotifyFeature } from "./features/notify.js";
import { registerScheduleFeature } from "./features/schedule.js";
import { registerSiteFeature } from "./features/site.js";
import { registerWeatherFeature } from "./features/weather.js";
import { OpenMeteo, type WeatherProvider } from "./integrations/open-meteo.js";
import type { FeatureDeps } from "./features/types.js";
import { JobRunner } from "./jobs/queue.js";
import { createLogger } from "./logger.js";
import { deleteExpiredSessions } from "./auth/sessions.js";
import { Scheduler } from "./scheduler.js";
import { HttpTelegramApi, type TelegramApi } from "./telegram/api.js";
import { TELEGRAM_UPDATE_JOB, TelegramBot } from "./telegram/bot.js";
import { TelegramPoller } from "./telegram/poller.js";

export interface RuntimeOverrides {
  database?: DatabaseHandle;
  /** null disables Telegram even when a token is configured. */
  telegramApi?: TelegramApi | null;
  llm?: LlmClient;
  logger?: Logger;
  weather?: WeatherProvider;
  now?: () => Date;
}

export interface Runtime {
  config: Config;
  logger: Logger;
  database: DatabaseHandle;
  runner: JobRunner;
  bot: TelegramBot | null;
  llm: LlmClient;
  events: EventBus;
  scheduler: Scheduler;
  /** Dependencies handed to feature modules, also used by scheduled jobs and tests. */
  deps: FeatureDeps;
  app: FastifyInstance;
  /** Starts background work: the job runner and, in development, Telegram polling. */
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function createRuntime(config: Config, overrides: RuntimeOverrides = {}): Promise<Runtime> {
  const logger = overrides.logger ?? createLogger(config);
  const database =
    overrides.database ??
    (await openDatabase({ url: config.DATABASE_URL, pgliteDir: config.DATABASE_URL ? undefined : config.PGLITE_DIR }));
  await database.migrate();

  const runner = new JobRunner(database.db, logger);

  const llm =
    overrides.llm ??
    (config.GEMINI_API_KEY
      ? new GeminiClient({
          apiKey: config.GEMINI_API_KEY,
          model: config.GEMINI_MODEL,
          embeddingModel: config.GEMINI_EMBEDDING_MODEL,
          embeddingDimensions: EMBEDDING_DIMENSIONS,
        })
      : new DisabledLlm());

  const telegramApi =
    overrides.telegramApi !== undefined
      ? overrides.telegramApi
      : config.TELEGRAM_BOT_TOKEN
        ? new HttpTelegramApi(config.TELEGRAM_BOT_TOKEN)
        : null;
  const bot = telegramApi ? new TelegramBot(database.db, telegramApi, logger) : null;
  if (bot) {
    runner.register(TELEGRAM_UPDATE_JOB, {
      schema: z.object({ updateId: z.number().int() }),
      handle: ({ updateId }) => bot.processStoredUpdate(updateId),
    });
  }

  const events = new EventBus(runner);
  const scheduler = new Scheduler(runner, logger);
  const approvals = new ApprovalService(database.db, bot, {
    ownerApprovalThresholdEtb: config.OWNER_APPROVAL_THRESHOLD_ETB,
  });
  const deps: FeatureDeps = {
    config,
    db: database.db,
    logger,
    runner,
    events,
    llm,
    bot,
    approvals,
    weather: overrides.weather ?? new OpenMeteo(),
    scheduler,
    now: overrides.now ?? (() => new Date()),
  };
  registerNotifyFeature(deps);
  registerSiteFeature(deps);
  registerScheduleFeature(deps);
  registerWeatherFeature(deps);
  scheduler.add("approvals.expire", () => approvals.expireOld());
  scheduler.add("sessions.cleanup", () => deleteExpiredSessions(database.db));

  const app = await buildApp({
    config,
    logger,
    db: database.db,
    readinessChecks: [{ name: "database", check: database.ping }],
    onTelegramUpdate: () => runner.poke(),
    services: { approvals, scheduler },
  });

  const poller =
    bot && telegramApi && config.telegramMode === "polling"
      ? new TelegramPoller(database.db, telegramApi, logger, () => runner.poke())
      : null;

  return {
    config,
    logger,
    database,
    runner,
    bot,
    llm,
    events,
    scheduler,
    deps,
    app,
    start: async () => {
      if (telegramApi && config.telegramMode === "webhook") {
        await telegramApi.setWebhook(`${config.PUBLIC_URL}/telegram/webhook`, config.TELEGRAM_WEBHOOK_SECRET!);
      }
      poller?.start();
      runner.start();
      if (config.NODE_ENV !== "test") scheduler.start();
    },
    stop: async () => {
      await poller?.stop();
      await scheduler.stop();
      await runner.stop();
      await app.close();
      await database.close();
    },
  };
}
