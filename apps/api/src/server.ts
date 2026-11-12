import { loadConfig, loadEnvFile } from "./config.js";
import { createRuntime } from "./runtime.js";

loadEnvFile();
const config = loadConfig();
const runtime = await createRuntime(config);
const { app, logger } = runtime;

const shutdown = async (signal: string) => {
  logger.info({ signal }, "Shutting down");
  try {
    await runtime.stop();
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, "Error during shutdown");
    process.exit(1);
  }
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port: config.PORT, host: config.HOST });
await runtime.start();
logger.info(
  { database: runtime.database.kind, telegram: config.telegramMode, jobs: runtime.runner.types },
  "SiteMate API started",
);
