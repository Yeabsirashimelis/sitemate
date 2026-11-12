import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import { AppError } from "../http/errors.js";
import type { Scheduler } from "../scheduler.js";

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Called by the external cron. Without JOBS_SECRET the endpoint does not
 * exist, so it can never be triggered by accident.
 */
export function jobRoutes(app: FastifyInstance, config: Config, scheduler: Scheduler): void {
  if (!config.JOBS_SECRET) return;
  const secret = config.JOBS_SECRET;
  app.post("/jobs/tick", async (request) => {
    const given = request.headers["x-jobs-secret"];
    if (typeof given !== "string" || !sameSecret(given, secret)) {
      throw new AppError(401, "unauthenticated", "Invalid jobs secret");
    }
    return scheduler.tick();
  });
}
