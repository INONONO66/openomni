import { Operational } from "@openomni/protocol";
import { fetchWithRetry } from "../support/fetch-retry";
import type { ChannelClient, PublishPort } from "../types";
import type { TelegramResponse, TelegramUser } from "./types";

export class TelegramClient implements ChannelClient {
  private readonly baseUrl: string;

  constructor(
    token: string,
    private readonly publish: PublishPort,
  ) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async send(channelId: string, text: string): Promise<string | undefined> {
    const message = await this.api<{ message_id?: unknown }>("sendMessage", {
      chat_id: channelId,
      text,
    });
    return typeof message.message_id === "number" || typeof message.message_id === "string"
      ? String(message.message_id)
      : undefined;
  }

  async sendTyping(channelId: string): Promise<void> {
    await this.api("sendChatAction", { chat_id: channelId, action: "typing" }).catch((e) =>
      this.publish(Operational.Warn, {
        traceId: crypto.randomUUID(),
        time: Date.now(),
        component: "server",
        msg: "telegram typing indicator failed",
        context: { err: String(e) },
      }),
    );
  }

  async getMe(): Promise<TelegramUser> {
    return this.api<TelegramUser>("getMe");
  }

  async getUpdates(
    offset: number,
    signal?: AbortSignal,
  ): Promise<Array<{ update_id: number; message?: unknown }>> {
    return this.api<Array<{ update_id: number; message?: unknown }>>(
      "getUpdates",
      { offset, timeout: 30, allowed_updates: ["message"] },
      signal,
    );
  }

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
