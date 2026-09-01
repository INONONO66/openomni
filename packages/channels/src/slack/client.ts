import { fetchWithRetry } from "../support/fetch-retry";
import type { ChannelClient, PublishPort } from "../types";
import { SlackApiError } from "./error";

const BASE_URL = "https://slack.com/api";

/**
 * Slack Web API client. Two tokens by design (Socket Mode): the app-level
 * token (`xapp-`) may ONLY open the socket URL; everything else — identity,
 * DMs, posting — runs on the bot token (`xoxb-`). Slack wraps errors in a
 * 200 body (`{ok:false, error}`), so `ok` is checked on every call.
 */
export class SlackClient implements ChannelClient {
  constructor(
    private readonly botToken: string,
    private readonly appToken: string,
    private readonly publish: PublishPort,
  ) {}

  /** `apps.connections.open` — the only app-token call; returns the Socket Mode wss URL. */
  async openSocketUrl(traceId: string): Promise<string> {
    const data = await this.api("apps.connections.open", {}, traceId, this.appToken);
    const url = (data as { url?: unknown }).url;
    if (typeof url !== "string") {
      throw new SlackApiError({ message: "apps.connections.open returned no url" });
    }
    return url;
  }

  /** Bot identity: user id (mention detection, self-filter) and workspace (endpoint keys). */
  async authTest(traceId: string): Promise<{ botUserId: string; team: string }> {
    const data = (await this.api("auth.test", {}, traceId, this.botToken)) as {
      user_id?: unknown;
      team_id?: unknown;
    };
    if (typeof data.user_id !== "string" || typeof data.team_id !== "string") {
      throw new SlackApiError({ message: "auth.test returned no user_id/team_id" });
    }
    return { botUserId: data.user_id, team: data.team_id };
  }

  async send(channelId: string, text: string, traceId: string): Promise<string | undefined> {
    const data = (await this.api(
      "chat.postMessage",
      { channel: channelId, text },
      traceId,
      this.botToken,
    )) as { ts?: unknown };
    return typeof data.ts === "string" ? data.ts : undefined;
  }

  /** Threaded reply — same postMessage, anchored to the thread root ts. */
  async sendInThread(
    channelId: string,
    threadTs: string,
    text: string,
    traceId: string,
  ): Promise<string | undefined> {
    const data = (await this.api(
      "chat.postMessage",
      { channel: channelId, text, thread_ts: threadTs },
      traceId,
      this.botToken,
    )) as { ts?: unknown };
    return typeof data.ts === "string" ? data.ts : undefined;
  }

  /** DM channel for a user id (`conversations.open`). */
  async openDm(userId: string, traceId: string): Promise<string> {
    const data = (await this.api(
      "conversations.open",
      { users: userId },
      traceId,
      this.botToken,
    )) as { channel?: { id?: unknown } };
    if (typeof data.channel?.id !== "string") {
      throw new SlackApiError({ message: "conversations.open returned no channel id" });
    }
    return data.channel.id;
  }

  private async api(
    method: string,
    body: Record<string, unknown>,
    traceId: string,
    token: string,
  ): Promise<unknown> {
    const res = await fetchWithRetry(
      `${BASE_URL}/${method}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
      },
      { traceId, label: `slack ${method}`, publish: this.publish },
    );
    if (!res.ok) {
      throw new SlackApiError({ message: `slack ${method} failed (${res.status})` });
    }
    const data = (await res.json()) as { ok?: unknown; error?: unknown };
    if (data.ok !== true) {
      throw new SlackApiError({ message: `slack ${method} refused: ${String(data.error)}` });
    }
    return data;
  }
}
