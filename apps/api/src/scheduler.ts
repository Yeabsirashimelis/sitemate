/**
 * Periodic work. Features add hooks (evening check-ins, the morning weather
 * check, weekly planning) and every tick runs all of them. Each hook is
 * idempotent for its own period, so ticking more often than needed is
 * harmless: a missed tick is caught up by the next one.
 *
 * Ticks come from an internal timer while the server is up, and from an
 * external cron calling /jobs/tick, which also wakes a free-tier instance
 * that has gone to sleep.
 */

import type { Logger } from "pino";
import type { JobRunner } from "./jobs/queue.js";

export type TickHook = () => Promise<number | void>;

export interface TickReport {
  hooks: Record<string, number | string | null>;
  jobsProcessed: number;
}

export class Scheduler {
  private readonly hooks = new Map<string, TickHook>();
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<TickReport> | null = null;

  constructor(
    private readonly runner: JobRunner,
    private readonly logger: Logger,
  ) {}

  add(name: string, hook: TickHook): this {
    if (this.hooks.has(name)) throw new Error(`Tick hook "${name}" is already registered`);
    this.hooks.set(name, hook);
    return this;
  }

  get hookNames(): string[] {
    return [...this.hooks.keys()];
  }

  /** Runs every hook, then works through the queue. Overlapping ticks share one run. */
  tick(options: { maxJobs?: number } = {}): Promise<TickReport> {
    this.running ??= this.run(options.maxJobs ?? 50).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(maxJobs: number): Promise<TickReport> {
    const hooks: TickReport["hooks"] = {};
    for (const [name, hook] of this.hooks) {
      try {
        const result = await hook();
        hooks[name] = typeof result === "number" ? result : null;
      } catch (error) {
        // One failing hook must not stop the others.
        this.logger.error({ err: error, hook: name }, "Tick hook failed");
        hooks[name] = error instanceof Error ? `error: ${error.message}` : "error";
      }
    }
    const jobsProcessed = await this.runner.drain({ maxJobs });
    return { hooks, jobsProcessed };
  }

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((error: unknown) => this.logger.error({ err: error }, "Tick failed"));
    }, intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => undefined);
  }
}
