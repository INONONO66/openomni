import { Operational } from "@openomni/protocol";
import { sleep } from "../../support/fetch-retry";
import { SocketReconnectShell } from "../../support/socket-shell";
import { newTraceId } from "../../support/trace";
import type { PublishPort } from "../../types";
import { type SocketEnvelope, SocketEnvelopeSchema } from "./types";

const SLACK_SHELL_MESSAGES = {
  urlFetchFailed: "slack socket url fetch failed, retrying",
  closed: "slack socket closed, reconnecting",
  reconnectFailed: "slack reconnect failed",
  socketError: "slack websocket error",
} as const;

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
  private readonly shell: SocketReconnectShell;

  constructor(
    private readonly fetchSocketUrl: (traceId: string) => Promise<string>,
    private readonly callbacks: SocketCallbacks,
    private readonly publish: PublishPort,
    delay: (ms: number) => Promise<void> = sleep,
  ) {
    this.shell = new SocketReconnectShell(publish, SLACK_SHELL_MESSAGES, delay, (url) =>
      this.openSocket(url),
    );
  }

  async start(): Promise<void> {
    this.shell.begin();
    await this.openSocket(await this.fetchSocketUrl(newTraceId()));
  }

  stop(): void {
    this.shell.stop();
  }

  /**
   * Reconnect with a fresh URL under the shared backoff schedule. The URL
   * fetch itself retries here (bounded by `running`) because it rejects
   * during exactly the transient outages that cluster reconnects — the same
   * failure mode the discord gateway hit in #540.
   */
  private reconnect(traceId: string): Promise<void> {
    return this.shell.reconnectVia(() => this.fetchSocketUrl(traceId), traceId);
  }

  private openSocket(url: string): Promise<void> {
    return this.shell.openWebSocket(url, (ws, settle) => {
      ws.addEventListener("message", (event) => {
        const envelope = this.parseEnvelope(String(event.data));
        if (envelope === undefined) return;
        if (envelope.type === "hello") {
          this.shell.reset();
          settle.resolveOnce();
          return;
        }
        this.handleEnvelope(envelope, ws);
      });

      ws.addEventListener("close", async (event) => {
        if (!settle.settled()) {
          // A close before hello fails THIS start() — the caller owns retry
          // policy at boot; a rejected start must not leave a zombie
          // reconnect loop behind.
          this.shell.end();
          settle.rejectOnce(new Error(`slack socket closed before hello: ${event.code}`));
          return;
        }
        if (!this.shell.running) return;
        await this.shell.scheduleReconnect(event.code, (traceId) => this.reconnect(traceId));
      });
    });
  }

  private parseEnvelope(data: string): SocketEnvelope | undefined {
    let raw: object;
    try {
      raw = JSON.parse(data) as object;
    } catch {
      // One malformed frame must not become an uncaught listener throw.
      this.shell.warnDrop("slack socket frame was not valid JSON; dropped");
      return undefined;
    }
    const envelope = SocketEnvelopeSchema.safeParse(raw);
    if (!envelope.success) {
      this.shell.warnDrop("slack socket frame had no envelope shape; dropped");
      return undefined;
    }
    return envelope.data;
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
