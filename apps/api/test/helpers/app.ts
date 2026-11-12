import type { FastifyInstance } from "fastify";
import { loadConfig, type Config } from "../../src/config.js";
import type { DatabaseHandle } from "../../src/db/client.js";
import type { ExchangeRates } from "../../src/integrations/fx.js";
import type { CalendarProvider } from "../../src/integrations/google-calendar.js";
import type { WeatherProvider } from "../../src/integrations/open-meteo.js";
import { createRuntime, type Runtime } from "../../src/runtime.js";
import { FakeLlm } from "./llm.js";
import { createTestDatabase } from "./db.js";
import { FakeTelegramApi } from "./telegram.js";

export interface TestApp {
  app: FastifyInstance;
  handle: DatabaseHandle;
  config: Config;
  runtime: Runtime;
  telegram: FakeTelegramApi;
  llm: FakeLlm;
  close(): Promise<void>;
}

export async function createTestApp(env: Record<string, string> = {}, options: { now?: () => Date; weather?: WeatherProvider; fx?: ExchangeRates; calendar?: CalendarProvider } = {}): Promise<TestApp> {
  const handle = await createTestDatabase();
  const config = loadConfig({ NODE_ENV: "test", AUTH_RATE_LIMIT_PER_MINUTE: "1000", ...env });
  const telegram = new FakeTelegramApi();
  const llm = new FakeLlm();
  const runtime = await createRuntime(config, {
    database: handle,
    telegramApi: telegram,
    llm,
    ...(options.now ? { now: options.now } : {}),
    // Tests never reach Open-Meteo; a quiet forecast unless a test brings its own.
    weather: options.weather ?? { forecast: async () => [] },
    // Tests never reach the real Google Calendar.
    calendar: options.calendar ?? null,
    fx: options.fx ?? { toEtb: async (amount: number, currency: string) => (currency.toUpperCase() === "USD" ? amount * 160 : amount) },
  });
  return {
    app: runtime.app,
    handle,
    config,
    runtime,
    telegram,
    llm,
    close: () => runtime.stop(),
  };
}

let counter = 0;

/** Registers a company and returns its owner's token. */
export async function registerCompany(app: FastifyInstance, name = "Abay Construction") {
  counter++;
  const response = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { companyName: name, name: "Owner", email: `owner${counter}-${Date.now()}@example.com`, password: "correct horse 1" },
  });
  if (response.statusCode !== 201) throw new Error(`register failed: ${response.body}`);
  const body = response.json() as { token: string; user: { id: string; email: string }; company: { id: string } };
  return { ...body, auth: { authorization: `Bearer ${body.token}` } };
}
