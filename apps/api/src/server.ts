import { buildApp } from "./app.js";
import { loadConfig, loadEnvFile } from "./config.js";
import { openDatabase } from "./db/client.js";

loadEnvFile();
const config = loadConfig();

const database = await openDatabase({
  url: config.DATABASE_URL,
  pgliteDir: config.DATABASE_URL ? undefined : config.PGLITE_DIR,
});
await database.migrate();

const app = await buildApp({
  config,
  db: database.db,
  readinessChecks: [{ name: "database", check: database.ping }],
});
app.addHook("onClose", () => database.close());
app.log.info({ database: database.kind }, "Database ready");

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, "Error during shutdown");
    process.exit(1);
  }
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port: config.PORT, host: config.HOST });
