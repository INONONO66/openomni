import { Operational } from "@openomni/protocol";
import { fetchWithRetry } from "../support/fetch-retry";
import type { ChannelClient, PublishPort } from "../types";
import { DiscordApiError, DiscordGatewayFetchError } from "./error";

const BASE_URL = "https://discord.com/api/v10";

export class DiscordClient implements ChannelClient {
  constructor(
    private readonly token: string,
    private readonly publish: PublishPort,
  ) {}

  async send(channelId: string, text: string, traceId: string): Promise<string | undefined> {
    const message = (await this.api(
      `/channels/${channelId}/messages`,
      { content: text },
      traceId,
    )) as {
      id?: unknown;
    };
    return typeof message.id === "string" ? message.id : undefined;
  }

  async sendTyping(channelId: string, traceId: string): Promise<void> {
    await fetch(`${BASE_URL}/channels/${channelId}/typing`, {
      method: "POST",
      headers: { Authorization: `Bot ${this.token}` },
    }).catch((e) =>
      this.publish(Operational.Events.Warn, {
        traceId,
        time: Date.now(),
        component: "server",
        msg: "discord typing indicator failed",
        context: { err: String(e) },
      }),
    );
  }

  async createDmChannel(recipientId: string, traceId: string): Promise<string> {
    const channel = (await this.api(
      "/users/@me/channels",
      { recipient_id: recipientId },
      traceId,
    )) as { id?: unknown };
    if (typeof channel.id !== "string") {
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

    const { url } = (await res.json()) as { url: string };
    return `${url}?v=10&encoding=json`;
  }

  private async api(
    path: string,
    body: Record<string, unknown>,
    traceId: string,
  ): Promise<unknown> {
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
          const r = data as { retry_after?: number };
          return r.retry_after ?? 5;
        },
        label: `discord${path}`,
      },
    );

    if (!res.ok) {
      const text = await res.text();
      throw new DiscordApiError({
        message: `Discord API ${path} failed (${res.status}): ${text}`,
      });
    }

    return res.json();
  }
}
