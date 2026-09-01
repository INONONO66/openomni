import { Operational } from "@openomni/protocol";
import { fetchWithRetry } from "../../support/fetch-retry";
import type { ChannelClient, PublishPort } from "../../types";
import type { TelegramResponse, TelegramUser } from "./types";

export class TelegramClient implements ChannelClient {
  private readonly baseUrl: string;

  constructor(
    token: string,
    private readonly publish: PublishPort,
  ) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async send(channelId: string, text: string, traceId: string): Promise<string | undefined> {
    return await this.sendMessage(channelId, text, traceId);
  }

  /**
   * MarkdownV2 send with a plain-text floor: rendering is a nice-to-have and
   * a parse rejection must never lose the message, so Telegram's entity-parse
   * refusal downgrades this one send to plain text (recorded as a warning).
   */
  async sendMarkdown(channelId: string, text: string, traceId: string): Promise<string | undefined> {
    try {
      return await this.sendMessage(channelId, text, traceId, "MarkdownV2");
    } catch (error) {
      if (!/can't parse entities/i.test(String(error))) throw error;
      this.publish(Operational.Events.Warn, {
        traceId,
        time: Date.now(),
        component: "server",
        msg: "telegram markdown rejected — delivered as plain text",
        context: { err: String(error) },
      });
      return await this.sendMessage(channelId, text, traceId);
    }
  }

  private async sendMessage(
    channelId: string,
    text: string,
    traceId: string,
    parseMode?: string,
  ): Promise<string | undefined> {
    const message = await this.api<{ message_id?: unknown }>("sendMessage", traceId, {
      chat_id: channelId,
      text,
      ...(parseMode === undefined ? {} : { parse_mode: parseMode }),
    });
    return typeof message.message_id === "number" || typeof message.message_id === "string"
      ? String(message.message_id)
      : undefined;
  }

  async sendTyping(channelId: string, traceId: string): Promise<void> {
    await this.api("sendChatAction", traceId, { chat_id: channelId, action: "typing" }).catch((e) =>
      this.publish(Operational.Events.Warn, {
        traceId,
        time: Date.now(),
        component: "server",
        msg: "telegram typing indicator failed",
        context: { err: String(e) },
      }),
    );
  }

  async getMe(traceId: string): Promise<TelegramUser> {
    return this.api<TelegramUser>("getMe", traceId);
  }

  async getUpdates(
    offset: number,
    traceId: string,
    signal?: AbortSignal,
  ): Promise<Array<{ update_id: number; message?: unknown }>> {
    return this.api<Array<{ update_id: number; message?: unknown }>>(
      "getUpdates",
      traceId,
      { offset, timeout: 30, allowed_updates: ["message"] },
      signal,
    );
  }

  private async api<T>(
    method: string,
    traceId: string,
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
        traceId,
        publish: this.publish,
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
