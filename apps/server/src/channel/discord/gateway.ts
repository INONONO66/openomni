import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { sleep } from "../../shared/sleep";
import { Heartbeat } from "./heartbeat";
import { handleGatewayPayload, type DispatchState } from "./dispatch-router";
import { GatewayOp, Intents, type GatewayPayload } from "./types";

export interface GatewayCallbacks {
  onDispatch: (event: string, data: unknown) => void;
  onReady: (info: { botId: string; botUsername: string }) => void;
}

export class DiscordGateway {
  private ws: WebSocket | null = null;
  private readonly heartbeat = new Heartbeat();
  private running = false;
  private state: DispatchState = {
    sequence: null,
    sessionId: null,
    resumeUrl: null,
    reconnectAttempt: 0,
  };

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
    this.heartbeat.stop();
    this.ws?.close(1000);
    this.ws = null;
  }

  private async reconnect(): Promise<void> {
    const url =
      this.state.resumeUrl && this.state.sessionId
        ? this.state.resumeUrl
        : await this.fetchGatewayUrl();
    await this.openSocket(url);
  }

  private openSocket(url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      let resolved = false;

      ws.addEventListener("message", (event) => {
        const payload = JSON.parse(String(event.data)) as GatewayPayload;
        const ready = handleGatewayPayload(payload, this.state, {
          sendGateway: (p) => this.sendGateway(p),
          identify: () => this.identify(),
          startHeartbeat: (ms) =>
            this.heartbeat.start(
              ms,
              (p) => this.sendGateway(p),
              () => this.state.sequence,
              () => this.ws?.close(),
            ),
          closeSocket: (code) => this.ws?.close(code),
          stopRunning: () => {
            this.running = false;
          },
          callbacks: this.callbacks,
        });
        if (ready && !resolved) {
          resolved = true;
          resolve();
        }
      });

      ws.addEventListener("close", async (event) => {
        this.heartbeat.stop();
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
          this.state.reconnectAttempt++;
          const backoffMs = calculateBackoff(this.state.reconnectAttempt);
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
            this.reconnect().catch(() =>
              Bus.publish(Operational.Error, {
                traceId: crypto.randomUUID(),
                time: Date.now(),
                component: "server",
                msg: "discord reconnect failed",
                context: { reconnectFailed: true },
              }),
            );
        }
      });

      ws.addEventListener("error", () =>
        Bus.publish(Operational.Error, {
          traceId: crypto.randomUUID(),
          time: Date.now(),
          component: "server",
          msg: "discord websocket error",
          context: { websocketFailed: true },
        }),
      );
    });
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
