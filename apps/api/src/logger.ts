import { pino, type Logger } from "pino";
import type { Config } from "./config.js";

export function createLogger(config: Config): Logger {
  return pino({
    level: config.NODE_ENV === "test" ? "silent" : config.LOG_LEVEL,
    redact: ["req.headers.authorization", "req.headers.cookie", 'req.headers["x-telegram-bot-api-secret-token"]'],
    ...(config.NODE_ENV === "development" ? { transport: { target: "pino-pretty" } } : {}),
  });
}
