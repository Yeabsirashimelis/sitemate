import type { Executor } from "../db/client.js";
import type { Logger } from "../jobs/queue.js";
import type { TelegramApi } from "./api.js";
import { TelegramApiError } from "./api.js";
import { receiveUpdate } from "./bot.js";

/**
 * Long polling for local development, so no public URL is needed. In
 * production Telegram calls the webhook instead.
 */
export class TelegramPoller {
  private offset = 0;
  private controller: AbortController | undefined;
  private loop: Promise<void> | undefined;

  constructor(
    private readonly db: Executor,
    private readonly api: TelegramApi,
    private readonly logger: Logger,
    private readonly onReceived: () => void = () => {},
  ) {}

  start(): void {
    if (this.loop) return;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.loop = (async () => {
      await this.api.deleteWebhook().catch((error: unknown) => this.logger.warn({ err: error }, "Could not remove webhook"));
      while (!signal.aborted) {
        try {
          const updates = await this.api.getUpdates(this.offset, 25, signal);
          for (const update of updates) {
            await receiveUpdate(this.db, update);
            this.offset = Math.max(this.offset, update.update_id + 1);
          }
          if (updates.length > 0) this.onReceived();
        } catch (error) {
          if (signal.aborted) break;
          const wait = error instanceof TelegramApiError && error.retryAfter ? error.retryAfter * 1000 : 3000;
          this.logger.warn({ err: error }, "Telegram polling failed, retrying");
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
      }
    })();
  }

  async stop(): Promise<void> {
    this.controller?.abort();
    await this.loop?.catch(() => undefined);
    this.loop = undefined;
  }
}
