import { newTraceId } from "../../support/trace";
import { Operational } from "@openomni/protocol";
import { calculateBackoff } from "../../support/reconnect-backoff";
import { sleep } from "../../support/fetch-retry";
import type { PublishPort } from "../../types";
import type { TelegramClient } from "./client";
import type { TelegramMessage } from "./types";

interface PollerCallbacks {
  onMessage: (message: TelegramMessage) => void | Promise<void>;
}

export class TelegramPoller {
  private offset = 0;
  private running = false;
  private generation = 0;
  private pollController: AbortController | null = null;

  constructor(
    private readonly client: Pick<TelegramClient, "getUpdates">,
    private readonly callbacks: PollerCallbacks,
    private readonly publish: PublishPort,
    private readonly delay: (ms: number) => Promise<void> = sleep,
  ) {}

  start(): Promise<void> {
    this.stop();
    this.running = true;
    return this.poll(this.generation);
  }

  stop(): void {
    this.running = false;
    this.generation++;
    this.pollController?.abort();
  }

  async pollOnce(pollTraceId: string): Promise<void> {
    const generation = this.generation;
    const controller = new AbortController();
    this.pollController = controller;
    const updates = await this.client.getUpdates(
      this.offset,
      pollTraceId,
      controller.signal,
    );

    // Telegram returns updates in update_id order. Process the batch in that
    // order and stop at the first failed handoff, leaving it and every later
    // update eligible for the next request. Updates without a text message do
    // not require a handoff and are checkpointed at their position in the batch.
    for (const update of updates) {
      if (generation !== this.generation || controller.signal.aborted) return;
      if (update.message?.text) {
        await this.callbacks.onMessage(update.message);
      }
      if (generation !== this.generation) return;
      this.offset = update.update_id + 1;
    }
  }

  private async poll(generation: number): Promise<void> {
    let attempt = 0;
    while (this.running && generation === this.generation) {
      // Origin: one long-poll cycle is one logical request — its getUpdates
      // call (retries included) and any poll-error warn share this ONE id.
      const pollTraceId = newTraceId();
      try {
        await this.pollOnce(pollTraceId);
        attempt = 0;
      } catch (err) {
        if (!this.running || generation !== this.generation) break;
        this.publish(Operational.Events.Warn, {
          traceId: pollTraceId,
          time: Date.now(),
          component: "server",
          msg: "telegram poll error",
          context: { err: String(err) },
        });
        await this.delay(calculateBackoff(++attempt));
      }
    }
  }
}
