import { openDatabase, type DatabaseHandle } from "../../src/db/client.js";

/** A fresh in-memory Postgres with all migrations applied. */
export async function createTestDatabase(): Promise<DatabaseHandle> {
  const handle = await openDatabase({});
  await handle.migrate();
  return handle;
}
