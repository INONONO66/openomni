import { SurfaceKey } from "@openomni/session";
import { Dedupe } from "../serve/dedupe";
import { sleep, splitText, fetchWithRetry } from "../serve/utils";
import { evaluateTriggers, normalizeContent } from "../serve/trigger";
import type { Adapter } from "./types";

// ---------------------------------------------------------------------------
// Telegram Bot API types (minimal subset)
// ---------------------------------------------------------------------------

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  first_name?: string;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class TelegramAdapter implements Adapter.Surface {
  readonly id = "telegram";
  readonly capabilities: Adapter.Capabilities = {
    streaming: false,
    media: { send: false, receive: false },
    commands: false,
    threads: false,
  };

  private readonly baseUrl: string;
  private readonly dedupe = new Dedupe();
  private offset = 0;
  private running = false;
  private botId = "";
  private botUsername = "";
  private pollController: AbortController | null = null;
  private handler: Adapter.MessageHandler | null = null;

  constructor(
    token: string,
    readonly config: Adapter.Config,
  ) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  onMessage(handler: Adapter.MessageHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (!this.handler) {
      throw new Error("[telegram] No message handler registered. Call onMessage() before start().");
    }

    const me = await this.api<TelegramUser>("getMe");
    this.botId = String(me.id);
    this.botUsername = me.username ?? "";
    console.log(`[telegram] Bot started: @${me.username ?? me.first_name} (${me.id})`);

    this.running = true;
    this.poll();
  }

  stop(): void {
    this.running = false;
    this.pollController?.abort();
    console.log("[telegram] Bot stopped");
  }

  async send(surfaceKey: string, message: Adapter.OutboundMessage): Promise<void> {
    const parsed = SurfaceKey.parse(surfaceKey);
    const chatId = parsed.id!;
    await this.sendOutbound(chatId, message);
  }

  // -- Long polling loop ----------------------------------------------------

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        this.pollController = new AbortController();
        const updates = await this.api<TelegramUpdate[]>(
          "getUpdates",
          {
            offset: this.offset,
            timeout: 30,
            allowed_updates: ["message"],
          },
          this.pollController.signal,
        );

        for (const update of updates) {
          this.offset = update.update_id + 1;

          if (update.message?.text) {
            if (this.dedupe.isDuplicate(String(update.update_id))) continue;

            this.handleUpdate(update.message).catch((err) => {
              console.error("[telegram] Error handling message:", err);
            });
          }
        }
      } catch (err) {
        if (!this.running) break;
        console.error("[telegram] Poll error:", err);
        await sleep(5000);
      }
    }
  }

  // -- Message handling -----------------------------------------------------

  private async handleUpdate(message: TelegramMessage): Promise<void> {
    const text = message.text;
    if (!text) return;

    const userId = message.from?.id;
    const chatId = String(message.chat.id);
    const isDM = message.chat.type === "private";

    // Check for @mention in text
    const mentioned = this.botUsername !== "" && text.includes(`@${this.botUsername}`);

    // Build trigger context and evaluate
    const ctx: Adapter.TriggerContext = {
      event: "message",
      mentioned,
      channelId: chatId,
      senderId: String(userId ?? 0),
      isDM,
      text,
    };

    if (!evaluateTriggers(this.config.triggers, ctx)) return;

    // Strip prefix if a prefix rule matched
    const content = normalizeContent(text, this.config.triggers, this.botUsername);
    if (!content) return;

    const surfaceKey = SurfaceKey.fromChannel({
      surface: "telegram",
      namespace: this.botId,
      kind: "chat",
      id: chatId,
    });

    console.log(`[telegram] ${chatId}: ${content.slice(0, 80)}`);

    // Typing indicator (repeat every 4s until done)
    const typingInterval = setInterval(() => {
      this.api("sendChatAction", { chat_id: chatId, action: "typing" }).catch((e) =>
        console.error("[telegram] typing indicator error:", e),
      );
    }, 4000);
    this.api("sendChatAction", { chat_id: chatId, action: "typing" }).catch((e) =>
      console.error("[telegram] typing indicator error:", e),
    );

    try {
      const inbound: Adapter.InboundMessage = {
        id: String(message.message_id),
        surfaceKey,
        text: content,
        sender: {
          id: String(userId ?? 0),
          name: message.from?.username ?? message.from?.first_name,
        },
        raw: message,
      };

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
    if (message.text) {
      const chunks = splitText(message.text, 4096);
      for (const chunk of chunks) {
        await this.api("sendMessage", {
          chat_id: chatId,
          text: chunk,
        });
      }
    }
    // TODO: handle message.media when capabilities.media.send is enabled
  }

  // -- Telegram API helper --------------------------------------------------

  private async api<T>(
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = `${this.baseUrl}/${method}`;

    const response = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params ?? {}),
        signal,
      },
      {
        parseRetryAfter: (body) => {
          const r = body as { parameters?: { retry_after?: number } };
          return r.parameters?.retry_after ?? 5;
        },
        label: `telegram/${method}`,
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Telegram API ${method} failed (${response.status}): ${body}`);
    }

    const body = (await response.json()) as TelegramResponse<T>;
    if (!body.ok) {
      throw new Error(`Telegram API ${method}: ${body.description ?? "Unknown error"}`);
    }

    return body.result;
  }
}
