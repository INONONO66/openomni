import { Deferred, Effect, Exit, Result } from "effect";
import { Operational } from "@openomni/protocol";
import type { EffectRunner, PublishPort } from "../types";
import { RECONNECT_ATTEMPT_BOUND, reconnectSchedule } from "./schedule";
import { ThrownError } from "./thrown";
import { newTraceId } from "./trace";

/** Settle-once view of the open Deferred a surface wires its listeners against. */
export interface SocketSettle {
  readonly resolveOnce: () => void;
  readonly rejectOnce: (err: Error) => void;
  readonly settled: () => boolean;
  readonly current: () => boolean;
}

/** The per-surface log lines the shell speaks with — pinned by the surface tests. */
interface SocketShellMessages {
  /** A reconnect attempt failed (URL fetch or socket open); retrying under the schedule. */
  readonly urlFetchFailed: string;
  /** Connection closed; a reconnect streak starts. */
  readonly closed: string;
  /** The reconnect streak exhausted its bound — the shell is dead. */
  readonly reconnectFailed: string;
  /** The transport reported a socket-level error. */
  readonly socketError: string;
}

/**
 * Shared reconnect shell for the two socket surfaces (discord gateway, slack
 * Socket Mode), rebuilt on Effect (#1248). One close starts ONE bounded
 * reconnect streak: `Effect.retry` under the shared jittered schedule
 * (exponential from 1s, 60s cap), at most `RECONNECT_ATTEMPT_BOUND` attempts,
 * every delay on the injected clock. A ready connection completes the streak,
 * so the next close starts a fresh schedule — no attempt counter to reset.
 * `stop()` settles the halt Deferred, which interrupts a sleeping streak
 * through `Effect.raceFirst` — no generation counters. An exhausted streak marks
 * the shell dead: `sendJson` drops frames and no further attempt is scheduled;
 * driver death is a published Error, never a silent retry loop (#540 stays
 * covered: URL-fetch rejections are just failed attempts under the schedule).
 * Protocol judgment (resume vs fresh URL, fatal close codes, ack duties,
 * heartbeats) stays in each surface.
 */
export class SocketReconnectShell {
  private ws: WebSocket | null = null;
  private state: "idle" | "running" | "dead" = "idle";
  private halt: Deferred.Deferred<void> | null = null;
  private streakActive = false;
  /** Settles the pending open when a newer socket replaces it. */
  private settleOpen: (() => void) | null = null;

  constructor(
    private readonly publish: PublishPort,
    private readonly messages: SocketShellMessages,
    /** The surface's socket opener (its own listeners wired via openWebSocket). */
    private readonly open: (url: string) => Promise<void>,
    /** Injected clock, UUID source, and Effect runner — never ambient. */
    private readonly options: {
      readonly now: () => number;
      readonly id: () => string;
      readonly run: EffectRunner;
    },
    /** Reconnect policy — the shared jittered schedule unless a test injects a faster one. */
    private readonly schedule: typeof reconnectSchedule = reconnectSchedule,
  ) {}

  /** The intent flag: true from begin() until end()/stop() or streak exhaustion. */
  get running(): boolean {
    return this.state === "running";
  }

  begin(): void {
    this.stop();
    this.state = "running";
    this.halt = Deferred.makeUnsafe<void>();
  }

  /** Terminal stop: the shell is dead — sendJson drops, nothing reconnects. */
  end(): void {
    this.shutdown("dead");
  }

  /** Intentional stop: settle the halt (interrupting any streak), then close. */
  stop(): void {
    this.shutdown("idle");
  }

  private shutdown(next: "idle" | "dead"): void {
    this.state = next;
    if (this.halt !== null) {
      Deferred.doneUnsafe(this.halt, Exit.void);
      this.halt = null;
    }
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000);
  }

  /** Initial connect: ONE url fetch and open — boot retry policy belongs to the caller. */
  async connect(fetchUrl: () => Promise<string>): Promise<void> {
    if (this.state !== "running") return;
    const url = await fetchUrl();
    if (this.state === "running") await this.open(url);
  }

  /**
   * One bounded reconnect streak for one close. The close itself is the
   * streak's first failure, so the first attempt already waits one schedule
   * step. Every attempt (URL fetch or socket open) that rejects is published
   * on the streak's ONE trace id (D11) and retried; `stop()` interrupts the
   * streak mid-sleep via the halt race; exhaustion kills the shell loudly.
   * Re-entrant calls (the failed attempt's own close event) are no-ops —
   * the running streak already owns the retry.
   */
  async scheduleReconnect(
    closeCode: number,
    reconnect: (traceId: string) => Promise<void>,
  ): Promise<void> {
    const halt = this.halt;
    if (this.state !== "running" || this.streakActive || halt === null) return;
    this.streakActive = true;
    const traceId = newTraceId(this.options.id);
    this.publish(Operational.Events.Warn, {
      traceId,
      time: this.options.now(),
      component: "server",
      msg: this.messages.closed,
      context: { code: closeCode },
    });
    let closed: Error | null = new Error(`socket closed (${closeCode})`);
    const attempt = Effect.suspend(() => {
      const first = closed;
      if (first !== null) {
        closed = null;
        return Effect.fail(first);
      }
      return Effect.tryPromise({
        try: () => reconnect(traceId),
        catch: (cause) => {
          const error = ThrownError.parse(cause);
          this.publish(Operational.Events.Error, {
            traceId,
            time: this.options.now(),
            component: "server",
            msg: this.messages.urlFetchFailed,
            context: { err: String(error) },
          });
          return error;
        },
      });
    });
    const streak = attempt.pipe(
      Effect.retry({
        schedule: this.schedule,
        times: RECONNECT_ATTEMPT_BOUND,
        while: () => this.state === "running",
      }),
    );
    const outcome = await this.options.run(
      Effect.result(Effect.raceFirst(streak, Deferred.await(halt))),
    );
    this.streakActive = false;
    if (Result.isFailure(outcome) && this.state === "running") {
      this.publish(Operational.Events.Error, {
        traceId,
        time: this.options.now(),
        component: "server",
        msg: this.messages.reconnectFailed,
        context: { err: String(outcome.failure), attempts: RECONNECT_ATTEMPT_BOUND },
      });
      this.shutdown("dead");
    }
  }

  /**
   * Deferred-adapted WebSocket open, shared by both sockets: the surface
   * wires its message/close listeners; the settle-once guard and the error
   * listener live here. The returned promise settles at most once — late
   * closes after ready re-enter through the surface's reconnect handling —
   * and a halt (stop/end) releases it without a socket.
   */
  openWebSocket(url: string, wire: (ws: WebSocket, settle: SocketSettle) => void): Promise<void> {
    const halt = this.halt;
    if (this.state !== "running" || halt === null) return Promise.resolve();
    const previous = this.ws;
    this.ws = null;
    this.settleOpen?.();
    previous?.close(1000);
    const ws = new WebSocket(url);
    this.ws = ws;
    const ready = Deferred.makeUnsafe<void, Error>();
    let resolved = false;
    const resolveOnce = () => {
      if (!resolved) {
        resolved = true;
        Deferred.doneUnsafe(ready, Exit.void);
      }
    };
    this.settleOpen = resolveOnce;
    const current = () => this.state === "running" && this.ws === ws;
    wire(ws, {
      resolveOnce,
      rejectOnce: (err) => {
        if (!resolved) {
          resolved = true;
          Deferred.doneUnsafe(ready, Exit.fail(err));
        }
      },
      settled: () => resolved,
      current,
    });
    const onError = this.socketErrorListener();
    ws.addEventListener("error", (event) => {
      if (current()) onError(event);
    });
    return this.options
      .run(Effect.result(Effect.raceFirst(Deferred.await(ready), Deferred.await(halt))))
      .then((outcome) => {
        if (Result.isFailure(outcome)) throw outcome.failure;
      });
  }

  /** Send one JSON frame when the current socket is open; a closed socket or a dead shell drops it. */
  sendJson(payload: object): void {
    if (this.state === "running" && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  /** Close the current socket with the given code; keeps custody so a reconnect can replace it. */
  closeSocket(code: number): void {
    this.ws?.close(code);
  }

  /** Listener for the WebSocket `error` event. */
  socketErrorListener(): (err: Event) => void {
    return (err) =>
      this.publish(Operational.Events.Error, {
        traceId: newTraceId(this.options.id),
        time: this.options.now(),
        component: "server",
        msg: this.messages.socketError,
        context: { err: String(err) },
      });
  }

  /** A frame that cannot enter the state machine is dropped loudly, never thrown. */
  warnDrop(msg: string): void {
    this.publish(Operational.Events.Warn, {
      traceId: newTraceId(this.options.id),
      time: this.options.now(),
      component: "server",
      msg,
    });
  }
}
