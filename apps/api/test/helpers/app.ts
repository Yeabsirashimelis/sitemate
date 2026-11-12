import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig, type Config } from "../../src/config.js";
import type { DatabaseHandle } from "../../src/db/client.js";
import { createTestDatabase } from "./db.js";

export interface TestApp {
  app: FastifyInstance;
  handle: DatabaseHandle;
  config: Config;
  close(): Promise<void>;
}

export async function createTestApp(env: Record<string, string> = {}): Promise<TestApp> {
  const handle = await createTestDatabase();
  const config = loadConfig({ NODE_ENV: "test", ...env });
  const app = await buildApp({ config, db: handle.db });
  return {
    app,
    handle,
    config,
    close: async () => {
      await app.close();
      await handle.close();
    },
  };
}

let counter = 0;

/** Registers a company and returns its owner's token. */
export async function registerCompany(app: FastifyInstance, name = "Abay Construction") {
  counter++;
  const response = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { companyName: name, name: "Owner", email: `owner${counter}@example.com`, password: "correct horse 1" },
  });
  if (response.statusCode !== 201) throw new Error(`register failed: ${response.body}`);
  const body = response.json() as { token: string; user: { id: string; email: string }; company: { id: string } };
  return { ...body, auth: { authorization: `Bearer ${body.token}` } };
}
