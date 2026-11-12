/**
 * Loads the demo data into the configured database.
 *
 *   pnpm --filter @sitemate/api seed            refuses if the demo company exists
 *   pnpm --filter @sitemate/api seed --reset    removes it first
 *
 * The demo users share one password, SEED_PASSWORD (default "sitemate-demo").
 * Use it only for local and demo databases.
 */

import { loadConfig, loadEnvFile } from "../config.js";
import { openDatabase } from "../db/client.js";
import { localDate } from "../domain/time.js";
import { seedDemo } from "./seed.js";

loadEnvFile();
const config = loadConfig();
const handle = await openDatabase({ url: config.DATABASE_URL, pgliteDir: config.DATABASE_URL ? undefined : config.PGLITE_DIR });
await handle.migrate();
const password = process.env.SEED_PASSWORD ?? "sitemate-demo";

try {
  const result = await seedDemo(handle.db, {
    today: localDate(new Date(), config.SITE_TIME_ZONE),
    password,
    reset: process.argv.includes("--reset"),
    indexDocuments: !!config.GEMINI_API_KEY,
  });
  console.log("Seeded Abay Construction PLC");
  for (const s of result.summary) {
    console.log(`  ${s.project}: ${s.activities} activities, ${s.logs} daily logs, forecast ${s.forecastFinish} (contract ${s.contractFinish})`);
  }
  console.log(`Sign in with ${result.logins.join(", ")} and the password "${password}".`);
  if (!config.GEMINI_API_KEY) console.log("GEMINI_API_KEY is not set, so the contract and specification will be indexed once it is.");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await handle.close();
}
