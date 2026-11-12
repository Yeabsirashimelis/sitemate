import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { DatabaseHandle } from "../src/db/client.js";
import { jobs } from "../src/db/schema.js";
import { backoffMs, claimJobs, enqueue, failJob, JobRunner, releaseStaleJobs } from "../src/jobs/queue.js";
import { createTestDatabase } from "./helpers/db.js";

let handle: DatabaseHandle;
const silent = { info() {}, warn() {}, error() {} };

beforeAll(async () => {
  handle = await createTestDatabase();
});
afterAll(async () => {
  await handle.close();
});
beforeEach(async () => {
  await handle.db.delete(jobs);
});

describe("job queue", () => {
  it("ignores a duplicate idempotency key", async () => {
    const first = await enqueue(handle.db, "log.process", { id: 1 }, { idempotencyKey: "update:1" });
    const second = await enqueue(handle.db, "log.process", { id: 1 }, { idempotencyKey: "update:1" });
    expect(first).toBeTypeOf("number");
    expect(second).toBeNull();
  });

  it("never hands the same job to two workers", async () => {
    for (let i = 0; i < 6; i++) await enqueue(handle.db, "t", { i });
    const [a, b] = await Promise.all([claimJobs(handle.db, "a", { limit: 4 }), claimJobs(handle.db, "b", { limit: 4 })]);
    const ids = [...a, ...b].map((j) => j.id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
    expect([...a, ...b].every((j) => j.status === "running" && j.attempts === 1)).toBe(true);
  });

  it("does not claim jobs scheduled for later", async () => {
    await enqueue(handle.db, "t", {}, { runAt: new Date(Date.now() + 60_000) });
    expect(await claimJobs(handle.db, "w")).toHaveLength(0);
    expect(await claimJobs(handle.db, "w", { now: new Date(Date.now() + 120_000) })).toHaveLength(1);
  });

  it("retries with backoff, then gives up", async () => {
    const now = new Date("2026-11-12T08:00:00Z");
    await enqueue(handle.db, "t", {}, { maxAttempts: 2, runAt: now });

    const [job] = await claimJobs(handle.db, "w", { now });
    expect(await failJob(handle.db, job!, new Error("network"), now)).toBe("pending");
    const [retry] = await handle.db.select().from(jobs).where(eq(jobs.id, job!.id));
    expect(retry!.runAt.getTime()).toBe(now.getTime() + backoffMs(1));
    expect(retry!.lastError).toBe("Error: network");

    const later = new Date(now.getTime() + backoffMs(1));
    const [again] = await claimJobs(handle.db, "w", { now: later });
    expect(again!.attempts).toBe(2);
    expect(await failJob(handle.db, again!, new Error("still down"), later)).toBe("failed");
  });

  it("releases jobs held by a worker that died", async () => {
    const old = new Date(Date.now() - 20 * 60_000);
    await enqueue(handle.db, "t", {}, { runAt: old });
    expect(await claimJobs(handle.db, "dead", { now: old })).toHaveLength(1);
    expect(await releaseStaleJobs(handle.db, 30 * 60_000)).toBe(0);
    expect(await releaseStaleJobs(handle.db, 10 * 60_000)).toBe(1);
    expect(await claimJobs(handle.db, "alive")).toHaveLength(1);
  });

  it("backs off exponentially with a cap", () => {
    expect([1, 2, 3].map(backoffMs)).toEqual([10_000, 20_000, 40_000]);
    expect(backoffMs(30)).toBe(30 * 60_000);
  });
});

describe("JobRunner", () => {
  it("validates payloads, runs handlers and records failures", async () => {
    const seen: number[] = [];
    const runner = new JobRunner(handle.db, silent).register("square", {
      schema: z.object({ n: z.number() }),
      handle: async ({ n }) => {
        if (n < 0) throw new Error("negative");
        seen.push(n * n);
      },
    });

    await enqueue(handle.db, "square", { n: 3 });
    await enqueue(handle.db, "square", { n: "bad" }, { maxAttempts: 1 });
    await enqueue(handle.db, "square", { n: -1 }, { maxAttempts: 1 });

    expect(await runner.drain()).toBe(3);
    expect(seen).toEqual([9]);

    const rows = await handle.db.select().from(jobs);
    expect(rows.filter((r) => r.status === "done")).toHaveLength(1);
    const failed = rows.filter((r) => r.status === "failed");
    expect(failed).toHaveLength(2);
    expect(failed.map((r) => r.lastError).join(" ")).toMatch(/ZodError|negative/);
  });

  it("gives up on a job that hangs so the jobs behind it still run", async () => {
    const done: string[] = [];
    const runner = new JobRunner(handle.db, silent, "worker-test", 50)
      .register("hang", { schema: z.object({}), handle: () => new Promise<void>(() => undefined) })
      .register("quick", { schema: z.object({}), handle: async () => void done.push("quick") });
    const hung = await enqueue(handle.db, "hang", {});
    await enqueue(handle.db, "quick", {});

    expect(await runner.drain()).toBe(2);
    expect(done).toEqual(["quick"]);
    const [row] = await handle.db.select().from(jobs).where(eq(jobs.id, hung!));
    expect(row).toMatchObject({ status: "pending", lastError: "Error: Job took longer than 0.05 s" });
  });

  it("leaves job types it does not handle for other runners", async () => {
    await enqueue(handle.db, "other", {});
    const runner = new JobRunner(handle.db, silent).register("mine", { schema: z.object({}), handle: async () => {} });
    expect(await runner.drain()).toBe(0);
    const [row] = await handle.db.select().from(jobs);
    expect(row!.status).toBe("pending");
  });

  it("refuses to register the same type twice", () => {
    const runner = new JobRunner(handle.db, silent);
    const definition = { schema: z.object({}), handle: async () => {} };
    runner.register("x", definition);
    expect(() => runner.register("x", definition)).toThrow(/already registered/);
  });
});
