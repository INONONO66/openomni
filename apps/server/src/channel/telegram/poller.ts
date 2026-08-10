import { Operational } from "@openomni/protocol";
import { sleep } from "../../shared/sleep";
import type { PublishPort } from "../types";
import type { TelegramClient } from "./client";
import type { TelegramMessage, TelegramUpdate } from "./types";

export interface PollerCallbacks {
  onMessage: (message: TelegramMessage) => void;
}

export class TelegramPoller {
  private offset = 0;
  private running = false;
  private pollController: AbortController | null = null;

  constructor(
    private readonly client: TelegramClient,
    private readonly callbacks: PollerCallbacks,
    private readonly publish: PublishPort,
  ) {}

  start(): void {
    this.running = true;
    this.poll();
  }

  stop(): void {
    this.running = false;
    this.pollController?.abort();
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        this.pollController = new AbortController();
        const updates = (await this.client.getUpdates(
          this.offset,
          this.pollController.signal,
        )) as TelegramUpdate[];

        for (const update of updates) {
          this.offset = update.update_id + 1;
          if (update.message?.text) {
            this.callbacks.onMessage(update.message);
          }
        }
      } catch (err) {
        if (!this.running) break;
        this.publish(Operational.Warn, {
          traceId: crypto.randomUUID(),
          time: Date.now(),
          component: "server",
          msg: "telegram poll error",
          context: { err: String(err) },
        });
        await sleep(5000);
      }
    }
  }
}
