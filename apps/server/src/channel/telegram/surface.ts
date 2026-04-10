import type { Adapter } from "@openomni/protocol";
import { Dedupe } from "../../shared/dedupe";
import { splitText } from "../../shared/chunk-text";
import { TelegramClient } from "./client";
import { TelegramNormalizer } from "./normalizer";
import { TelegramPoller } from "./poller";
import type { TelegramMessage } from "./types";

const TELEGRAM_MESSAGE_LIMIT = 4096;

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
  private handler: Adapter.MessageHandler | null = null;

  constructor(
    token: string,
    readonly config: Adapter.Config,
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
    console.log(`[telegram] Bot started: @${me.username ?? me.first_name} (${me.id})`);

    this.normalizer = new TelegramNormalizer({
      botId,
      botUsername,
      triggers: this.config.triggers,
    });

    this.poller = new TelegramPoller(this.client, {
      onMessage: (message) => {
        if (this.dedupe.isDuplicate(String(message.message_id))) return;
        this.handleMessage(message).catch((err) => {
          console.error("[telegram] Error handling message:", err);
        });
      },
    });

    this.poller.start();
  }

  stop(): void {
    this.poller?.stop();
    console.log("[telegram] Bot stopped");
  }

  async send(surfaceKey: string, message: Adapter.OutboundMessage): Promise<void> {
    const { SurfaceKey } = await import("@openomni/session");
    const parsed = SurfaceKey.parse(surfaceKey);
    const chatId = parsed.id ?? "";
    await this.sendOutbound(chatId, message);
  }

  private async handleMessage(message: TelegramMessage): Promise<void> {
    if (!this.normalizer) return;

    const inbound = this.normalizer.normalize(message);
    if (!inbound) return;

    const chatId = String(message.chat.id);
    console.log(`[telegram] ${chatId}: ${inbound.text.slice(0, 80)}`);

    const typingInterval = setInterval(() => {
      this.client.sendTyping(chatId);
    }, 4000);
    this.client.sendTyping(chatId);

    try {
      const outbound = await this.getHandler()(inbound);
      if (outbound) await this.sendOutbound(chatId, outbound);
    } catch (err) {
      console.error(`[telegram] Error in chat ${chatId}:`, err);
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
