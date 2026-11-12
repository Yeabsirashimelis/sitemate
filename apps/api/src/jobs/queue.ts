/**
 * Job queue on Postgres.
 *
 * Jobs are rows. Workers claim them with FOR UPDATE SKIP LOCKED, so several
 * workers never take the same job, and failed jobs come back with
 * exponential backoff until they run out of attempts. Keeping the queue in
 * the main database means a job and the data it touches are always
 * consistent, and there is no extra service to run on the free tier.
 */

import { and, eq, lt, sql } from "drizzle-orm";
import type { z } from "zod";
import { queryRows, type Executor } from "../db/client.js";
import { jobs } from "../db/schema.js";

export type Job = typeof jobs.$inferSelect;

export interface EnqueueOptions {
  runAt?: Date;
  maxAttempts?: number;
  /** A second job with the same key is ignored. */
  idempotencyKey?: string;
}

/** Returns the job id, or null if a job with the same idempotency key already exists. */
export async function enqueue(
  db: Executor,
  type: string,
  payload: unknown,
  options: EnqueueOptions = {},
): Promise<number | null> {
  const [row] = await db
    .insert(jobs)
    .values({
      type,
      payload: payload ?? {},
      ...(options.runAt ? { runAt: options.runAt } : {}),
      ...(options.maxAttempts ? { maxAttempts: options.maxAttempts } : {}),
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    })
    .onConflictDoNothing()
    .returning({ id: jobs.id });
  return row?.id ?? null;
}

/** Delay before retry n (1-based): 10s, 20s, 40s ... capped at 30 minutes. */
export function backoffMs(attempt: number): number {
  return Math.min(10_000 * 2 ** Math.max(0, attempt - 1), 30 * 60_000);
}

export async function claimJobs(
  db: Executor,
  workerId: string,
  options: { limit?: number; types?: readonly string[]; now?: Date } = {},
): Promise<Job[]> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 5;
  const typeFilter =
    options.types && options.types.length > 0
      ? sql`and type in (${sql.join(
          options.types.map((t) => sql`${t}`),
          sql`, `,
        )})`
      : sql``;

  const rows = await queryRows<Record<string, unknown>>(
    db,
    sql`
      update jobs set status = 'running', locked_at = ${now}, locked_by = ${workerId}, attempts = attempts + 1
      where id in (
        select id from jobs
        where status = 'pending' and run_at <= ${now} ${typeFilter}
        order by run_at, id
        for update skip locked
        limit ${limit}
      )
      returning id
    `,
  );
  if (rows.length === 0) return [];
  const ids = rows.map((r) => Number(r.id));
  const claimed = await db
    .select()
    .from(jobs)
    .where(sql`${jobs.id} in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
  return claimed.sort((a, b) => a.runAt.getTime() - b.runAt.getTime() || a.id - b.id);
}

export async function completeJob(db: Executor, id: number): Promise<void> {
  await db
    .update(jobs)
    .set({ status: "done", finishedAt: new Date(), lockedAt: null, lockedBy: null, lastError: null })
    .where(eq(jobs.id, id));
}

/** Schedules a retry, or marks the job failed when it is out of attempts. Returns the new status. */
export async function failJob(
  db: Executor,
  job: Pick<Job, "id" | "attempts" | "maxAttempts">,
  error: unknown,
  now = new Date(),
): Promise<"pending" | "failed"> {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const exhausted = job.attempts >= job.maxAttempts;
  await db
    .update(jobs)
    .set({
      status: exhausted ? "failed" : "pending",
      lastError: message.slice(0, 2000),
      lockedAt: null,
      lockedBy: null,
      ...(exhausted ? { finishedAt: now } : { runAt: new Date(now.getTime() + backoffMs(job.attempts)) }),
    })
    .where(eq(jobs.id, job.id));
  return exhausted ? "failed" : "pending";
}

/** Puts back jobs whose worker died while holding them. */
export async function releaseStaleJobs(db: Executor, olderThanMs: number, now = new Date()): Promise<number> {
  const released = await db
    .update(jobs)
    .set({ status: "pending", lockedAt: null, lockedBy: null })
    .where(and(eq(jobs.status, "running"), lt(jobs.lockedAt, new Date(now.getTime() - olderThanMs))))
    .returning({ id: jobs.id });
  return released.length;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export interface JobContext {
  job: Job;
  db: Executor;
}

export interface JobDefinition<S extends z.ZodType = z.ZodType> {
  schema: S;
  handle: (payload: z.infer<S>, context: JobContext) => Promise<void>;
}

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export class JobRunner {
  private readonly definitions = new Map<string, JobDefinition>();
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private active: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: Executor,
    private readonly logger: Logger,
    private readonly workerId = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  ) {}

  register<S extends z.ZodType>(type: string, definition: JobDefinition<S>): this {
    if (this.definitions.has(type)) throw new Error(`Job type "${type}" is already registered`);
    this.definitions.set(type, definition as unknown as JobDefinition);
    return this;
  }

  get types(): string[] {
    return [...this.definitions.keys()];
  }

  /** Runs one claimed job. Payloads are validated before the handler sees them. */
  private async run(job: Job): Promise<void> {
    const definition = this.definitions.get(job.type);
    const started = Date.now();
    try {
      if (!definition) throw new Error(`No handler for job type "${job.type}"`);
      const payload = definition.schema.parse(job.payload);
      await definition.handle(payload, { job, db: this.db });
      await completeJob(this.db, job.id);
      this.logger.info({ jobId: job.id, type: job.type, ms: Date.now() - started }, "Job done");
    } catch (error) {
      const status = await failJob(this.db, job, error);
      const log = status === "failed" ? this.logger.error : this.logger.warn;
      log.call(this.logger, { jobId: job.id, type: job.type, attempt: job.attempts, err: error }, `Job ${status === "failed" ? "failed" : "will retry"}`);
    }
  }

  /**
   * Processes ready jobs until none are left or `maxJobs` is reached. Used by
   * the scheduled job endpoint and by tests.
   */
  async drain(options: { maxJobs?: number; now?: Date } = {}): Promise<number> {
    const maxJobs = options.maxJobs ?? 100;
    let processed = 0;
    while (processed < maxJobs) {
      const batch = await claimJobs(this.db, this.workerId, {
        limit: Math.min(5, maxJobs - processed),
        types: this.types,
        ...(options.now ? { now: options.now } : {}),
      });
      if (batch.length === 0) break;
      for (const job of batch) {
        await this.run(job);
        processed++;
      }
    }
    return processed;
  }

  private intervalMs = 1000;
  private ticking = false;

  private readonly tick = async (): Promise<void> => {
    if (!this.running || this.ticking) return;
    this.ticking = true;
    try {
      await releaseStaleJobs(this.db, 10 * 60_000);
      this.active = this.drain({ maxJobs: 20 });
      await this.active;
    } catch (error) {
      this.logger.error({ err: error }, "Job runner tick failed");
    } finally {
      this.ticking = false;
    }
    if (this.running) this.timer = setTimeout(this.tick, this.intervalMs);
  };

  /** Polls for work in the background until stop() is called. */
  start(intervalMs = 1000): void {
    if (this.running) return;
    this.running = true;
    this.intervalMs = intervalMs;
    this.timer = setTimeout(this.tick, 0);
  }

  /** Looks for work now instead of waiting for the next poll. */
  poke(): void {
    if (!this.running || this.ticking) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(this.tick, 0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.active.catch(() => undefined);
  }
}
