import { newTraceId } from "../../support/trace";
import { type Channel, Operational } from "@openomni/protocol";
import { Dedupe, DedupeWindow } from "../../support/dedupe";
import { handoffInbound } from "../../support/inbound-handoff";
import { type DeliveryReceipt, deliverKeyed } from "../../support/deliver";
import { requireHandler } from "../../support/handler-frame";
import { sendText } from "../../support/send-text";
import { RetryExhaustedError } from "../../support/fetch-retry";
import { TELEGRAM_RENDER } from "./format";
import { TelegramApiError, TelegramClient } from "./client";
import { TelegramNormalizer } from "./normalizer";
import { TelegramPoller } from "./poller";
import type { TelegramMessage } from "./types";
import type { PublishPort } from "../../types";

export class TelegramAdapter implements Channel.Surface {
  readonly id = "telegram";

  private readonly client: TelegramClient;
  private readonly dedupe = new Dedupe();
  private readonly outboundDedupe = new DedupeWindow<DeliveryReceipt>();
  private normalizer: TelegramNormalizer | null = null;
  private poller: TelegramPoller | null = null;
  private handler: Channel.MessageHandler | null = null;

  constructor(
    token: string,
    readonly config: Channel.Config,
    private readonly publish: PublishPort,
  ) {
    this.client = new TelegramClient(token, publish);
  }

  onMessage(handler: Channel.MessageHandler): void {
    this.handler = handler;
  }

  async start(traceId: string): Promise<void> {
    requireHandler(this.handler, "telegram");

    const me = await this.client.getMe(traceId);
    const botId = String(me.id);
    const botUsername = me.username ?? "";
    this.publish(Operational.Events.Info, {
      traceId,
      time: Date.now(),
      component: "server",
      msg: "telegram bot started",
      context: { username: me.username ?? me.first_name, botId: me.id },
    });

    this.normalizer = new TelegramNormalizer({
      botId,
      botUsername,
    });

    this.poller = new TelegramPoller(
      this.client,
      {
        onMessage: (message) => {
          const messageTraceId = newTraceId();
          return handoffInbound({
            dedupe: this.dedupe,
            key: `${message.chat.id}:${message.message_id}`,
            traceId: messageTraceId,
            publish: this.publish,
            errorMessage: "telegram message handling failed",
            rethrowFailure: true,
            handle: () => this.handleMessage(message, messageTraceId),
          });
        },
      },
      this.publish,
    );

    this.poller.start();
  }

  stop(traceId: string): void {
    this.poller?.stop();
    this.publish(Operational.Events.Info, {
      traceId,
      time: Date.now(),
      component: "server",
      msg: "telegram bot stopped",
    });
  }

  /**
   * Existing-agent delivery: a registered ActorEndpoint's externalId is a
   * Telegram chat id — deliver there and report the platform message id of
   * the final chunk (the message a reply would reference).
   */
  deliver(externalId: string, body: string, idempotencyKey: string): Promise<DeliveryReceipt> {
    return deliverKeyed(
      this.outboundDedupe,
      idempotencyKey,
      (traceId) =>
        sendText(body, TELEGRAM_RENDER, (chunk) =>
          this.client.sendMarkdown(externalId, chunk, traceId),
        ),
      (error) =>
        (error instanceof TelegramApiError && error.rejected) ||
        (error instanceof RetryExhaustedError && error.status === 429),
      this.publish,
    );
  }

  private async handleMessage(message: TelegramMessage, traceId: string): Promise<void> {
    if (!this.normalizer) return;
    const text = message.text;
    if (!text) return;
    if (!message.from) return;

    const chatId = String(message.chat.id);
    const inbound = this.normalizer.normalize(message);
    if (!inbound) return;

    this.publish(Operational.Events.Debug, {
      traceId,
      time: Date.now(),
      component: "server",
      msg: "telegram message received",
      context: { chatId },
    });

    await (this.handler as Channel.MessageHandler)(inbound);
  }
}
