import { newTraceId } from "../support/trace";
import { Operational } from "@openomni/protocol";
import { sleep } from "../support/fetch-retry";
import type { PublishPort } from "../types";
import type { TelegramClient } from "./client";
import type { TelegramMessage, TelegramUpdate } from "./types";

export interface PollerCallbacks {
  onMessage: (message: TelegramMessage) => void | Promise<void>;
}

export class TelegramPoller {
  private offset = 0;
  private running = false;
  private pollController: AbortController | null = null;

  constructor(
    private readonly client: Pick<TelegramClient, "getUpdates">,
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

  async pollOnce(pollTraceId: string): Promise<void> {
    this.pollController = new AbortController();
    const updates = (await this.client.getUpdates(
      this.offset,
      pollTraceId,
      this.pollController.signal,
    )) as TelegramUpdate[];

    // Telegram returns updates in update_id order. Process the batch in that
    // order and stop at the first failed handoff, leaving it and every later
    // update eligible for the next request. Updates without a text message do
    // not require a handoff and are checkpointed at their position in the batch.
    for (const update of updates) {
      if (update.message?.text) {
        await this.callbacks.onMessage(update.message);
      }
      this.offset = update.update_id + 1;
    }
  }

  private async poll(): Promise<void> {
    while (this.running) {
      // Origin: one long-poll cycle is one logical request — its getUpdates
      // call (retries included) and any poll-error warn share this ONE id.
      const pollTraceId = newTraceId();
      try {
        await this.pollOnce(pollTraceId);
      } catch (err) {
        if (!this.running) break;
        this.publish(Operational.Events.Warn, {
          traceId: pollTraceId,
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
