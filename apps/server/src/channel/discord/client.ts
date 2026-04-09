import { fetchWithRetry } from "../../shared/http-helpers";
import type { ChannelClient } from "../types";

const BASE_URL = "https://discord.com/api/v10";

export class DiscordClient implements ChannelClient {
  constructor(private readonly token: string) {}

  async send(channelId: string, text: string): Promise<void> {
    await this.api(`/channels/${channelId}/messages`, { content: text });
  }

  async sendTyping(channelId: string): Promise<void> {
    await fetch(`${BASE_URL}/channels/${channelId}/typing`, {
      method: "POST",
      headers: { Authorization: `Bot ${this.token}` },
    }).catch((e) => console.error("[discord] typing indicator error:", e));
  }

  async createDmChannel(recipientId: string): Promise<string> {
    const channel = (await this.api("/users/@me/channels", {
      recipient_id: recipientId,
    })) as { id: string };
    return channel.id;
  }

  async fetchGatewayUrl(): Promise<string> {
    const res = await fetch(`${BASE_URL}/gateway/bot`, {
      headers: { Authorization: `Bot ${this.token}` },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Discord gateway fetch failed (${res.status}): ${body}`);
    }

    const { url } = (await res.json()) as { url: string };
    return `${url}?v=10&encoding=json`;
  }

  private async api(path: string, body: Record<string, unknown>): Promise<unknown> {
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
        parseRetryAfter: (data) => {
          const r = data as { retry_after?: number };
          return r.retry_after ?? 5;
        },
        label: `discord${path}`,
      },
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Discord API ${path} failed (${res.status}): ${text}`);
    }

    return res.json();
  }
}
