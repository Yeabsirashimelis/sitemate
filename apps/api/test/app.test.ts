import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { ConfigError, loadConfig } from "../src/config.js";

const config = loadConfig({ NODE_ENV: "test" });

describe("config", () => {
  it("uses safe defaults for local development", () => {
    const local = loadConfig({});
    expect(local.PORT).toBe(3000);
    expect(local.DATABASE_URL).toBeUndefined();
    expect(local.telegramMode).toBe("off");
  });

  it("polls Telegram in development and uses a webhook in production", () => {
    expect(loadConfig({ TELEGRAM_BOT_TOKEN: "t" }).telegramMode).toBe("polling");
    expect(
      loadConfig({
        NODE_ENV: "production",
        TELEGRAM_BOT_TOKEN: "t",
        DATABASE_URL: "postgres://x",
        JOBS_SECRET: "s",
        PUBLIC_URL: "https://api.example.com",
        TELEGRAM_WEBHOOK_SECRET: "w",
      }).telegramMode,
    ).toBe("webhook");
  });

  it("refuses to start in production without the settings it needs", () => {
    expect(() => loadConfig({ NODE_ENV: "production", TELEGRAM_BOT_TOKEN: "t" })).toThrow(
      /DATABASE_URL, JOBS_SECRET, PUBLIC_URL, TELEGRAM_WEBHOOK_SECRET/,
    );
  });

  it("treats empty values as unset and reports invalid ones", () => {
    expect(loadConfig({ GEMINI_API_KEY: "  " }).GEMINI_API_KEY).toBeUndefined();
    expect(() => loadConfig({ PORT: "abc" })).toThrow(ConfigError);
  });
});

describe("health endpoints", () => {
  it("answers health and readiness", async () => {
    const app = await buildApp({ config, readinessChecks: [{ name: "db", check: async () => {} }] });
    expect((await app.inject("/health")).json()).toEqual({ status: "ok" });
    const ready = await app.inject("/ready");
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: "ready", checks: [{ name: "db", ok: true }] });
    await app.close();
  });

  it("reports not ready when a dependency fails", async () => {
    const app = await buildApp({
      config,
      readinessChecks: [{ name: "db", check: async () => Promise.reject(new Error("down")) }],
    });
    const ready = await app.inject("/ready");
    expect(ready.statusCode).toBe(503);
    expect(ready.json().checks).toEqual([{ name: "db", ok: false }]);
    await app.close();
  });

  it("returns a JSON 404 for unknown routes", async () => {
    const app = await buildApp({ config });
    const response = await app.inject("/nope");
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("not_found");
    await app.close();
  });
});
