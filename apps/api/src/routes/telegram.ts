import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { AppError } from "../http/errors.js";
import type { TelegramUpdate } from "../telegram/api.js";
import { receiveUpdate } from "../telegram/bot.js";

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Telegram webhook. The update is stored and queued before answering, so the
 * reply is fast and nothing is lost if processing fails later.
 */
export function telegramRoutes(app: FastifyInstance, db: Database, config: Config, onReceived: () => void): void {
  app.post("/telegram/webhook", async (request, reply) => {
    const secret = config.TELEGRAM_WEBHOOK_SECRET;
    const given = request.headers["x-telegram-bot-api-secret-token"];
    if (!secret || typeof given !== "string" || !sameSecret(given, secret)) {
      throw new AppError(401, "unauthenticated", "Invalid webhook secret");
    }
    const update = request.body as TelegramUpdate;
    if (typeof update?.update_id !== "number") throw new AppError(400, "bad_request", "Not a Telegram update");
    if (await receiveUpdate(db, update)) onReceived();
    return reply.status(200).send({ ok: true });
  });
}
