import { buildApp } from "./app.js";
import { loadConfig, loadEnvFile } from "./config.js";

loadEnvFile();
const config = loadConfig();
const app = await buildApp({ config });

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
