import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { enqueue, JobRunner } from "../src/jobs/queue.js";
import { createLogger } from "../src/logger.js";
import { loadConfig } from "../src/config.js";
import { Scheduler } from "../src/scheduler.js";
import { createTestApp, type TestApp } from "./helpers/app.js";
import { createTestDatabase } from "./helpers/db.js";

const logger = createLogger(loadConfig({ NODE_ENV: "test" }));

describe("Scheduler", () => {
  it("runs every hook, keeps going when one fails, then works the queue", async () => {
    const handle = await createTestDatabase();
    const done: string[] = [];
    const runner = new JobRunner(handle.db, logger).register("noop", {
      schema: z.object({ n: z.number() }),
      handle: async ({ n }) => {
        done.push(`job ${n}`);
      },
    });
    const scheduler = new Scheduler(runner, logger)
      .add("first", async () => {
        await enqueue(handle.db, "noop", { n: 1 });
        return 1;
      })
      .add("broken", async () => {
        throw new Error("weather service down");
      })
      .add("last", async () => {
        done.push("last hook");
      });

    const report = await scheduler.tick();
    expect(report).toEqual({ hooks: { first: 1, broken: "error: weather service down", last: null }, jobsProcessed: 1 });
    expect(done).toEqual(["last hook", "job 1"]);
    await handle.close();
  });

  it("shares one run between overlapping ticks", async () => {
    const handle = await createTestDatabase();
    let calls = 0;
    const scheduler = new Scheduler(new JobRunner(handle.db, logger), logger).add("slow", async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await Promise.all([scheduler.tick(), scheduler.tick(), scheduler.tick()]);
    expect(calls).toBe(1);
    await scheduler.tick();
    expect(calls).toBe(2);
    await handle.close();
  });
});

describe("POST /jobs/tick", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ JOBS_SECRET: "cron-secret" });
  });
  afterAll(async () => {
    await t.close();
  });

  it("needs the jobs secret", async () => {
    expect((await t.app.inject({ method: "POST", url: "/jobs/tick" })).statusCode).toBe(401);
    expect(
      (await t.app.inject({ method: "POST", url: "/jobs/tick", headers: { "x-jobs-secret": "wrong" } })).statusCode,
    ).toBe(401);
  });

  it("runs the registered hooks", async () => {
    const response = await t.app.inject({ method: "POST", url: "/jobs/tick", headers: { "x-jobs-secret": "cron-secret" } });
    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json().hooks)).toEqual(
      expect.arrayContaining(["site.check-ins", "weather.morning-check", "procurement.daily-check", "approvals.expire", "sessions.cleanup"]),
    );
    expect(response.json().jobsProcessed).toBeTypeOf("number");
  });

  it("does not exist when no secret is configured", async () => {
    const plain = await createTestApp();
    expect((await plain.app.inject({ method: "POST", url: "/jobs/tick" })).statusCode).toBe(404);
    await plain.close();
  });
});
