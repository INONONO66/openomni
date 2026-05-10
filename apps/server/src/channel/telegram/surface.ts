import type { Adapter } from "@openomni/protocol";
import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { Dedupe } from "../../shared/dedupe";
import { splitText } from "../../shared/chunk-text";
import { TelegramClient } from "./client";
import { TelegramNormalizer } from "./normalizer";
import { TelegramPoller } from "./poller";
import type { TelegramMessage } from "./types";
import { ChannelAuthnMiddleware, type ChannelAuthnDecisionObserver } from "../channel-authn";

const TELEGRAM_MESSAGE_LIMIT = 4096;

export interface TelegramAuthOptions {
  readonly onDecision?: ChannelAuthnDecisionObserver;
}

export class TelegramAdapter implements Adapter.Surface {
  readonly id = "telegram";
  readonly capabilities: Adapter.Capabilities = {
    streaming: false,
    media: { send: false, receive: false },
    commands: false,
    threads: false,
  };

  private readonly client: TelegramClient;
  private readonly dedupe = new Dedupe();
  private normalizer: TelegramNormalizer | null = null;
  private poller: TelegramPoller | null = null;
  private botUsername = "";
  private handler: Adapter.MessageHandler | null = null;

  constructor(
    token: string,
    readonly config: Adapter.Config,
    private readonly authOptions: TelegramAuthOptions = {},
  ) {
    this.client = new TelegramClient(token);
  }

  onMessage(handler: Adapter.MessageHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (!this.handler) {
      throw new Error("[telegram] No message handler registered. Call onMessage() before start().");
    }

    const me = await this.client.getMe();
    const botId = String(me.id);
    const botUsername = me.username ?? "";
    this.botUsername = botUsername;
    Bus.publish(Operational.Info, {
      traceId: crypto.randomUUID(),
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

    this.poller = new TelegramPoller(this.client, {
      onMessage: (message) => {
        if (this.dedupe.isDuplicate(String(message.message_id))) return;
        this.handleMessage(message).catch((err) => {
          Bus.publish(Operational.Error, {
            traceId: crypto.randomUUID(),
            time: Date.now(),
            component: "server",
            msg: "telegram message handling failed",
            context: { err: String(err) },
          });
        });
      },
    });

    this.poller.start();
  }

  stop(): void {
    this.poller?.stop();
    Bus.publish(Operational.Info, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "server",
      msg: "telegram bot stopped",
    });
  }

  async send(surfaceKey: string, message: Adapter.OutboundMessage): Promise<void> {
    const { SurfaceKey } = await import("@openomni/session");
    const parsed = SurfaceKey.parse(surfaceKey);
    const chatId = parsed.id ?? "";
    await this.sendOutbound(chatId, message);
  }

  private async handleMessage(message: TelegramMessage): Promise<void> {
    if (!this.normalizer) return;
    const text = message.text;
    if (!text) return;
    if (!message.from) return;

    const chatId = String(message.chat.id);
    const auth = ChannelAuthnMiddleware.authenticateTelegramTriggers({
      triggers: this.config.triggers,
      ctx: {
        event: "message",
        mentioned: this.botUsername !== "" && text.includes(`@${this.botUsername}`),
        channelId: chatId,
        senderId: String(message.from.id),
        isDM: message.chat.type === "private",
        text,
      },
      ...(this.authOptions.onDecision !== undefined
        ? { onDecision: this.authOptions.onDecision }
        : {}),
    });
    if (auth.verdict.action === "abort") return;

    const inbound = this.normalizer.normalize(message);
    if (!inbound) return;

    Bus.publish(Operational.Debug, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      component: "server",
      msg: "telegram message received",
      context: { chatId },
    });

    const typingInterval = setInterval(() => {
      this.client.sendTyping(chatId);
    }, 4000);
    this.client.sendTyping(chatId);

    try {
      const outbound = await this.getHandler()(inbound);
      if (outbound) await this.sendOutbound(chatId, outbound);
    } catch (err) {
      Bus.publish(Operational.Error, {
        traceId: crypto.randomUUID(),
        time: Date.now(),
        component: "server",
        msg: "telegram message handler error",
        context: { chatId, err: String(err) },
      });
      await this.sendOutbound(chatId, { text: "Sorry, an error occurred." });
    } finally {
      clearInterval(typingInterval);
    }
  }

  private getHandler(): Adapter.MessageHandler {
    if (!this.handler) {
      throw new Error(`[${this.id}] No handler registered. Call onMessage() before processing.`);
    }
    return this.handler;
  }

  private async sendOutbound(chatId: string, message: Adapter.OutboundMessage): Promise<void> {
    if (!message.text) return;
    const chunks = splitText(message.text, TELEGRAM_MESSAGE_LIMIT);
    for (const chunk of chunks) {
      await this.client.send(chatId, chunk);
    }
  }
}
