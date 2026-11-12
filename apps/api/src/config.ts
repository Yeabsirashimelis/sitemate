import { existsSync } from "node:fs";
import { z } from "zod";

const optional = z
  .string()
  .trim()
  .transform((value) => (value === "" ? undefined : value))
  .optional();

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  /** Postgres connection string. Without it the API runs on an embedded PGlite database. */
  DATABASE_URL: optional,
  PGLITE_DIR: z.string().default(".data/pglite"),

  /** Sign-up and sign-in attempts allowed per IP address per minute. */
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),

  /** Allowed origin for the dashboard. */
  WEB_ORIGIN: z.string().default("http://localhost:5173"),
  /** Public URL of this API, used for the Telegram webhook in production. */
  PUBLIC_URL: optional,

  GEMINI_API_KEY: optional,
  GEMINI_MODEL: z.string().default("gemini-3.8-flash"),
  GEMINI_EMBEDDING_MODEL: z.string().default("gemini-embedding-001"),

  TELEGRAM_BOT_TOKEN: optional,
  /** Bot username without @, used to build invite links. */
  TELEGRAM_BOT_USERNAME: optional,
  TELEGRAM_MODE: z.enum(["polling", "webhook", "off"]).optional(),
  TELEGRAM_WEBHOOK_SECRET: optional,

  /** Shared secret the scheduled job runner sends to the job endpoints. */
  JOBS_SECRET: optional,

  GOOGLE_CALENDAR_ID: optional,
  GOOGLE_SERVICE_ACCOUNT_FILE: z.string().default("google-service-account.json"),

  /** Seconds to wait after a supervisor's last message before processing, so a burst is read together. */
  SITE_BATCH_SECONDS: z.coerce.number().int().min(0).max(600).default(45),

  /** Time zone used for "today" on site. */
  SITE_TIME_ZONE: z.string().default("Africa/Addis_Ababa"),

  /** Purchases and recovery plans above this amount, in birr, need the owner's approval. */
  OWNER_APPROVAL_THRESHOLD_ETB: z.coerce.number().nonnegative().default(200_000),
});

export type Config = z.infer<typeof schema> & {
  telegramMode: "polling" | "webhook" | "off";
};

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new ConfigError(`Invalid configuration:\n  ${problems.join("\n  ")}`);
  }
  const config = parsed.data;

  const telegramMode =
    config.TELEGRAM_MODE ?? (!config.TELEGRAM_BOT_TOKEN ? "off" : config.NODE_ENV === "production" ? "webhook" : "polling");

  if (config.NODE_ENV === "production") {
    const missing = ["DATABASE_URL", "JOBS_SECRET"].filter((key) => !config[key as keyof typeof config]);
    if (telegramMode === "webhook") {
      if (!config.PUBLIC_URL) missing.push("PUBLIC_URL");
      if (!config.TELEGRAM_WEBHOOK_SECRET) missing.push("TELEGRAM_WEBHOOK_SECRET");
    }
    if (missing.length > 0) {
      throw new ConfigError(`Missing required settings for production: ${missing.join(", ")}`);
    }
  }

  return { ...config, telegramMode };
}

/** Loads .env from the working directory if there is one. Real environment variables win. */
export function loadEnvFile(path = ".env"): void {
  if (existsSync(path)) process.loadEnvFile(path);
}
