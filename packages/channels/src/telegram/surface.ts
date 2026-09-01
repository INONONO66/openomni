import { newTraceId } from "../support/trace";
import { type Channel, Operational, PolicyDecision } from "@openomni/protocol";
import { Dedupe, DedupeWindow } from "../support/dedupe";
import { chunkMarkdown } from "../support/format/chunk";
import { renderTelegramMarkdown } from "../support/format/telegram";
import { TelegramClient } from "./client";
import { TelegramNormalizer } from "./normalizer";
import { TelegramPoller } from "./poller";
import type { TelegramMessage } from "./types";
import type { PublishPort } from "../types";
import { ChannelAuthnMiddleware, type ChannelAuthnDecisionObserver } from "../channel-authn";

const TELEGRAM_MESSAGE_LIMIT = 4096;

export interface TelegramAuthOptions {
  readonly onDecision?: ChannelAuthnDecisionObserver;
}

export class TelegramAdapter implements Channel.Surface {
  readonly id = "telegram";

  private readonly client: TelegramClient;
  private readonly dedupe = new Dedupe();
  private readonly outboundDedupe = new DedupeWindow<{ externalMessageId?: string }>();
  private normalizer: TelegramNormalizer | null = null;
  private poller: TelegramPoller | null = null;
  private botUsername = "";
  private handler: Channel.MessageHandler | null = null;

  constructor(
    token: string,
    readonly config: Channel.Config,
    private readonly publish: PublishPort,
    private readonly authOptions: TelegramAuthOptions = {},
  ) {
    this.client = new TelegramClient(token, publish);
  }

  onMessage(handler: Channel.MessageHandler): void {
    this.handler = handler;
  }

  async start(traceId: string): Promise<void> {
    if (!this.handler) {
      throw new Error("[telegram] No message handler registered. Call onMessage() before start().");
    }

    const me = await this.client.getMe(traceId);
    const botId = String(me.id);
    const botUsername = me.username ?? "";
    this.botUsername = botUsername;
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
      triggers: this.config.triggers,
    });

    this.poller = new TelegramPoller(
      this.client,
      {
        onMessage: async (message) => {
          // D1: message_id is a PER-CHAT counter, so two different chats can
          // share one id within the dedupe window — key by chat to avoid
          // silently dropping the second chat's message.
          const dedupeKey = `${message.chat.id}:${message.message_id}`;
          const acquisition = this.dedupe.acquire(dedupeKey);
          if (acquisition.duplicate) return;
          const dedupeToken = acquisition.token;
          // Origin: the first frame of an inbound telegram message — this ONE
          // mint is the message's trace, carried to the run (D11).
          const messageTraceId = newTraceId();
          try {
            await this.handleMessage(message, messageTraceId);
          } catch (err) {
            this.dedupe.forget(dedupeKey, dedupeToken);
            this.publish(Operational.Events.Error, {
              traceId: messageTraceId,
              time: Date.now(),
              component: "server",
              msg: "telegram message handling failed",
              context: { err: String(err) },
            });
            throw err;
          }
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
  async deliver(
    externalId: string,
    body: string,
    idempotencyKey?: string,
  ): Promise<{ externalMessageId?: string }> {
    const send = async (): Promise<{ externalMessageId?: string }> => {
      // Origin: the messaging kernel's deliver seam does not thread the
      // sender's trace yet (#215) — this delivery is its own causal chain.
      const traceId = newTraceId();
      const externalMessageId = await this.sendOutbound(externalId, { text: body }, traceId);
      return externalMessageId === undefined ? {} : { externalMessageId };
    };
    // Additive capability only: the current server composition calls this
    // seam without a key, which intentionally retains at-least-once behavior.
    return idempotencyKey === undefined ? send() : this.outboundDedupe.run(idempotencyKey, send);
  }

  private async handleMessage(message: TelegramMessage, traceId: string): Promise<void> {
    if (!this.normalizer) return;
    const text = message.text;
    if (!text) return;
    if (!message.from) return;

    const chatId = String(message.chat.id);
    const auth = ChannelAuthnMiddleware.authenticateTelegramTriggers({
      triggers: this.config.triggers,
      ctx: {
        event: "message",
        // Word-boundary match: `@foo` must not count a mention of `@foobar`.
        mentioned:
          this.botUsername !== "" &&
          new RegExp(`@${this.botUsername}(?![A-Za-z0-9_])`).test(text),
        channelId: chatId,
        senderId: String(message.from.id),
        isDM: message.chat.type === "private",
        text,
      },
      ...(this.authOptions.onDecision !== undefined
        ? { onDecision: this.authOptions.onDecision }
        : {}),
    });
    if (PolicyDecision.isBlocking(auth.verdict)) return;

    const inbound = this.normalizer.normalize(message, traceId);
    if (!inbound) return;

    this.publish(Operational.Events.Debug, {
      traceId,
      time: Date.now(),
      component: "server",
      msg: "telegram message received",
      context: { chatId },
    });

    const typingInterval = setInterval(() => {
      this.client.sendTyping(chatId, traceId);
    }, 4000);
    this.client.sendTyping(chatId, traceId);

    try {
      const outbound = await this.getHandler()(inbound);
      if (outbound) await this.sendOutbound(chatId, outbound, traceId);
    } catch (err) {
      this.publish(Operational.Events.Error, {
        traceId,
        time: Date.now(),
        component: "server",
        msg: "telegram message handler error",
        context: { chatId, err: String(err) },
      });
      await this.sendOutbound(chatId, { text: "Sorry, an error occurred." }, traceId);
    } finally {
      clearInterval(typingInterval);
    }
  }

  private getHandler(): Channel.MessageHandler {
    if (!this.handler) {
      throw new Error(`[${this.id}] No handler registered. Call onMessage() before processing.`);
    }
    return this.handler;
  }

  private async sendOutbound(
    chatId: string,
    message: Channel.OutboundMessage,
    traceId: string,
  ): Promise<string | undefined> {
    if (!message.text) return undefined;
    let lastMessageId: string | undefined;
    const rendered = renderTelegramMarkdown(message.text);
    for (const chunk of chunkMarkdown(rendered, TELEGRAM_MESSAGE_LIMIT)) {
      lastMessageId = (await this.client.sendMarkdown(chatId, chunk, traceId)) ?? lastMessageId;
    }
    return lastMessageId;
  }
}
