import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import type { Database } from "./db/client.js";
import { registerAuth } from "./http/auth.js";
import { registerErrorHandler } from "./http/errors.js";
import { authRoutes } from "./routes/auth.js";
import { projectRoutes } from "./routes/projects.js";
import { userRoutes } from "./routes/users.js";

export interface AppOptions {
  config: Config;
  /** Without a database only the health endpoints are served. */
  db?: Database;
  /** Extra readiness checks, e.g. the database. */
  readinessChecks?: Array<{ name: string; check: () => Promise<void> }>;
}

export async function buildApp({ config, db, readinessChecks = [] }: AppOptions): Promise<FastifyInstance> {
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

  await app.register(cors, {
    origin: config.WEB_ORIGIN.split(",").map((origin) => origin.trim()),
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });
  await app.register(rateLimit, { global: false });

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

  if (db) {
    registerAuth(app, db);
    authRoutes(app, db, config);
    userRoutes(app, db, config);
    projectRoutes(app, db);
  }

  return app;
}
