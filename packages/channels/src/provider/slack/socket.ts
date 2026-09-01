import { Operational } from "@openomni/protocol";
import { sleep } from "../../support/fetch-retry";
import { calculateBackoff } from "../../support/reconnect-backoff";
import { newTraceId } from "../../support/trace";
import type { PublishPort } from "../../types";
import type { SocketEnvelope } from "./types";

export interface SocketCallbacks {
  /** `traceId` is minted per envelope — the first frame of an inbound Slack event (D11 origin). */
  onEvent: (envelope: SocketEnvelope, traceId: string) => void;
}

/**
 * Slack Socket Mode connection. Far simpler than the discord gateway by
 * protocol design: no client heartbeat (Slack pings at the WebSocket layer
 * and the runtime pongs automatically), no resume — every (re)connect fetches
 * a fresh one-shot wss URL via `apps.connections.open`. The two protocol
 * duties are acking every `events_api` envelope immediately (Slack redelivers
 * unacked envelopes) and reconnecting on `disconnect` frames, which Slack
 * sends routinely to refresh connections.
 */
export class SlackSocket {
  private ws: WebSocket | null = null;
  private running = false;
  private reconnectAttempt = 0;

  constructor(
    private readonly fetchSocketUrl: (traceId: string) => Promise<string>,
    private readonly callbacks: SocketCallbacks,
    private readonly publish: PublishPort,
    private readonly delay: (ms: number) => Promise<void> = sleep,
  ) {}

  async start(): Promise<void> {
    this.running = true;
    await this.openSocket(await this.fetchSocketUrl(newTraceId()));
  }

  stop(): void {
    this.running = false;
    this.ws?.close(1000);
    this.ws = null;
  }

  /**
   * Reconnect with a fresh URL under the shared backoff schedule. The URL
   * fetch itself retries here (bounded by `running`) because it rejects
   * during exactly the transient outages that cluster reconnects — the same
   * failure mode the discord gateway hit in #540.
   */
  private async reconnect(traceId: string): Promise<void> {
    let url: string | undefined;
    while (url === undefined && this.running) {
      try {
        url = await this.fetchSocketUrl(traceId);
      } catch (err) {
        this.reconnectAttempt++;
        const backoffMs = calculateBackoff(this.reconnectAttempt);
        this.publish(Operational.Events.Error, {
          traceId,
          time: Date.now(),
          component: "server",
          msg: "slack socket url fetch failed, retrying",
          context: { err: String(err), backoffMs: Math.round(backoffMs) },
        });
        await this.delay(backoffMs);
      }
    }
    if (url === undefined) return;
    await this.openSocket(url);
  }

  private openSocket(url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      let resolved = false;

      ws.addEventListener("message", (event) => {
        const envelope = this.parseEnvelope(String(event.data));
        if (envelope === undefined) return;
        if (envelope.type === "hello") {
          this.reconnectAttempt = 0;
          if (!resolved) {
            resolved = true;
            resolve();
          }
          return;
        }
        this.handleEnvelope(envelope, ws);
      });

      ws.addEventListener("close", async (event) => {
        if (!resolved) {
          // A close before hello fails THIS start() — the caller owns retry
          // policy at boot; a rejected start must not leave a zombie
          // reconnect loop behind.
          resolved = true;
          this.running = false;
          reject(new Error(`slack socket closed before hello: ${event.code}`));
          return;
        }
        if (!this.running) return;
        this.reconnectAttempt++;
        const backoffMs = calculateBackoff(this.reconnectAttempt);
        // ONE trace for the whole close→backoff→reconnect chain (D11).
        const traceId = newTraceId();
        this.publish(Operational.Events.Warn, {
          traceId,
          time: Date.now(),
          component: "server",
          msg: "slack socket closed, reconnecting",
          context: { code: event.code, backoffMs: Math.round(backoffMs) },
        });
        await this.delay(backoffMs);
        if (this.running) {
          this.reconnect(traceId).catch((err) =>
            this.publish(Operational.Events.Error, {
              traceId,
              time: Date.now(),
              component: "server",
              msg: "slack reconnect failed",
              context: { err: String(err) },
            }),
          );
        }
      });

      ws.addEventListener("error", (err) =>
        this.publish(Operational.Events.Error, {
          traceId: newTraceId(),
          time: Date.now(),
          component: "server",
          msg: "slack websocket error",
          context: { err: String(err) },
        }),
      );
    });
  }

  private parseEnvelope(data: string): SocketEnvelope | undefined {
    try {
      return JSON.parse(data) as SocketEnvelope;
    } catch {
      // One malformed frame must not become an uncaught listener throw.
      this.publish(Operational.Events.Warn, {
        traceId: newTraceId(),
        time: Date.now(),
        component: "server",
        msg: "slack socket frame was not valid JSON; dropped",
      });
      return undefined;
    }
  }

  private handleEnvelope(envelope: SocketEnvelope, ws: WebSocket): void {
    // Ack FIRST: Slack redelivers unacked envelopes, and a handler throw
    // must not turn one poisoned event into an infinite redelivery loop —
    // inbound dedupe in the surface covers the at-least-once remainder.
    if (envelope.envelope_id !== undefined && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    }
    if (envelope.type === "disconnect") {
      // Routine connection refresh: close non-1000 so the close handler reconnects.
      this.publish(Operational.Events.Info, {
        traceId: newTraceId(),
        time: Date.now(),
        component: "server",
        msg: "slack server requested reconnect",
        context: { reason: envelope.reason },
      });
      ws.close(4000);
      return;
    }
    if (envelope.type !== "events_api") return;
    // Origin: the first frame of an inbound Slack event (D11).
    const traceId = newTraceId();
    try {
      this.callbacks.onEvent(envelope, traceId);
    } catch (err) {
      this.publish(Operational.Events.Error, {
        traceId,
        time: Date.now(),
        component: "server",
        msg: "slack event dispatch error",
        context: { err: err instanceof Error ? err.message : String(err) },
      });
    }
  }
}
