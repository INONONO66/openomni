import { Operational } from "@openomni/protocol";
import type { PublishPort } from "../types";
import { calculateBackoff } from "./reconnect-backoff";
import { newTraceId } from "./trace";

/** Settle-once view of the open promise a surface wires its listeners against. */
export interface SocketSettle {
  readonly resolveOnce: () => void;
  readonly rejectOnce: (err: Error) => void;
  readonly settled: () => boolean;
}

/** The per-surface log lines the shell speaks with — pinned by the surface tests. */
export interface SocketShellMessages {
  /** URL fetch rejected during a reconnect; retrying under backoff. */
  readonly urlFetchFailed: string;
  /** Connection closed; a reconnect is scheduled. */
  readonly closed: string;
  /** The reconnect chain itself rejected terminally. */
  readonly reconnectFailed: string;
  /** The transport reported a socket-level error. */
  readonly socketError: string;
}

/**
 * Shared reconnect shell for the two socket surfaces (discord gateway, slack
 * Socket Mode). Owns the backoff attempt counter and the three moves both
 * protocols share: retrying the connect-URL fetch through transient outages
 * (#540 — a single rejection used to terminate the reconnect chain and leave
 * the bot silently offline until a process restart), scheduling the
 * close→backoff→reconnect chain under ONE trace id (D11: the close notice,
 * every url-fetch retry, and a terminal reconnect failure read back as a
 * single causal sequence), and reporting socket-level errors. Protocol
 * judgment (resume vs fresh URL, fatal close codes, ack duties, heartbeats)
 * stays in each surface.
 */
export class SocketReconnectShell {
  private attempt = 0;
  private ws: WebSocket | null = null;
  private active = false;

  constructor(
    private readonly publish: PublishPort,
    private readonly messages: SocketShellMessages,
    private readonly delay: (ms: number) => Promise<void>,
    /** The surface's socket opener (its own listeners wired via openWebSocket). */
    private readonly open: (url: string) => Promise<void>,
  ) {}

  /** The intent flag: true from begin() until end()/stop(); every retry loop is bounded by it. */
  get running(): boolean {
    return this.active;
  }

  begin(): void {
    this.active = true;
  }

  /** Mark stopped without touching the socket (e.g. a pre-ready close already closed it). */
  end(): void {
    this.active = false;
  }

  /** Intentional stop: mark stopped, close cleanly, release the socket. */
  stop(): void {
    this.active = false;
    this.ws?.close(1000);
    this.ws = null;
  }

  /** The connection reached its ready state — backoff starts over. */
  reset(): void {
    this.attempt = 0;
  }

  /**
   * Fetch a connect URL, retrying under the shared backoff schedule while
   * `isRunning()` holds. Returns undefined when stopped mid-retry so the
   * caller ends cleanly — no socket, no schedule. Retries inherit the
   * caller's trace: every retry of ONE reconnect is one causal chain.
   */
  async fetchUrlUnderBackoff(
    fetchUrl: () => Promise<string>,
    traceId: string,
  ): Promise<string | undefined> {
    let url: string | undefined;
    while (url === undefined && this.active) {
      try {
        url = await fetchUrl();
      } catch (err) {
        this.attempt++;
        const backoffMs = calculateBackoff(this.attempt);
        this.publish(Operational.Events.Error, {
          traceId,
          time: Date.now(),
          component: "server",
          msg: this.messages.urlFetchFailed,
          context: { err: String(err), backoffMs: Math.round(backoffMs) },
        });
        await this.delay(backoffMs);
      }
    }
    return url;
  }

  /** Fetch-under-backoff, then open: the shared tail of both surfaces' reconnect. */
  async reconnectVia(fetchUrl: () => Promise<string>, traceId: string): Promise<void> {
    const url = await this.fetchUrlUnderBackoff(fetchUrl, traceId);
    // Stopped during the fetch-retry loop → end cleanly, no socket, no schedule.
    if (url === undefined) return;
    await this.open(url);
  }

  /** Backoff, then hand ONE trace id to the surface's reconnect; its terminal rejection is recorded, never thrown. */
  async scheduleReconnect(
    closeCode: number,
    reconnect: (traceId: string) => Promise<void>,
  ): Promise<void> {
    this.attempt++;
    const backoffMs = calculateBackoff(this.attempt);
    const traceId = newTraceId();
    this.publish(Operational.Events.Warn, {
      traceId,
      time: Date.now(),
      component: "server",
      msg: this.messages.closed,
      context: { code: closeCode, backoffMs: Math.round(backoffMs) },
    });
    await this.delay(backoffMs);
    if (this.active) {
      reconnect(traceId).catch((err) =>
        this.publish(Operational.Events.Error, {
          traceId,
          time: Date.now(),
          component: "server",
          msg: this.messages.reconnectFailed,
          context: { err: String(err) },
        }),
      );
    }
  }

  /**
   * Promise-adapted WebSocket open, shared by both sockets: the surface
   * wires its message/close listeners; the settle-once guard and the error
   * listener live here. The promise resolves/rejects at most once — late
   * closes after ready re-enter through the surface's reconnect handling.
   */
  openWebSocket(url: string, wire: (ws: WebSocket, settle: SocketSettle) => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      let resolved = false;
      wire(ws, {
        resolveOnce: () => {
          if (!resolved) {
            resolved = true;
            resolve();
          }
        },
        rejectOnce: (err) => {
          if (!resolved) {
            resolved = true;
            reject(err);
          }
        },
        settled: () => resolved,
      });
      ws.addEventListener("error", this.socketErrorListener());
    });
  }

  /** Send one JSON frame when the current socket is open; a closed socket drops it (the protocol re-syncs on reconnect). */
  sendJson(payload: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  /** Close the current socket with the given code; keeps custody so a reconnect can replace it. */
  closeSocket(code: number): void {
    this.ws?.close(code);
  }

  /** Listener for the WebSocket `error` event. */
  socketErrorListener(): (err: Event) => void {
    return (err) =>
      this.publish(Operational.Events.Error, {
        traceId: newTraceId(),
        time: Date.now(),
        component: "server",
        msg: this.messages.socketError,
        context: { err: String(err) },
      });
  }

  /** A frame that cannot enter the state machine is dropped loudly, never thrown. */
  warnDrop(msg: string): void {
    this.publish(Operational.Events.Warn, {
      traceId: newTraceId(),
      time: Date.now(),
      component: "server",
      msg,
    });
  }
}
