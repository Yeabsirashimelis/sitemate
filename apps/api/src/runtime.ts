/**
 * Composition root. Builds every long-lived part of the backend in one
 * place, so the server, the scheduled job runner and the tests all wire the
 * system the same way and tests can replace outside services with fakes.
 */

import type { FastifyInstance } from "fastify";
import type { Logger } from "pino";
import { z } from "zod";
import { buildApp } from "./app.js";
import type { Config } from "./config.js";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { JobRunner } from "./jobs/queue.js";
import { createLogger } from "./logger.js";
import { HttpTelegramApi, type TelegramApi } from "./telegram/api.js";
import { TELEGRAM_UPDATE_JOB, TelegramBot } from "./telegram/bot.js";
import { TelegramPoller } from "./telegram/poller.js";

export interface RuntimeOverrides {
  database?: DatabaseHandle;
  /** null disables Telegram even when a token is configured. */
  telegramApi?: TelegramApi | null;
  logger?: Logger;
}

export interface Runtime {
  config: Config;
  logger: Logger;
  database: DatabaseHandle;
  runner: JobRunner;
  bot: TelegramBot | null;
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

  const app = await buildApp({
    config,
    logger,
    db: database.db,
    readinessChecks: [{ name: "database", check: database.ping }],
    onTelegramUpdate: () => runner.poke(),
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
    app,
    start: async () => {
      if (telegramApi && config.telegramMode === "webhook") {
        await telegramApi.setWebhook(`${config.PUBLIC_URL}/telegram/webhook`, config.TELEGRAM_WEBHOOK_SECRET!);
      }
      poller?.start();
      runner.start();
    },
    stop: async () => {
      await poller?.stop();
      await runner.stop();
      await app.close();
      await database.close();
    },
  };
}
