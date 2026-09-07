import { afterEach, describe, expect, it } from "bun:test";
import type { ServerWebSocket } from "bun";
import { DiscordGateway } from "../src/provider/discord/gateway";
import { GatewayOp } from "../src/provider/discord/types";
import type { SocketReconnectShell } from "../src/support/socket-shell";
import type { PublishPort } from "../src/types";

const noopPublish: PublishPort = () => undefined;

/**
 * #520 state-machine pins over a real WebSocket against a scripted fake
 * Discord gateway. The two production defects this suite exists for:
 *   1. HEARTBEAT_ACK never reached the watchdog flag → every connection was
 *      force-closed after ~2 heartbeat intervals;
 *   2. RESUME serialized `token: undefined` (dropped by JSON.stringify) →
 *      every resume degraded to re-identify.
 */

type Payload = { op: number; d?: unknown; s?: number | null; t?: string | null };

type NativeClose = { code: number; reason: string; wasClean: boolean; phase: string };
const serverTraces = new WeakMap<ServerWebSocket<unknown>, (event: string, data: object) => void>();

type FakeGateway = {
  url: string;
  received: Payload[];
  closes: number[];
  clients: Set<ServerWebSocket<unknown>>;
  nativeCloses: NativeClose[];
  record(event: string, data: object): void;
  waitFor(predicate: (payload: Payload) => boolean, count?: number): Promise<Payload>;
  waitForClose(): Promise<number>;
  pendingCloseWaiters(): number;
  stop(): void;
};

class EventStream<Value> {
  private readonly subscribers = new Set<{
    predicate: (value: Value) => boolean;
    remaining: number;
    resolve: (value: Value) => void;
    timer: ReturnType<typeof setTimeout> | undefined;
  }>();

  waitFor(
    predicate: (value: Value) => boolean,
    count = 1,
    timeoutMs = 10_000,
  ): Promise<Value> {
    return new Promise<Value>((resolve, reject) => {
      const subscriber = { predicate, remaining: count, resolve, timer: undefined } as {
        predicate: (value: Value) => boolean;
        remaining: number;
        resolve: (value: Value) => void;
        timer: ReturnType<typeof setTimeout> | undefined;
      };
      // Resolution is event-driven; this timer only rejects when the signal never fires.
      subscriber.timer = setTimeout(() => {
        this.subscribers.delete(subscriber);
        reject(new Error("timed out waiting for gateway signal"));
      }, timeoutMs);
      this.subscribers.add(subscriber);
    });
  }

  pending(): number {
    return this.subscribers.size;
  }

  emit(value: Value): void {
    for (const subscriber of this.subscribers) {
      if (!subscriber.predicate(value)) continue;
      subscriber.remaining -= 1;
      if (subscriber.remaining > 0) continue;
      if (subscriber.timer !== undefined) clearTimeout(subscriber.timer);
      this.subscribers.delete(subscriber);
      subscriber.resolve(value);
    }
  }
}

const immediateDelay = () => Promise.resolve();

function createFakeGateway(options: {
  heartbeatIntervalMs: number;
  ackHeartbeats: boolean;
  rejectUpgrade?: boolean;
  onIdentify?: (ws: ServerWebSocket<unknown>) => void;
  onResume?: (ws: ServerWebSocket<unknown>, payload: Payload) => void;
}): FakeGateway {
  const received: Payload[] = [];
  const closes: number[] = [];
  const clients = new Set<ServerWebSocket<unknown>>();
  const nativeCloses: NativeClose[] = [];
  const events: object[] = [];
  const record = (event: string, data: object) => {
    events.push({ time: performance.now(), event, ...data });
  };
  const payloadEvents = new EventStream<Payload>();
  const closeEvents = new EventStream<number>();
  const send = (ws: ServerWebSocket<unknown>, payload: Payload) => {
    record("server.send", payload);
    return ws.send(JSON.stringify(payload));
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      record("server.request", { url: req.url, key: req.headers.get("sec-websocket-key") });
      if (options.rejectUpgrade) {
        record("server.rejectUpgrade", { status: 200 });
        return new Response("upgrade rejected", { status: 200 });
      }
      const upgraded = srv.upgrade(req);
      record("server.upgrade", { upgraded });
      if (upgraded) return;
      return new Response("expected websocket", { status: 400 });
    },
    websocket: {
      open(ws) {
        clients.add(ws);
        serverTraces.set(ws, record);
        record("server.open", {});
        send(ws, {
          op: GatewayOp.HELLO,
          d: { heartbeat_interval: options.heartbeatIntervalMs },
          s: null,
          t: null,
        });
      },
      message(ws, message) {
        const payload = JSON.parse(String(message)) as Payload;
        received.push(payload);
        record("server.receive", payload);
        if (payload.op === GatewayOp.HEARTBEAT && options.ackHeartbeats) {
          send(ws, { op: GatewayOp.HEARTBEAT_ACK, s: null, t: null });
        }
        if (payload.op === GatewayOp.IDENTIFY) {
          options.onIdentify?.(ws);
        }
        if (payload.op === GatewayOp.RESUME) {
          options.onResume?.(ws, payload);
        }
        payloadEvents.emit(payload);
      },
      close(ws, code) {
        clients.delete(ws);
        closes.push(code);
        record("server.close", { code });
        closeEvents.emit(code);
      },
    },
  });

  const url = `ws://127.0.0.1:${server.port}`;
  return {
    url,
    received,
    closes,
    clients,
    nativeCloses,
    record,
    waitFor: (predicate, count) => payloadEvents.waitFor(predicate, count),
    waitForClose: () => closeEvents.waitFor(() => true),
    pendingCloseWaiters: () => closeEvents.pending(),
    stop: () => {
      server.stop(true);
      console.error("discord gateway fixture trace", JSON.stringify({ url, events }));
    },
  };
}

function createTracedGateway(
  local: FakeGateway,
  ...args: ConstructorParameters<typeof DiscordGateway>
) {
  const gateway = new DiscordGateway(...args);
  // Per-instance wire interception: never patch the native constructor or a global prototype.
  const shell = Reflect.get(gateway, "shell") as SocketReconnectShell;
  const openWebSocket = shell.openWebSocket.bind(shell);
  let connection = 0;
  shell.openWebSocket = (url, wire) => {
    const id = ++connection;
    let phase = "connecting";
    local.record("client.connect", { id, url });
    return openWebSocket(url, (ws, settle) => {
      ws.addEventListener("open", () => {
        phase = "open";
        local.record("client.open", { id });
      });
      ws.addEventListener("message", (event) => {
        local.record("client.message", { id, data: String(event.data) });
      });
      ws.addEventListener("close", (event) => {
        const close = { code: event.code, reason: event.reason, wasClean: event.wasClean, phase };
        local.nativeCloses.push(close);
        local.record("client.close", { id, ...close });
        console.error("discord gateway native close", JSON.stringify({ url, id, ...close }));
      });
      wire(ws, {
        ...settle,
        resolveOnce: () => {
          phase = "ready";
          local.record("client.ready", { id });
          settle.resolveOnce();
        },
      });
    });
  };
  return gateway;
}

function createMissedAckHarness(local: FakeGateway) {
  const backoffStarted = Promise.withResolvers<void>();
  const releaseBackoff = Promise.withResolvers<void>();
  let clientClosed: Promise<number> | undefined;
  const gateway = createTracedGateway(
    local,
    "test-token",
    () => Promise.resolve(local.url),
    {
      onDispatch: () => undefined,
      onReady: () => {
        // Subscribe synchronously before READY settles start and before any
        // watchdog tick; a failed handshake must not allocate this waiter.
        clientClosed = local.waitForClose();
      },
    },
    noopPublish,
    () => {
      backoffStarted.resolve();
      return releaseBackoff.promise;
    },
  );

  return {
    gateway,
    backoffStarted: backoffStarted.promise,
    get clientClosed() {
      return clientClosed;
    },
    get nativeClose() {
      return local.nativeCloses.at(-1);
    },
    async start() {
      try {
        await gateway.start();
      } catch (error) {
        console.error("discord gateway test start failure", JSON.stringify(local.nativeCloses.at(-1)));
        throw error;
      }
    },
    stop() {
      // Stop before releasing backoff, including when start/assertions fail.
      gateway.stop();
      releaseBackoff.resolve();
    },
  };
}

function sendReady(ws: ServerWebSocket<unknown>, url: string, sessionId: string): void {
  serverTraces.get(ws)?.("server.ready", { url, sessionId });
  ws.send(
    JSON.stringify({
      op: GatewayOp.DISPATCH,
      t: "READY",
      s: 1,
      d: {
        session_id: sessionId,
        resume_gateway_url: url,
        user: { id: "bot-1", username: "openomni-test" },
      },
    }),
  );
}

describe("discord gateway state machine (#520)", () => {
  let fake: FakeGateway | undefined;
  let gateway: DiscordGateway | undefined;

  afterEach(() => {
    gateway?.stop();
    fake?.stop();
    gateway = undefined;
    fake = undefined;
  });

  it("identifies with the real token and survives many heartbeat intervals when acked", async () => {
    const local = createFakeGateway({
      heartbeatIntervalMs: 100,
      ackHeartbeats: true,
      onIdentify: (ws) => sendReady(ws, local.url, "sess-1"),
    });
    fake = local;
    gateway = createTracedGateway(
      local,
      "test-token",
      () => Promise.resolve(local.url),
      {
        onDispatch: () => undefined,
        onReady: () => undefined,
      },
      noopPublish,
    );

    const identifyReceived = local.waitFor((payload) => payload.op === GatewayOp.IDENTIFY);
    // The heartbeat timer is the behavior under test; completion follows the fifth payload event.
    const fiveHeartbeatsReceived = local.waitFor(
      (payload) => payload.op === GatewayOp.HEARTBEAT,
      5,
    );
    await gateway.start();
    const identify = await identifyReceived;
    expect((identify.d as { token: string }).token).toBe("test-token");

    // Pin for defect 1: before the ack was wired, the watchdog closed the
    // socket on the SECOND interval. Five heartbeat events on one live socket
    // prove that acknowledgements keep reaching the watchdog flag.
    await fiveHeartbeatsReceived;
    const heartbeats = local.received.filter((p) => p.op === GatewayOp.HEARTBEAT);
    expect(heartbeats.length).toBeGreaterThanOrEqual(3);
    expect(local.closes).toHaveLength(0);
    expect(local.clients.size).toBe(1);
  });

  it("closes a zombied connection with a resume-safe non-1000 code on missed ack", async () => {
    const local = createFakeGateway({
      heartbeatIntervalMs: 40,
      ackHeartbeats: false,
      onIdentify: (ws) => sendReady(ws, local.url, "sess-2"),
    });
    fake = local;
    const harness = createMissedAckHarness(local);
    gateway = harness.gateway;
    try {
      await harness.start();
      expect(harness.clientClosed).toBeDefined();
      const closeCode = await harness.clientClosed;
      await harness.backoffStarted;
      // Stop before releasing the backoff so the reconnect loop cannot race
      // teardown; the resume path itself is pinned by the next test.
      harness.stop();
      expect(closeCode).toBe(4000);
      const heartbeats = local.received.filter((p) => p.op === GatewayOp.HEARTBEAT);
      expect(heartbeats.length).toBe(1);
    } finally {
      harness.stop();
    }
  });

  it("resumes with the real token, session id, and sequence after a server-requested reconnect", async () => {
    let resumed: Payload | undefined;
    const local = createFakeGateway({
      heartbeatIntervalMs: 5_000,
      ackHeartbeats: true,
      onIdentify: (ws) => {
        sendReady(ws, local.url, "sess-3");
        // Server-initiated reconnect right after READY: the client must
        // close (resumable) and come back with RESUME, not IDENTIFY.
        ws.send(JSON.stringify({ op: GatewayOp.RECONNECT, s: null, t: null }));
      },
      onResume: (ws, payload) => {
        resumed = payload;
        ws.send(JSON.stringify({ op: GatewayOp.DISPATCH, t: "RESUMED", s: 2, d: {} }));
      },
    });
    fake = local;
    const sessionResumed = Promise.withResolvers<void>();
    gateway = createTracedGateway(
      local,
      "test-token",
      () => Promise.resolve(local.url),
      {
        onDispatch: () => undefined,
        onReady: () => undefined,
      },
      (_event, data) => {
        const payload = data as { msg?: unknown };
        if (payload.msg === "discord session resumed") sessionResumed.resolve();
      },
      immediateDelay,
    );

    const resumeReceived = local.waitFor((payload) => payload.op === GatewayOp.RESUME);
    await gateway.start();
    const resume = await resumeReceived;
    await sessionResumed.promise;
    // Pin for defect 2: the payload carries the REAL token (the old router
    // serialized `token: undefined`, which JSON.stringify drops entirely).
    const d = resume.d as { token: string; session_id: string; seq: number };
    expect(Object.keys(d)).toContain("token");
    expect(d.token).toBe("test-token");
    expect(d.session_id).toBe("sess-3");
    expect(d.seq).toBe(1);
    expect(resumed).toBeDefined();
  });

  it("re-enters the reconnect backoff when fetchGatewayUrl rejects, instead of dying (#540)", async () => {
    // The first connection drops BEFORE READY, so there is no resumable
    // session: the reconnect must go through fetchGatewayUrl (the cold path).
    let identifies = 0;
    const local = createFakeGateway({
      heartbeatIntervalMs: 5_000,
      ackHeartbeats: true,
      onIdentify: (ws) => {
        identifies += 1;
        if (identifies === 1) {
          // Drop the socket before READY → cold reconnect (sessionId stays null).
          ws.close(4000);
        } else {
          sendReady(ws, local.url, "sess-540");
        }
      },
    });
    fake = local;

    // Reject the SECOND fetch (the first cold reconnect's REST call) once, then
    // recover on the third. Under the old terminal `.catch`, that single
    // rejection ended the chain and this test would time out (see removal map).
    let fetchCalls = 0;
    const fetchGatewayUrl = () => {
      fetchCalls += 1;
      if (fetchCalls === 2) return Promise.reject(new Error("discord REST 503"));
      return Promise.resolve(local.url);
    };

    const ready = Promise.withResolvers<void>();
    gateway = createTracedGateway(
      local,
      "test-token",
      fetchGatewayUrl,
      {
        onDispatch: () => undefined,
        onReady: () => ready.resolve(),
      },
      noopPublish,
      immediateDelay,
    );

    // The first socket drops before READY, so start()'s open promise rejects;
    // the reconnect chain proceeds independently through the close handler.
    await gateway.start().catch(() => undefined);
    // start (fetch 1) → drop → reconnect fetch 2 (rejects) → reconnect fetch 3
    // (resolves) → READY. Resolution is driven by the READY callback.
    await ready.promise;
    expect(fetchCalls).toBeGreaterThanOrEqual(3);
    expect(identifies).toBe(2);
  });

  it("does NOT schedule another attempt after stop() when fetchGatewayUrl keeps rejecting (#540)", async () => {
    // Same cold-reconnect setup, but the REST call keeps failing. Once the
    // fetch-retry loop is active we stop() the gateway; the loop is bounded by
    // `running`, so no further fetch is attempted after shutdown (no leak).
    const local = createFakeGateway({
      heartbeatIntervalMs: 5_000,
      ackHeartbeats: true,
      onIdentify: (ws) => ws.close(4000), // always drop before READY
    });
    fake = local;

    let fetchCalls = 0;
    const secondFetch = Promise.withResolvers<void>();
    const retryDelay = Promise.withResolvers<void>();
    let delayCalls = 0;
    const fetchGatewayUrl = () => {
      fetchCalls += 1;
      if (fetchCalls === 1) return Promise.resolve(local.url); // initial connect
      gateway?.stop();
      secondFetch.resolve();
      return Promise.reject(new Error("persistent outage"));
    };
    const delay = () => {
      delayCalls += 1;
      if (delayCalls === 2) retryDelay.resolve();
      return Promise.resolve();
    };

    gateway = createTracedGateway(
      local,
      "test-token",
      fetchGatewayUrl,
      {
        onDispatch: () => undefined,
        onReady: () => undefined,
      },
      noopPublish,
      delay,
    );

    // First socket drops before READY → start()'s open promise rejects; the
    // reconnect chain proceeds through the close handler. The second fetch
    // stops the gateway before rejecting, then the retry-delay event proves
    // the rejection path observed that stop without scheduling another fetch.
    await gateway.start().catch(() => undefined);
    await secondFetch.promise;
    await retryDelay.promise;
    await Promise.resolve();
    expect(fetchCalls).toBe(2);
  });

  it("re-identifies (never resumes) after a non-resumable INVALID_SESSION", async () => {
    let identifies = 0;
    const local = createFakeGateway({
      heartbeatIntervalMs: 5_000,
      ackHeartbeats: true,
      onIdentify: (ws) => {
        identifies += 1;
        if (identifies === 1) {
          sendReady(ws, local.url, "sess-4");
          ws.send(JSON.stringify({ op: GatewayOp.INVALID_SESSION, d: false, s: null, t: null }));
        } else {
          sendReady(ws, local.url, "sess-5");
        }
      },
    });
    fake = local;
    const readyEvents = new EventStream<void>();
    gateway = createTracedGateway(
      local,
      "test-token",
      () => Promise.resolve(local.url),
      {
        onDispatch: () => undefined,
        onReady: () => readyEvents.emit(),
      },
      noopPublish,
      immediateDelay,
    );

    const secondReady = readyEvents.waitFor(() => true, 2);
    await gateway.start();
    await secondReady;
    expect(identifies).toBe(2);
    expect(local.received.filter((p) => p.op === GatewayOp.RESUME)).toHaveLength(0);
  });

  it("does not leave a server-close waiter after a pre-ready start failure", async () => {
    const local = createFakeGateway({
      heartbeatIntervalMs: 40,
      ackHeartbeats: false,
      rejectUpgrade: true,
    });
    fake = local;
    const harness = createMissedAckHarness(local);
    gateway = harness.gateway;
    try {
      await expect(harness.start()).rejects.toThrow("WebSocket closed before ready: 1002");
      expect(harness.nativeClose).toMatchObject({ code: 1002, wasClean: false, phase: "connecting" });
      expect(harness.nativeClose?.reason.length).toBeGreaterThan(0);
      expect(local.clients.size).toBe(0);
      expect(local.received).toHaveLength(0);
      expect(local.closes).toHaveLength(0);
      // Inspect the actual subscription state; do not wait ten seconds for its rejection.
      expect(local.pendingCloseWaiters()).toBe(0);
      expect(harness.clientClosed).toBeUndefined();
    } finally {
      harness.stop();
    }
  });
});
