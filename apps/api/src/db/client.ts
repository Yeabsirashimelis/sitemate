import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { sql, type SQL } from "drizzle-orm";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { migrate as migrateNodePg } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import pg from "pg";
import * as schema from "./schema.js";

export type Schema = typeof schema;
export type Database = PgDatabase<PgQueryResultHKT, Schema>;
/** A database or an open transaction; repository functions accept either. */
export type Executor = Pick<Database, "select" | "insert" | "update" | "delete" | "execute" | "transaction">;

/**
 * Runs raw SQL and returns typed rows. Both drivers return `{ rows }`; the
 * shared database type just does not know it.
 */
export async function queryRows<T>(executor: Executor, query: SQL): Promise<T[]> {
  const result = (await executor.execute(query)) as unknown as { rows: T[] };
  return result.rows;
}

export interface DatabaseHandle {
  db: Database;
  kind: "postgres" | "pglite";
  migrate(): Promise<void>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

export interface OpenDatabaseOptions {
  /** Postgres connection string. When missing, an embedded PGlite database is used. */
  url?: string | undefined;
  /** Folder for PGlite data. Undefined keeps it in memory, which is what tests use. */
  pgliteDir?: string | undefined;
}

export async function openDatabase({ url, pgliteDir }: OpenDatabaseOptions): Promise<DatabaseHandle> {
  if (url) {
    const pool = new pg.Pool({ connectionString: url, max: 10, idleTimeoutMillis: 30_000 });
    const db = drizzleNodePg(pool, { schema }) as unknown as Database;
    return {
      db,
      kind: "postgres",
      migrate: async () => {
        await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
        await migrateNodePg(drizzleNodePg(pool), { migrationsFolder });
      },
      ping: async () => {
        await db.execute(sql`select 1`);
      },
      close: () => pool.end(),
    };
  }

  if (pgliteDir) mkdirSync(pgliteDir, { recursive: true });
  const client = await PGlite.create({ ...(pgliteDir ? { dataDir: pgliteDir } : {}), extensions: { vector } });
  const db = drizzlePglite(client, { schema }) as unknown as Database;
  return {
    db,
    kind: "pglite",
    migrate: async () => {
      await client.exec("CREATE EXTENSION IF NOT EXISTS vector");
      await migratePglite(drizzlePglite(client), { migrationsFolder });
    },
    ping: async () => {
      await db.execute(sql`select 1`);
    },
    close: () => client.close(),
  };
}
