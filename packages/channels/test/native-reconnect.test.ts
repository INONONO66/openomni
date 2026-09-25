import { expect, test } from "bun:test";
import type { ServerWebSocket, WebSocketOptions } from "bun";
import { z } from "zod";
import { SlackSocket } from "../src/provider/slack/socket";
import { DiscordGateway } from "../src/provider/discord/gateway";
import { TelegramPoller } from "../src/provider/telegram/poller";
import { TelegramUpdateSchema } from "../src/provider/telegram/types";
import { SocketReconnectShell } from "../src/support/socket-shell";
import { calculateBackoff } from "../src/support/reconnect-backoff";
import { bounded } from "./helpers/bounded";

for (const provider of ["slack", "discord"] as const) {
  test(`${provider}: callbacks on a retired real socket cannot dispatch or schedule reconnect`, async () => {
    const NativeWebSocket = globalThis.WebSocket;
    const clients: WebSocket[] = [];
    globalThis.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, options?: WebSocketOptions);
      constructor(url: string | URL, protocols?: string | string[]);
      constructor(url: string | URL, protocols?: string | string[] | WebSocketOptions) {
        if (typeof protocols === "object" && !Array.isArray(protocols)) super(url, protocols);
        else super(url, protocols);
        clients.push(this);
      }
    };
    const peers: ServerWebSocket<undefined>[] = [];
    const received = Promise.withResolvers<void>();
    const events: string[] = [];
    const logs: string[] = [];
    let delays = 0;
    const server = Bun.serve<undefined>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request)) return;
        return new Response(null, { status: 400 });
      },
      websocket: {
        open(ws) {
          peers.push(ws);
          ws.send(
            JSON.stringify(
              provider === "slack"
                ? { type: "hello" }
                : {
                    op: 0,
                    t: "READY",
                    s: 1,
                    d: {
                      session_id: "session",
                      resume_gateway_url: `ws://127.0.0.1:${server.port}`,
                      user: { id: "bot", username: "bot" },
                    },
                  },
            ),
          );
        },
        message: () => undefined,
      },
    });
    const url = `ws://127.0.0.1:${server.port}`;
    const publish = (event: { name: string }) => {
      logs.push(event.name);
    };
    const delay = async () => {
      delays++;
    };
    const socket =
      provider === "slack"
        ? new SlackSocket(
            async () => url,
            {
              onEvent(envelope) {
                events.push(envelope.envelope_id ?? "missing");
                received.resolve();
              },
            },
            publish,
            delay,
          )
        : new DiscordGateway(
            "token",
            async () => url,
            {
              onReady: () => undefined,
              onDispatch(event) {
                events.push(event);
                received.resolve();
              },
            },
            publish,
            delay,
          );
    const frame = (id: string) =>
      provider === "slack"
        ? { type: "events_api", envelope_id: id, payload: { event: { type: "message" } } }
        : { op: 0, t: id, s: 2, d: {} };
    try {
      await bounded(socket.start());
      const retired = clients[0];
      if (!retired) throw new Error("missing initial socket");
      await bounded(socket.start());
      const logsBefore = logs.length;
      // Deliver callbacks already queued by the retired transport deterministically.
      retired.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame("stale")) }));
      retired.dispatchEvent(new CloseEvent("close", { code: 4000 }));
      retired.dispatchEvent(new Event("error"));
      expect(events).toEqual([]);
      expect(delays).toBe(0);
      expect(logs).toHaveLength(logsBefore);
      peers[1]?.send(JSON.stringify(frame("current")));
      await bounded(received.promise);
      expect(events).toEqual(["current"]);
    } finally {
      socket.stop();
      globalThis.WebSocket = NativeWebSocket;
      await server.stop(true);
    }
  });
}

test("a retired reconnect sleeper cannot replace a new real socket", async () => {
  const sleeping = Promise.withResolvers<number>();
  const wake = Promise.withResolvers<void>();
  let connections = 0;
  const server = Bun.serve<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      open(ws) {
        connections++;
        ws.send("ready");
      },
      message: () => undefined,
    },
  });
  const url = `ws://127.0.0.1:${server.port}`;
  let reconnects = 0;
  const shell: SocketReconnectShell = new SocketReconnectShell(
    () => undefined,
    {
      urlFetchFailed: "fetch",
      closed: "closed",
      reconnectFailed: "reconnect",
      socketError: "socket",
    },
    (ms) => {
      sleeping.resolve(ms);
      return wake.promise;
    },
    (address) =>
      shell.openWebSocket(address, (ws, settle) => {
        ws.addEventListener("message", () => {
          if (settle.current()) settle.resolveOnce();
        });
      }),
  );
  try {
    shell.begin();
    await bounded(shell.connect(async () => url));
    const retired = shell.scheduleReconnect(4000, async () => {
      reconnects++;
    });
    const backoff = await bounded(sleeping.promise);
    expect(backoff).toBeGreaterThanOrEqual(2000);
    expect(backoff).toBeLessThan(3000);
    shell.begin();
    await bounded(shell.connect(async () => url));
    wake.resolve();
    await bounded(retired);
    expect(reconnects).toBe(0);
    expect(connections).toBe(2);
  } finally {
    wake.resolve();
    shell.stop();
    await server.stop(true);
  }
});

test("reconnect has a floor, exponential cap, and jitter", () => {
  const random = Math.random;
  try {
    Math.random = () => 0;
    const floor = calculateBackoff(0);
    const cap = calculateBackoff(20);
    expect(floor).toBeGreaterThan(0);
    expect(calculateBackoff(1)).toBe(floor * 2);
    expect(calculateBackoff(2)).toBe(floor * 4);
    expect(cap).toBeGreaterThan(calculateBackoff(3));
    expect(calculateBackoff(30)).toBe(cap);
    Math.random = () => 0.5;
    const jitter = calculateBackoff(0) - floor;
    expect(jitter).toBeGreaterThan(0);
    expect(jitter).toBeLessThan(floor);
    expect(calculateBackoff(20) - cap).toBe(jitter);
  } finally {
    Math.random = random;
  }
});

const update = (id: number) => ({
  update_id: id,
  message: {
    message_id: id,
    date: 1,
    chat: { id: 7, type: "private" },
    text: "SENTINEL",
  },
});

test("Telegram ignores a retired HTTP response even when cancellation arrives too late", async () => {
  const requested = Promise.withResolvers<void>();
  const oldResponse = Promise.withResolvers<Response>();
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      if (++requests === 1) {
        requested.resolve();
        return oldResponse.promise;
      }
      return Response.json([update(2)]);
    },
  });
  const delivered: number[] = [];
  const poller = new TelegramPoller(
    {
      async getUpdates() {
        // A response already in flight may survive abort; generation, not abort alone, owns custody.
        return z.array(TelegramUpdateSchema).parse(await (await fetch(server.url)).json());
      },
    },
    {
      onMessage(message) {
        delivered.push(message.message_id);
      },
    },
    () => undefined,
  );
  try {
    const old = poller.pollOnce("old");
    await bounded(requested.promise);
    poller.stop();
    await bounded(poller.pollOnce("new"));
    oldResponse.resolve(Response.json([update(1)]));
    await bounded(old);
    expect(delivered).toEqual([2]);
    expect(requests).toBe(2);
  } finally {
    oldResponse.resolve(Response.json([]));
    poller.stop();
    await server.stop(true);
  }
});

test("Telegram reconnect uses jittered backoff and its retired sleeper cannot poll again", async () => {
  const sleeping = Promise.withResolvers<number>();
  const wake = Promise.withResolvers<void>();
  const arrived = Promise.withResolvers<void>();
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++;
      return requests === 1 ? new Response("not-json") : Response.json([update(2)]);
    },
  });
  const delivered: number[] = [];
  const poller = new TelegramPoller(
    {
      async getUpdates() {
        return z.array(TelegramUpdateSchema).parse(await (await fetch(server.url)).json());
      },
    },
    {
      onMessage(message) {
        delivered.push(message.message_id);
        poller.stop();
        arrived.resolve();
      },
    },
    () => undefined,
    (ms) => {
      sleeping.resolve(ms);
      return wake.promise;
    },
  );
  try {
    const retired = poller.start();
    const backoff = await bounded(sleeping.promise);
    expect(backoff).toBeGreaterThanOrEqual(2000);
    expect(backoff).toBeLessThan(3000);
    const current = poller.start();
    await bounded(arrived.promise);
    await bounded(current);
    wake.resolve();
    await bounded(retired);
    expect(delivered).toEqual([2]);
    expect(requests).toBe(2);
  } finally {
    wake.resolve();
    poller.stop();
    await server.stop(true);
  }
});
