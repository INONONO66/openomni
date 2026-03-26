import { SurfaceKey } from "@openomni/session";
import { Dedupe } from "../serve/dedupe";
import { sleep, splitText, fetchWithRetry } from "../serve/utils";
import { evaluateTriggers, normalizeContent } from "../serve/trigger";
import type { Adapter } from "./types";

// ---------------------------------------------------------------------------
// Discord Gateway opcodes & intents
// ---------------------------------------------------------------------------

const GatewayOp = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

const Intents = {
  GUILDS: 1 << 0,
  GUILD_MESSAGES: 1 << 9,
  DIRECT_MESSAGES: 1 << 12,
  MESSAGE_CONTENT: 1 << 15,
} as const;

// ---------------------------------------------------------------------------
// Discord API types (minimal subset)
// ---------------------------------------------------------------------------

interface DiscordUser {
  id: string;
  username: string;
  bot?: boolean;
}

interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: DiscordUser;
  content: string;
  mentions?: DiscordUser[];
}

interface GatewayPayload {
  op: number;
  d: unknown;
  s: number | null;
  t: string | null;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class DiscordAdapter implements Adapter.Surface {
  readonly id = "discord";
  readonly capabilities: Adapter.Capabilities = {
    streaming: false,
    media: { send: false, receive: false },
    commands: false,
    threads: true,
  };

  private readonly baseUrl = "https://discord.com/api/v10";
  private readonly dedupe = new Dedupe();
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private botId = "";
  private botUsername = "";
  private running = false;
  private handler: Adapter.MessageHandler | null = null;
  private ackReceived = true;
  private reconnectAttempt = 0;
  private readonly maxBackoff = 60_000;
  private readonly FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

  constructor(
    private readonly token: string,
    readonly config: Adapter.Config,
  ) {}

  onMessage(handler: Adapter.MessageHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (!this.handler) {
      throw new Error("[discord] No message handler registered. Call onMessage() before start().");
    }

    this.running = true;
    await this.connect();
  }

  stop(): void {
    this.running = false;
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close(1000);
      this.ws = null;
    }
    console.log("[discord] Bot stopped");
  }

  async send(surfaceKey: string, message: Adapter.OutboundMessage): Promise<void> {
    const parsed = SurfaceKey.parse(surfaceKey);
    let channelId = parsed.id!;

    if (parsed.kind === "dm") {
      const dmChannel = (await this.api("/users/@me/channels", {
        recipient_id: parsed.id!,
      })) as { id: string };
      channelId = dmChannel.id;
    }

    await this.sendOutbound(channelId, message);
  }

  // -- Gateway connection ---------------------------------------------------

  private async connect(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/gateway/bot`, {
      headers: { Authorization: `Bot ${this.token}` },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Discord gateway fetch failed (${res.status}): ${body}`);
    }

    const { url } = (await res.json()) as { url: string };
    const wsUrl = `${url}?v=10&encoding=json`;

    await this.openSocket(wsUrl);
  }

  private async resume(): Promise<void> {
    if (!this.resumeUrl || !this.sessionId) {
      return this.connect();
    }
    await this.openSocket(this.resumeUrl);
  }

  private openSocket(url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;

      let resolved = false;

      ws.addEventListener("message", (event) => {
        const payload = JSON.parse(String(event.data)) as GatewayPayload;
        const ready = this.handleGateway(payload);
        if (ready && !resolved) {
          resolved = true;
          resolve();
        }
      });

      ws.addEventListener("close", async (event) => {
        this.stopHeartbeat();
        if (!resolved) {
          resolved = true;
          reject(new Error(`WebSocket closed before ready: ${event.code}`));
          return;
        }

        const code = event.code;
        if (this.FATAL_CLOSE_CODES.has(code)) {
          this.running = false;
          console.error(`[discord] Fatal close code (${code}), stopping reconnect attempts`);
          return;
        }

        if (this.running) {
          this.reconnectAttempt++;
          const backoffMs = this.calculateBackoff();
          console.log(
            `[discord] Connection closed (${code}), reconnecting in ${Math.round(backoffMs)}ms...`,
          );
          await sleep(backoffMs);
          if (this.running) this.resume().catch(console.error);
        }
      });

      ws.addEventListener("error", (err) => {
        console.error("[discord] WebSocket error:", err);
      });
    });
  }

  // -- Gateway event handling -----------------------------------------------

  private handleGateway(payload: GatewayPayload): boolean {
    if (payload.s !== null) {
      this.sequence = payload.s;
    }

    switch (payload.op) {
      case GatewayOp.HELLO: {
        const d = payload.d as { heartbeat_interval: number };
        this.startHeartbeat(d.heartbeat_interval);

        if (this.sessionId && this.sequence !== null) {
          this.sendGateway({
            op: GatewayOp.RESUME,
            d: {
              token: this.token,
              session_id: this.sessionId,
              seq: this.sequence,
            },
          });
        } else {
          this.identify();
        }
        return false;
      }

      case GatewayOp.HEARTBEAT_ACK:
        this.ackReceived = true;
        return false;

      case GatewayOp.RECONNECT:
        console.log("[discord] Server requested reconnect");
        this.ws?.close(4000);
        return false;

      case GatewayOp.INVALID_SESSION: {
        const resumable = payload.d as boolean;
        console.log(`[discord] Invalid session (resumable: ${resumable})`);
        if (!resumable) {
          this.sessionId = null;
          this.sequence = null;
        }
        this.ws?.close(4000);
        return false;
      }

      case GatewayOp.DISPATCH:
        try {
          return this.handleDispatch(payload.t!, payload.d);
        } catch (err) {
          console.error("[discord] Error handling dispatch:", err);
          return false;
        }

      default:
        return false;
    }
  }

  private handleDispatch(event: string, data: unknown): boolean {
    switch (event) {
      case "READY": {
        const d = data as {
          session_id: string;
          resume_gateway_url: string;
          user: DiscordUser;
        };
        this.sessionId = d.session_id;
        this.resumeUrl = `${d.resume_gateway_url}?v=10&encoding=json`;
        this.botId = d.user.id;
        this.botUsername = d.user.username;
        this.reconnectAttempt = 0;
        console.log(`[discord] Bot started: @${this.botUsername} (${this.botId})`);
        return true;
      }

      case "RESUMED":
        this.reconnectAttempt = 0;
        console.log("[discord] Session resumed");
        return true;

      case "MESSAGE_CREATE": {
        const message = data as DiscordMessage;
        if (message.author.bot) return false;
        if (!message.content) return false;

        // Dedupe
        if (this.dedupe.isDuplicate(message.id)) return false;

        // Build trigger context and evaluate
        const isDM = !message.guild_id;
        const mentioned = message.mentions?.some((u) => u.id === this.botId) ?? false;

        const ctx: Adapter.TriggerContext = {
          event: "message",
          mentioned,
          channelId: message.channel_id,
          senderId: message.author.id,
          isDM,
          text: message.content,
        };

        if (!evaluateTriggers(this.config.triggers, ctx)) return false;

        this.handleIncoming(message, mentioned).catch((err) => {
          console.error("[discord] Error handling message:", err);
        });
        return false;
      }

      default:
        return false;
    }
  }

  // -- Message handling -----------------------------------------------------

  private async handleIncoming(message: DiscordMessage, mentioned: boolean): Promise<void> {
    const channelId = message.channel_id;
    const isDM = !message.guild_id;

    // Strip @mention from content for cleaner LLM input
    let content = message.content;
    if (mentioned && !isDM) {
      content = content.replace(new RegExp(`<@!?${this.botId}>\\s*`), "").trim();
    }

    // Strip prefix via normalizeContent (no botUsername — Discord uses ID-based mentions)
    content = normalizeContent(content, this.config.triggers);
    if (!content) return;

    const surfaceKey = SurfaceKey.fromChannel({
      surface: "discord",
      namespace: this.botId,
      kind: isDM ? "dm" : "channel",
      id: isDM ? message.author.id : channelId,
    });

    console.log(`[discord] ${isDM ? "dm" : channelId}: ${content.slice(0, 80)}`);

    // Typing indicator (repeat every 8s until done)
    this.sendTyping(channelId);
    const typingInterval = setInterval(() => {
      this.sendTyping(channelId);
    }, 8000);

    try {
      const inbound: Adapter.InboundMessage = {
        id: message.id,
        surfaceKey,
        text: content,
        sender: {
          id: message.author.id,
          name: message.author.username,
        },
        raw: message,
      };

      const outbound = await this.getHandler()(inbound);
      if (outbound) await this.sendOutbound(channelId, outbound);
    } catch (err) {
      console.error(`[discord] Error in ${channelId}:`, err);
      await this.sendOutbound(channelId, {
        text: "Sorry, an error occurred.",
      });
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

  private async sendOutbound(channelId: string, message: Adapter.OutboundMessage): Promise<void> {
    if (message.text) {
      const chunks = splitText(message.text, 2000);
      for (const chunk of chunks) {
        await this.api(`/channels/${channelId}/messages`, {
          content: chunk,
        });
      }
    }
    // TODO: handle message.media when capabilities.media.send is enabled
  }

  private sendTyping(channelId: string): void {
    fetch(`${this.baseUrl}/channels/${channelId}/typing`, {
      method: "POST",
      headers: { Authorization: `Bot ${this.token}` },
    }).catch((e) => console.error("[discord] typing indicator error:", e));
  }

  // -- Discord REST helper --------------------------------------------------

  private async api(path: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await fetchWithRetry(
      `${this.baseUrl}${path}`,
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

  // -- Gateway helpers ------------------------------------------------------

  private calculateBackoff(): number {
    return Math.min(1000 * 2 ** this.reconnectAttempt, this.maxBackoff) + Math.random() * 1000;
  }

  private identify(): void {
    this.sendGateway({
      op: GatewayOp.IDENTIFY,
      d: {
        token: this.token,
        intents:
          Intents.GUILDS |
          Intents.GUILD_MESSAGES |
          Intents.DIRECT_MESSAGES |
          Intents.MESSAGE_CONTENT,
        properties: {
          os: "linux",
          browser: "openomni",
          device: "openomni",
        },
      },
    });
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.ackReceived = true;
    this.heartbeatTimer = setInterval(() => {
      if (!this.ackReceived) {
        this.ws?.close();
        return;
      }
      this.sendGateway({ op: GatewayOp.HEARTBEAT, d: this.sequence });
      this.ackReceived = false;
    }, intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private sendGateway(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }
}
