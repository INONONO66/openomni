import { afterEach, describe, expect, it } from "bun:test";
import type { ServerWebSocket } from "bun";
import { DiscordGateway } from "../../src/channel/discord/gateway";
import { GatewayOp } from "../../src/channel/discord/types";
import type { PublishPort } from "../../src/channel/types";

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

type FakeGateway = {
  url: string;
  received: Payload[];
  closes: number[];
  clients: Set<ServerWebSocket<unknown>>;
  waitFor(predicate: (p: Payload) => boolean, timeoutMs?: number): Promise<Payload>;
  waitForClose(timeoutMs?: number): Promise<number>;
  stop(): void;
};

function createFakeGateway(options: {
  heartbeatIntervalMs: number;
  ackHeartbeats: boolean;
  onIdentify?: (ws: ServerWebSocket<unknown>) => void;
  onResume?: (ws: ServerWebSocket<unknown>, payload: Payload) => void;
}): FakeGateway {
  const received: Payload[] = [];
  const closes: number[] = [];
  const clients = new Set<ServerWebSocket<unknown>>();
  const send = (ws: ServerWebSocket<unknown>, payload: Payload) => ws.send(JSON.stringify(payload));

  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return;
      return new Response("expected websocket", { status: 400 });
    },
    websocket: {
      open(ws) {
        clients.add(ws);
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
        if (payload.op === GatewayOp.HEARTBEAT && options.ackHeartbeats) {
          send(ws, { op: GatewayOp.HEARTBEAT_ACK, s: null, t: null });
        }
        if (payload.op === GatewayOp.IDENTIFY) {
          options.onIdentify?.(ws);
        }
        if (payload.op === GatewayOp.RESUME) {
          options.onResume?.(ws, payload);
        }
      },
      close(ws, code) {
        clients.delete(ws);
        closes.push(code);
      },
    },
  });

  const waitUntil = async <T>(
    read: () => T | undefined,
    timeoutMs: number,
    what: string,
  ): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = read();
      if (value !== undefined) return value;
      await Bun.sleep(10);
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  return {
    url: `ws://127.0.0.1:${server.port}`,
    received,
    closes,
    clients,
    waitFor: (predicate, timeoutMs = 5000) =>
      waitUntil(() => received.find(predicate), timeoutMs, "gateway payload"),
    waitForClose: (timeoutMs = 5000) => waitUntil(() => closes[0], timeoutMs, "client close"),
    stop: () => server.stop(true),
  };
}

function sendReady(ws: ServerWebSocket<unknown>, url: string, sessionId: string): void {
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
    gateway = new DiscordGateway(
      "test-token",
      () => Promise.resolve(local.url),
      {
        onDispatch: () => undefined,
        onReady: () => undefined,
      },
      noopPublish,
    );

    await gateway.start();
    const identify = await local.waitFor((p) => p.op === GatewayOp.IDENTIFY);
    expect((identify.d as { token: string }).token).toBe("test-token");

    // Pin for defect 1: before the ack was wired, the watchdog closed the
    // socket on the SECOND interval. Surviving 5+ intervals with heartbeats
    // still flowing means acks reach the flag.
    await Bun.sleep(100 * 6);
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
    gateway = new DiscordGateway(
      "test-token",
      () => Promise.resolve(local.url),
      {
        onDispatch: () => undefined,
        onReady: () => undefined,
      },
      noopPublish,
    );

    await gateway.start();
    const closeCode = await local.waitForClose();
    // Stop before the backoff fires so the reconnect loop does not race the
    // teardown; the resume path itself is pinned by the next test.
    gateway.stop();
    expect(closeCode).toBe(4000);
    const heartbeats = local.received.filter((p) => p.op === GatewayOp.HEARTBEAT);
    expect(heartbeats.length).toBe(1);
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
    gateway = new DiscordGateway(
      "test-token",
      () => Promise.resolve(local.url),
      {
        onDispatch: () => undefined,
        onReady: () => undefined,
      },
      noopPublish,
    );

    await gateway.start();
    // Reconnect backoff for attempt 1 is 2s + up to 1s jitter.
    const resume = await local.waitFor((p) => p.op === GatewayOp.RESUME, 8000);
    // Pin for defect 2: the payload carries the REAL token (the old router
    // serialized `token: undefined`, which JSON.stringify drops entirely).
    const d = resume.d as { token: string; session_id: string; seq: number };
    expect(Object.keys(d)).toContain("token");
    expect(d.token).toBe("test-token");
    expect(d.session_id).toBe("sess-3");
    expect(d.seq).toBe(1);
    expect(resumed).toBeDefined();
  }, 15_000);

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

    let ready = false;
    gateway = new DiscordGateway(
      "test-token",
      fetchGatewayUrl,
      {
        onDispatch: () => undefined,
        onReady: () => {
          ready = true;
        },
      },
      noopPublish,
    );

    // The first socket drops before READY, so start()'s open promise rejects;
    // the reconnect chain proceeds independently through the close handler.
    await gateway.start().catch(() => undefined);
    // start (fetch 1) → drop → backoff → reconnect fetch 2 (rejects) → backoff
    // → reconnect fetch 3 (resolves) → READY. Proves the fetch rejection did
    // NOT terminate the reconnect chain.
    const deadline = Date.now() + 18_000;
    while (!ready && Date.now() < deadline) {
      await Bun.sleep(20);
    }
    expect(fetchCalls).toBeGreaterThanOrEqual(3);
    expect(identifies).toBe(2);
    expect(ready).toBe(true);
  }, 20_000);

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
    const fetchGatewayUrl = () => {
      fetchCalls += 1;
      if (fetchCalls === 1) return Promise.resolve(local.url); // initial connect
      return Promise.reject(new Error("persistent outage"));
    };

    gateway = new DiscordGateway(
      "test-token",
      fetchGatewayUrl,
      {
        onDispatch: () => undefined,
        onReady: () => undefined,
      },
      noopPublish,
    );

    // First socket drops before READY → start()'s open promise rejects; the
    // reconnect chain proceeds through the close handler.
    await gateway.start().catch(() => undefined);
    // Wait until the first cold-reconnect fetch has rejected (fetchCalls === 2).
    const deadline = Date.now() + 12_000;
    while (fetchCalls < 2 && Date.now() < deadline) {
      await Bun.sleep(20);
    }
    expect(fetchCalls).toBe(2);

    gateway.stop();
    const stopped = fetchCalls;
    // Wait past the next backoff window; a running-unbounded loop would fetch again.
    await Bun.sleep(6_000);
    expect(fetchCalls).toBe(stopped);
  }, 20_000);

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
    gateway = new DiscordGateway(
      "test-token",
      () => Promise.resolve(local.url),
      {
        onDispatch: () => undefined,
        onReady: () => undefined,
      },
      noopPublish,
    );

    await gateway.start();
    const deadline = Date.now() + 8000;
    while (identifies < 2 && Date.now() < deadline) {
      await Bun.sleep(20);
    }
    expect(identifies).toBe(2);
    expect(local.received.filter((p) => p.op === GatewayOp.RESUME)).toHaveLength(0);
  }, 15_000);
});
