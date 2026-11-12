/**
 * Events between agents.
 *
 * Agents never call each other. They publish events ("daily log completed",
 * "activity delayed") and every subscriber gets its own job in the queue, so
 * one slow or failing agent does not hold up the others and each one retries
 * on its own.
 */

import type { z } from "zod";
import type { Executor } from "./db/client.js";
import { enqueue, type JobContext, type JobRunner } from "./jobs/queue.js";

interface Subscription {
  name: string;
  jobType: string;
}

export class EventBus {
  private readonly subscriptions = new Map<string, Subscription[]>();

  constructor(private readonly runner: JobRunner) {}

  subscribe<S extends z.ZodType>(
    event: string,
    name: string,
    schema: S,
    handle: (payload: z.infer<S>, context: JobContext) => Promise<void>,
  ): this {
    const jobType = `event:${event}:${name}`;
    this.runner.register(jobType, { schema, handle });
    const list = this.subscriptions.get(event) ?? [];
    list.push({ name, jobType });
    this.subscriptions.set(event, list);
    return this;
  }

  /** Queues one job per subscriber. With a key, publishing the same event twice is a no-op. */
  async publish(db: Executor, event: string, payload: unknown, idempotencyKey?: string): Promise<number> {
    let queued = 0;
    for (const subscription of this.subscriptions.get(event) ?? []) {
      const id = await enqueue(db, subscription.jobType, payload, {
        ...(idempotencyKey ? { idempotencyKey: `${subscription.jobType}:${idempotencyKey}` } : {}),
      });
      if (id !== null) queued++;
    }
    return queued;
  }

  subscribers(event: string): string[] {
    return (this.subscriptions.get(event) ?? []).map((s) => s.name);
  }
}

export const EVENTS = {
  /** A daily log was completed and applied to the schedule and stock. */
  dailyLogCompleted: "daily_log.completed",
} as const;
