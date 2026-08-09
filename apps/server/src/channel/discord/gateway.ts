import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { sleep } from "../../shared/sleep";
import { GatewayOp, Intents, type DiscordUser, type GatewayPayload } from "./types";

export interface GatewayCallbacks {
  onDispatch: (event: string, data: unknown) => void;
  onReady: (info: { botId: string; botUsername: string }) => void;
}

/**
 * Discord gateway connection state machine. Heartbeat and payload routing
 * live INSIDE this class (#520): the former heartbeat.ts/dispatch-router.ts
 * satellite split severed the two data paths the protocol depends on — no
 * code path delivered HEARTBEAT_ACK to the ack flag (so the missed-ack
 * watchdog force-closed every ~2 intervals), and the router had no token
 * access so RESUME serialized `token: undefined` (dropped by JSON.stringify;
 * Discord answers INVALID_SESSION and every resume degraded to re-identify).
 */
export class DiscordGateway {
  private ws: WebSocket | null = null;
  private running = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatAckReceived = true;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private reconnectAttempt = 0;

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
        const payload = JSON.parse(String(event.data)) as GatewayPayload;
        const ready = this.handlePayload(payload);
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
        }
        if (FATAL_CLOSE_CODES.has(event.code)) {
          this.running = false;
          Bus.publish(Operational.Error, {
            traceId: crypto.randomUUID(),
            time: Date.now(),
            component: "server",
            msg: "discord gateway fatal close code",
            context: { code: event.code },
          });
          return;
        }
        if (this.running) {
          this.reconnectAttempt++;
          const backoffMs = calculateBackoff(this.reconnectAttempt);
          Bus.publish(Operational.Warn, {
            traceId: crypto.randomUUID(),
            time: Date.now(),
            component: "server",
            msg: "discord connection closed, reconnecting",
            context: {
              code: event.code,
              backoffMs: Math.round(backoffMs),
            },
          });
          await sleep(backoffMs);
          if (this.running)
            this.reconnect().catch((err) =>
              Bus.publish(Operational.Error, {
                traceId: crypto.randomUUID(),
                time: Date.now(),
                component: "server",
                msg: "discord reconnect failed",
                context: { err: String(err) },
              }),
            );
        }
      });

      ws.addEventListener("error", (err) =>
        Bus.publish(Operational.Error, {
          traceId: crypto.randomUUID(),
          time: Date.now(),
          component: "server",
          msg: "discord websocket error",
          context: { err: String(err) },
        }),
      );
    });
  }

  /** Routes one gateway payload; returns true when the connection is ready. */
  private handlePayload(payload: GatewayPayload): boolean {
    // typeof guard, not `!== null`: a MISSING s would otherwise assign
    // undefined, and `seq: undefined` in RESUME gets dropped by
    // JSON.stringify — the same serialization class as the #520 token bug.
    if (typeof payload.s === "number") this.sequence = payload.s;

    switch (payload.op) {
      case GatewayOp.HELLO: {
        const d = payload.d as { heartbeat_interval: number };
        this.startHeartbeat(d.heartbeat_interval);
        if (this.sessionId && this.sequence !== null) {
          // #520 fix 2: the REAL token — `token: undefined` was dropped by
          // JSON.stringify and Discord answered INVALID_SESSION on every
          // resume attempt.
          this.sendGateway({
            op: GatewayOp.RESUME,
            d: { token: this.token, session_id: this.sessionId, seq: this.sequence },
          });
        } else {
          this.identify();
        }
        return false;
      }
      case GatewayOp.HEARTBEAT:
        // Server-requested heartbeat: the docs require an immediate beat,
        // else the server closes the connection.
        this.sendGateway({ op: GatewayOp.HEARTBEAT, d: this.sequence });
        return false;
      case GatewayOp.HEARTBEAT_ACK:
        // #520 fix 1: the ack has to reach the watchdog flag — before the
        // re-merge nothing set it, so every connection was force-closed
        // after ~2 heartbeat intervals.
        this.heartbeatAckReceived = true;
        return false;
      case GatewayOp.RECONNECT:
        Bus.publish(Operational.Info, {
          traceId: crypto.randomUUID(),
          time: Date.now(),
          component: "server",
          msg: "discord server requested reconnect",
        });
        this.ws?.close(4000);
        return false;
      case GatewayOp.INVALID_SESSION: {
        const resumable = payload.d as boolean;
        Bus.publish(Operational.Warn, {
          traceId: crypto.randomUUID(),
          time: Date.now(),
          component: "server",
          msg: "discord invalid session",
          context: { resumable },
        });
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
      Bus.publish(Operational.Info, {
        traceId: crypto.randomUUID(),
        time: Date.now(),
        component: "server",
        msg: "discord session resumed",
      });
      return true;
    }
    try {
      this.callbacks.onDispatch(event, data);
    } catch (err) {
      Bus.publish(Operational.Error, {
        traceId: crypto.randomUUID(),
        time: Date.now(),
        component: "server",
        msg: "discord dispatch error",
        context: {
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
      });
    }
    return false;
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.heartbeatAckReceived = true;
    this.heartbeatTimer = setInterval(() => {
      if (!this.heartbeatAckReceived) {
        // Missed ack: zombied connection. Close with a non-1000 code so the
        // session stays resumable (Discord treats 1000/1001 as a clean
        // goodbye and invalidates the session).
        this.ws?.close(4000);
        return;
      }
      this.sendGateway({ op: GatewayOp.HEARTBEAT, d: this.sequence });
      this.heartbeatAckReceived = false;
    }, intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
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

  private sendGateway(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }
}

// merged from reconnect-backoff.ts (#453 hygiene: sub-30-LOC single-importer)
export const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const MAX_BACKOFF_MS = 60_000;

export function calculateBackoff(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS) + Math.random() * 1000;
}
