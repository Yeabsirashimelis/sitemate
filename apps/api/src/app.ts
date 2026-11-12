import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import { registerErrorHandler } from "./http/errors.js";

export interface AppOptions {
  config: Config;
  /** Extra readiness checks, e.g. the database. */
  readinessChecks?: Array<{ name: string; check: () => Promise<void> }>;
}

export async function buildApp({ config, readinessChecks = [] }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      config.NODE_ENV === "test"
        ? false
        : {
            level: config.LOG_LEVEL,
            redact: ["req.headers.authorization", "req.headers.cookie", 'req.headers["x-telegram-bot-api-secret-token"]'],
            ...(config.NODE_ENV === "development" ? { transport: { target: "pino-pretty" } } : {}),
          },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });

  registerErrorHandler(app);

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/ready", async (_request, reply) => {
    const results = await Promise.all(
      readinessChecks.map(async ({ name, check }) => {
        try {
          await check();
          return { name, ok: true };
        } catch (error) {
          app.log.warn({ err: error, check: name }, "Readiness check failed");
          return { name, ok: false };
        }
      }),
    );
    const ready = results.every((r) => r.ok);
    return reply.status(ready ? 200 : 503).send({ status: ready ? "ready" : "not_ready", checks: results });
  });

  return app;
}
