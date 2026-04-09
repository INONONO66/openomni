import { sleep } from "../../shared/http-helpers";
import { GatewayOp, Intents, type DiscordUser, type GatewayPayload } from "./types";

export interface GatewayCallbacks {
  onDispatch: (event: string, data: unknown) => void;
  onReady: (info: { botId: string; botUsername: string }) => void;
}

const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const MAX_BACKOFF_MS = 60_000;

export class DiscordGateway {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private ackReceived = true;
  private reconnectAttempt = 0;
  private running = false;

  constructor(
    private readonly token: string,
    private readonly fetchGatewayUrl: () => Promise<string>,
    private readonly callbacks: GatewayCallbacks,
  ) {}

  async start(): Promise<void> {
    this.running = true;
    await this.openSocket(await this.fetchGatewayUrl());
  }

  stop(): void {
    this.running = false;
    this.stopHeartbeat();
    this.ws?.close(1000);
    this.ws = null;
  }

  private async reconnect(): Promise<void> {
    const url = this.resumeUrl && this.sessionId ? this.resumeUrl : await this.fetchGatewayUrl();
    await this.openSocket(url);
  }

  private openSocket(url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      let resolved = false;

      ws.addEventListener("message", (event) => {
        const ready = this.handleGateway(JSON.parse(String(event.data)) as GatewayPayload);
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
        if (FATAL_CLOSE_CODES.has(event.code)) {
          this.running = false;
          console.error(`[discord] Fatal close code (${event.code}), stopping reconnect attempts`);
          return;
        }
        if (this.running) {
          this.reconnectAttempt++;
          const backoffMs = this.calculateBackoff();
          console.log(
            `[discord] Connection closed (${event.code}), reconnecting in ${Math.round(backoffMs)}ms...`,
          );
          await sleep(backoffMs);
          if (this.running) this.reconnect().catch(console.error);
        }
      });

      ws.addEventListener("error", (err) => console.error("[discord] WebSocket error:", err));
    });
  }

  private handleGateway(payload: GatewayPayload): boolean {
    if (payload.s !== null) this.sequence = payload.s;

    switch (payload.op) {
      case GatewayOp.HELLO: {
        const d = payload.d as { heartbeat_interval: number };
        this.startHeartbeat(d.heartbeat_interval);
        if (this.sessionId && this.sequence !== null) {
          this.sendGateway({
            op: GatewayOp.RESUME,
            d: { token: this.token, session_id: this.sessionId, seq: this.sequence },
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
        return payload.t ? this.handleDispatch(payload.t, payload.d) : false;
      default:
        return false;
    }
  }

  private handleDispatch(event: string, data: unknown): boolean {
    if (event === "READY") {
      const d = data as { session_id: string; resume_gateway_url: string; user: DiscordUser };
      this.sessionId = d.session_id;
      this.resumeUrl = `${d.resume_gateway_url}?v=10&encoding=json`;
      this.reconnectAttempt = 0;
      this.callbacks.onReady({ botId: d.user.id, botUsername: d.user.username });
      return true;
    }
    if (event === "RESUMED") {
      this.reconnectAttempt = 0;
      console.log("[discord] Session resumed");
      return true;
    }
    try {
      this.callbacks.onDispatch(event, data);
    } catch (err) {
      console.error("[discord] Error handling dispatch:", err);
    }
    return false;
  }

  private calculateBackoff(): number {
    return Math.min(1000 * 2 ** this.reconnectAttempt, MAX_BACKOFF_MS) + Math.random() * 1000;
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
        properties: { os: "linux", browser: "openomni", device: "openomni" },
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
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }
}
