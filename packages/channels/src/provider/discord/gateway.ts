import { newTraceId } from "../../support/trace";
import { Operational } from "@openomni/protocol";
import { sleep } from "../../support/fetch-retry";
import { SocketReconnectShell, type SocketSettle } from "../../support/socket-shell";
import type { PublishPort } from "../../types";
import {
  type GatewayFrame,
  GatewayFrameSchema,
  GatewayOp,
  HelloDataSchema,
  Intents,
  ReadyDataSchema,
} from "./types";

const DISCORD_SHELL_MESSAGES = {
  urlFetchFailed: "discord gateway url fetch failed, retrying",
  closed: "discord connection closed, reconnecting",
  reconnectFailed: "discord reconnect failed",
  socketError: "discord websocket error",
} as const;

export interface GatewayCallbacks {
  /** `traceId` is minted per dispatch — the first frame of an inbound gateway event (D11 origin). */
  onDispatch: (event: string, data: object, traceId: string) => void;
  onReady: (info: { botId: string; botUsername: string }) => void;
}

/**
 * Accept a READY resume URL only when it points at a Discord gateway origin
 * (`wss://*.discord.gg`) or the same origin the trusted gateway-URL fetch
 * connected to; anything else returns null, which falls back to a freshly
 * fetched gateway URL on the next reconnect.
 */
function validResumeUrl(raw: string, trustedOrigin: string | null): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  const host = parsed.hostname;
  const discordGateway =
    parsed.protocol === "wss:" && (host === "discord.gg" || host.endsWith(".discord.gg"));
  if (!(discordGateway || parsed.origin === trustedOrigin)) {
    return null;
  }
  return `${raw}?v=10&encoding=json`;
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
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatAckReceived = true;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  /** Origin of the last trusted (fetched, not payload-provided) gateway URL. */
  private gatewayOrigin: string | null = null;
  private readonly shell: SocketReconnectShell;

  constructor(
    private readonly token: string,
    private readonly fetchGatewayUrl: () => Promise<string>,
    private readonly callbacks: GatewayCallbacks,
    private readonly publish: PublishPort,
    delay: (ms: number) => Promise<void> = sleep,
  ) {
    this.shell = new SocketReconnectShell(publish, DISCORD_SHELL_MESSAGES, delay, (url) =>
      this.openSocket(url),
    );
  }

  async start(): Promise<void> {
    this.shell.begin();
    await this.openSocket(await this.fetchTrustedGatewayUrl());
  }

  /** Fetch a gateway URL and remember its origin as the trusted resume anchor. */
  private async fetchTrustedGatewayUrl(): Promise<string> {
    const url = await this.fetchGatewayUrl();
    try {
      this.gatewayOrigin = new URL(url).origin;
    } catch {
      this.gatewayOrigin = null;
    }
    return url;
  }

  stop(): void {
    this.stopHeartbeat();
    this.shell.stop();
  }

  private reconnect(traceId: string): Promise<void> {
    // A resumable session reconnects straight to its pinned resume URL. A
    // cold reconnect needs a fresh gateway URL from Discord's REST API —
    // fetched under the shell's shared backoff (#540). openSocket stays
    // OUTSIDE that retry: socket-level failures already re-enter through the
    // close handler, and retrying them here too would overlap that chain.
    return this.resumeUrl && this.sessionId
      ? this.openSocket(this.resumeUrl)
      : this.shell.reconnectVia(() => this.fetchTrustedGatewayUrl(), traceId);
  }

  private openSocket(url: string): Promise<void> {
    return this.shell.openWebSocket(url, (ws, settle) => this.wireSocket(ws, settle));
  }

  private wireSocket(ws: WebSocket, settle: SocketSettle): void {
    ws.addEventListener("message", (event) => {
      let raw: object;
      try {
        raw = JSON.parse(String(event.data)) as object;
      } catch {
        // One malformed frame must not become an uncaught listener throw;
        // drop it — the gateway's own heartbeat/close handling recovers.
        this.shell.warnDrop("discord gateway frame was not valid JSON; dropped");
        return;
      }
      const frame = GatewayFrameSchema.safeParse(raw);
      if (!frame.success) {
        this.shell.warnDrop("discord gateway frame had no op envelope; dropped");
        return;
      }
      if (this.handlePayload(frame.data, raw)) settle.resolveOnce();
    });

    ws.addEventListener("close", async (event) => {
      this.stopHeartbeat();
      settle.rejectOnce(new Error(`WebSocket closed before ready: ${event.code}`));
      if (FATAL_CLOSE_CODES.has(event.code)) {
        this.shell.end();
        this.publish(Operational.Events.Error, {
          traceId: newTraceId(),
          time: Date.now(),
          component: "server",
          msg: "discord gateway fatal close code",
          context: { code: event.code },
        });
        return;
      }
      if (this.shell.running) {
        await this.shell.scheduleReconnect(event.code, (traceId) => this.reconnect(traceId));
      }
    });
  }

  /** Routes one gateway payload; returns true when the connection is ready. */
  private handlePayload(frame: GatewayFrame, raw: object): boolean {
    // typeof guard, not `!== null`: a MISSING s would otherwise assign
    // undefined, and `seq: undefined` in RESUME gets dropped by
    // JSON.stringify — the same serialization class as the #520 token bug.
    if (typeof frame.s === "number") this.sequence = frame.s;
    const d = Reflect.get(raw, "d");

    switch (frame.op) {
      case GatewayOp.HELLO: {
        const hello = HelloDataSchema.safeParse(d);
        // A malformed interval falls to the clamp's floor rather than dropping
        // the frame — HELLO must always answer with IDENTIFY/RESUME.
        this.startHeartbeat(hello.success ? hello.data.heartbeat_interval : Number.NaN);
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
      // The op notice and the close→reconnect chain it triggers carry two
      // ids on purpose: threading the notice's id through instance state
      // could leak it across UNRELATED close events, which is worse than an
      // orphaned chain head (#653 review).
      case GatewayOp.RECONNECT:
        this.publish(Operational.Events.Info, {
          traceId: newTraceId(),
          time: Date.now(),
          component: "server",
          msg: "discord server requested reconnect",
        });
        this.shell.closeSocket(4000);
        return false;
      case GatewayOp.INVALID_SESSION: {
        const resumable = d === true;
        this.publish(Operational.Events.Warn, {
          traceId: newTraceId(),
          time: Date.now(),
          component: "server",
          msg: "discord invalid session",
          context: { resumable },
        });
        if (!resumable) {
          this.sessionId = null;
          this.sequence = null;
        }
        this.shell.closeSocket(4000);
        return false;
      }
      case GatewayOp.DISPATCH:
        return frame.t != null && typeof d === "object" && d !== null
          ? this.handleDispatch(frame.t, d)
          : false;
      default:
        return false;
    }
  }

  private handleDispatch(event: string, data: object): boolean {
    if (event === "READY") {
      const ready = ReadyDataSchema.safeParse(data);
      if (!ready.success) {
        this.publish(Operational.Events.Warn, {
          traceId: newTraceId(),
          time: Date.now(),
          component: "server",
          msg: "discord READY payload malformed; dropped",
        });
        return false;
      }
      this.sessionId = ready.data.session_id;
      // The resume URL arrives in a server payload; pin it to Discord's
      // gateway origin before it can ever become a socket target, so a
      // spoofed READY cannot redirect the resume connection elsewhere.
      this.resumeUrl = validResumeUrl(ready.data.resume_gateway_url, this.gatewayOrigin);
      this.shell.reset();
      this.callbacks.onReady({ botId: ready.data.user.id, botUsername: ready.data.user.username });
      return true;
    }
    if (event === "RESUMED") {
      this.shell.reset();
      this.publish(Operational.Events.Info, {
        traceId: newTraceId(),
        time: Date.now(),
        component: "server",
        msg: "discord session resumed",
      });
      return true;
    }
    // Origin: the first frame of an inbound gateway event — this ONE mint is
    // the message's trace, carried through the surface to the run (D11).
    const traceId = newTraceId();
    try {
      this.callbacks.onDispatch(event, data, traceId);
    } catch (err) {
      this.publish(Operational.Events.Error, {
        traceId,
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
    // The interval arrives from the gateway payload (network input). Clamp it
    // so a malformed HELLO can neither busy-loop the process (0/negative/NaN)
    // nor zombify the connection with a never-firing heartbeat (CodeQL
    // js/resource-exhaustion). Discord's real value is ~41250ms; the 100ms
    // floor bounds timer pressure while keeping fake-gateway state-machine
    // tests fast. Explicit comparison guard (not Math.min/max) so the taint
    // barrier is analyzable.
    let clampedMs = 100;
    if (Number.isFinite(intervalMs) && intervalMs >= 100 && intervalMs <= 300_000) {
      clampedMs = intervalMs;
    } else if (intervalMs > 300_000) {
      clampedMs = 300_000;
    }
    this.stopHeartbeat();
    this.heartbeatAckReceived = true;
    this.heartbeatTimer = setInterval(() => {
      if (!this.heartbeatAckReceived) {
        // Missed ack: zombied connection. Close with a non-1000 code so the
        // session stays resumable (Discord treats 1000/1001 as a clean
        // goodbye and invalidates the session).
        this.shell.closeSocket(4000);
        return;
      }
      this.sendGateway({ op: GatewayOp.HEARTBEAT, d: this.sequence });
      this.heartbeatAckReceived = false;
    }, clampedMs);
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

  private sendGateway(payload: object): void {
    this.shell.sendJson(payload);
  }
}

const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
