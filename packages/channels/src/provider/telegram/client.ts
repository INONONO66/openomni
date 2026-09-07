import { Operational } from "@openomni/protocol";
import { z } from "zod";
import { fetchWithRetry } from "../../support/fetch-retry";
import type { ChannelClient, PublishPort } from "../../types";
import {
  type TelegramUpdate,
  type TelegramUser,
  TelegramUpdateSchema,
  TelegramUserSchema,
} from "./types";

/** Telegram error envelope carries the flood-wait hint the retry helper reads. */
const RetryAfterSchema = z.object({
  parameters: z.object({ retry_after: z.number().optional() }).optional(),
});

const EnvelopeSchema = z.object({ ok: z.boolean(), description: z.string().optional() });

/** `sendMessage` result — Telegram sends a numeric id; absence means no id to report. */
const SentMessageSchema = z.object({
  message_id: z.union([z.number(), z.string()]).optional(),
});

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly rejected = false,
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

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
  async sendMarkdown(
    channelId: string,
    text: string,
    traceId: string,
  ): Promise<string | undefined> {
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
    const message = await this.api("sendMessage", traceId, SentMessageSchema, {
      chat_id: channelId,
      text,
      ...(parseMode === undefined ? {} : { parse_mode: parseMode }),
    });
    return message.message_id === undefined ? undefined : String(message.message_id);
  }

  async getMe(traceId: string): Promise<TelegramUser> {
    return this.api("getMe", traceId, TelegramUserSchema);
  }

  async getUpdates(
    offset: number,
    traceId: string,
    signal?: AbortSignal,
  ): Promise<TelegramUpdate[]> {
    return this.api(
      "getUpdates",
      traceId,
      z.array(TelegramUpdateSchema),
      { offset, timeout: 30, allowed_updates: ["message"] },
      signal,
    );
  }

  private async api<T>(
    method: string,
    traceId: string,
    schema: z.ZodType<T>,
    params?: Record<string, string | number | string[]>,
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
          const hint = RetryAfterSchema.safeParse(body);
          return (hint.success ? hint.data.parameters?.retry_after : undefined) ?? 5;
        },
        label: `telegram/${method}`,
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new TelegramApiError(
        `Telegram API ${method} failed (${response.status}): ${body}`,
        response.status >= 400 && response.status < 500,
      );
    }

    const raw = (await response.json()) as object;
    const envelope = EnvelopeSchema.safeParse(raw);
    if (!envelope.success) {
      throw new Error(`Telegram API ${method} returned a malformed envelope`);
    }
    if (!envelope.data.ok) {
      throw new TelegramApiError(
        `Telegram API ${method}: ${envelope.data.description ?? "Unknown error"}`,
        true,
      );
    }
    const result = schema.safeParse(Reflect.get(raw, "result"));
    if (!result.success) {
      throw new Error(`Telegram API ${method} returned a malformed result`);
    }
    return result.data;
  }
}
