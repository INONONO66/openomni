import { z } from "zod";
import { fetchWithRetry } from "../../support/fetch-retry";
import type { ChannelClient, PublishPort } from "../../types";
import { DiscordApiError, DiscordGatewayFetchError } from "./error";

const BASE_URL = "https://discord.com/api/v10";

/** Discord rate-limit body carries the wait in seconds. */
const RetryAfterSchema = z.object({ retry_after: z.number().optional() });

/** Created message — the snowflake id anchors reply threading; absence means nothing to anchor. */
const CreatedMessageSchema = z.object({ id: z.string().optional() });

const DmChannelSchema = z.object({ id: z.string().optional() });

const GatewayUrlSchema = z.object({ url: z.string() });

export class DiscordClient implements ChannelClient {
  constructor(
    private readonly token: string,
    private readonly publish: PublishPort,
  ) {}

  async send(channelId: string, text: string, traceId: string): Promise<string | undefined> {
    const message = await this.api(
      `/channels/${channelId}/messages`,
      { content: text },
      traceId,
      CreatedMessageSchema,
    );
    return message.id;
  }

  async createDmChannel(recipientId: string, traceId: string): Promise<string> {
    const channel = await this.api(
      "/users/@me/channels",
      { recipient_id: recipientId },
      traceId,
      DmChannelSchema,
    );
    if (channel.id === undefined) {
      throw new DiscordApiError({
        message: "Discord DM channel response carried no string id",
      });
    }
    return channel.id;
  }

  async fetchGatewayUrl(): Promise<string> {
    const res = await fetch(`${BASE_URL}/gateway/bot`, {
      headers: { Authorization: `Bot ${this.token}` },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new DiscordGatewayFetchError({
        message: `Discord gateway fetch failed (${res.status}): ${body}`,
      });
    }

    const gateway = GatewayUrlSchema.safeParse(await res.json());
    if (!gateway.success) {
      throw new DiscordGatewayFetchError({
        message: "Discord gateway response carried no url",
      });
    }
    return `${gateway.data.url}?v=10&encoding=json`;
  }

  private async api<T>(
    path: string,
    body: Record<string, string>,
    traceId: string,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const res = await fetchWithRetry(
      `${BASE_URL}${path}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      {
        traceId,
        publish: this.publish,
        parseRetryAfter: (data) => {
          const hint = RetryAfterSchema.safeParse(data);
          return (hint.success ? hint.data.retry_after : undefined) ?? 5;
        },
        label: `discord${path}`,
      },
    );

    if (!res.ok) {
      const text = await res.text();
      throw new DiscordApiError({
        message: `Discord API ${path} failed (${res.status}): ${text}`,
        rejected: res.status >= 400 && res.status < 500,
      });
    }

    const parsed = schema.safeParse(await res.json());
    if (!parsed.success) {
      throw new DiscordApiError({
        message: `Discord API ${path} returned a malformed body`,
      });
    }
    return parsed.data;
  }
}
