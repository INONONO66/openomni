import { afterEach, describe, expect, it } from "bun:test";
import type { ServerWebSocket } from "bun";
import { SlackSocket } from "../src/provider/slack/socket";
import type { SocketEnvelope } from "../src/provider/slack/types";
import type { PublishPort } from "../src/types";

/**
 * Socket Mode protocol pins over a real WebSocket against a scripted fake
 * Slack endpoint: hello resolves start, every events_api envelope is acked
 * (before dispatch), disconnect frames trigger a fresh-URL reconnect, and
 * stop() never reconnects. All waits are event-driven signals — no sleeps.
 */

const noopPublish: PublishPort = () => undefined;

class Signal<Value> {
  private readonly resolvers: Array<(value: Value) => void> = [];
  private readonly buffer: Value[] = [];

  emit(value: Value): void {
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver(value);
    } else {
      this.buffer.push(value);
    }
  }

  next(timeoutMs = 5000): Promise<Value> {
    const buffered = this.buffer.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    return new Promise<Value>((resolve, reject) => {
      // Resolution is event-driven; this timer only rejects when the signal never fires.
      const timer = setTimeout(() => reject(new Error("timed out waiting for signal")), timeoutMs);
      this.resolvers.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }
}

interface FakeSlack {
  readonly url: string;
  readonly opens: Signal<ServerWebSocket<unknown>>;
  readonly acks: Signal<Record<string, unknown>>;
  readonly closes: Signal<number>;
  stop(): void;
}

function startFakeSlack(): FakeSlack {
  const opens = new Signal<ServerWebSocket<unknown>>();
  const acks = new Signal<Record<string, unknown>>();
  const closes = new Signal<number>();
  const server = Bun.serve({
    port: 0,
    fetch(request, srv) {
      if (srv.upgrade(request)) return;
      return new Response("expected websocket", { status: 400 });
    },
    websocket: {
      open(ws) {
        opens.emit(ws);
      },
      message(_ws, message) {
        acks.emit(JSON.parse(String(message)) as Record<string, unknown>);
      },
      close(_ws, code) {
        closes.emit(code);
      },
    },
  });
  return {
    url: `ws://localhost:${server.port}`,
    opens,
    acks,
    closes,
    stop: () => server.stop(true),
  };
}

function collectPublishes(): { messages: string[]; publish: PublishPort } {
  const messages: string[] = [];
  const publish: PublishPort = (_descriptor, payload) => {
    messages.push((payload as { msg: string }).msg);
  };
  return { messages, publish };
}

const immediateDelay = () => Promise.resolve();

describe("SlackSocket", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  function harness(options?: {
    fetchUrl?: (fake: FakeSlack, attempt: number) => Promise<string>;
    publish?: PublishPort;
  }) {
    const fake = startFakeSlack();
    const events = new Signal<SocketEnvelope>();
    let fetches = 0;
    const socket = new SlackSocket(
      () => {
        fetches += 1;
        return options?.fetchUrl?.(fake, fetches) ?? Promise.resolve(fake.url);
      },
      { onEvent: (envelope) => events.emit(envelope) },
      options?.publish ?? noopPublish,
      immediateDelay,
    );
    cleanups.push(() => {
      socket.stop();
      fake.stop();
    });
    return { fake, events, socket, fetchCount: () => fetches };
  }

  it("resolves start on hello, acks every events_api envelope, then dispatches it", async () => {
    const { fake, events, socket } = harness();
    const started = socket.start();
    const ws = await fake.opens.next();
    ws.send(JSON.stringify({ type: "hello" }));
    await started;

    const envelope = {
      type: "events_api",
      envelope_id: "env-1",
      payload: { event: { type: "message", channel: "C1", ts: "1.0", text: "hi", user: "U1" } },
    };
    ws.send(JSON.stringify(envelope));

    expect(await fake.acks.next()).toEqual({ envelope_id: "env-1" });
    expect((await events.next()).envelope_id).toBe("env-1");
  });

  it("disconnect frame closes the socket and a new connection comes up", async () => {
    const { fake, events, socket, fetchCount } = harness();
    const started = socket.start();
    const ws1 = await fake.opens.next();
    ws1.send(JSON.stringify({ type: "hello" }));
    await started;

    ws1.send(JSON.stringify({ type: "disconnect", envelope_id: "env-d", reason: "refresh" }));
    expect(await fake.acks.next()).toEqual({ envelope_id: "env-d" });
    expect(await fake.closes.next()).toBe(4000);

    const ws2 = await fake.opens.next();
    ws2.send(JSON.stringify({ type: "hello" }));
    ws2.send(
      JSON.stringify({
        type: "events_api",
        envelope_id: "env-2",
        payload: { event: { type: "message", channel: "C1", ts: "2.0", text: "hi", user: "U1" } },
      }),
    );
    expect((await events.next()).envelope_id).toBe("env-2");
    expect(fetchCount()).toBe(2);
  });

  it("retries the socket-url fetch during reconnect until it succeeds", async () => {
    const { messages, publish } = collectPublishes();
    const { fake, events, socket } = harness({
      publish,
      fetchUrl: (fakeSlack, attempt) =>
        attempt === 2
          ? Promise.reject(new Error("slack api down"))
          : Promise.resolve(fakeSlack.url),
    });
    const started = socket.start();
    const ws1 = await fake.opens.next();
    ws1.send(JSON.stringify({ type: "hello" }));
    await started;

    ws1.send(JSON.stringify({ type: "disconnect", reason: "refresh" }));
    const ws2 = await fake.opens.next();
    ws2.send(JSON.stringify({ type: "hello" }));
    ws2.send(
      JSON.stringify({
        type: "events_api",
        envelope_id: "env-3",
        payload: { event: { type: "message", channel: "C1", ts: "3.0", text: "hi", user: "U1" } },
      }),
    );
    expect((await events.next()).envelope_id).toBe("env-3");
    expect(messages).toContain("slack socket url fetch failed, retrying");
  });

  it("drops a malformed frame with a warning and keeps the connection serving", async () => {
    const { messages, publish } = collectPublishes();
    const { fake, events, socket } = harness({ publish });
    const started = socket.start();
    const ws = await fake.opens.next();
    ws.send(JSON.stringify({ type: "hello" }));
    await started;

    ws.send("this is not json");
    ws.send(
      JSON.stringify({
        type: "events_api",
        envelope_id: "env-4",
        payload: { event: { type: "message", channel: "C1", ts: "4.0", text: "hi", user: "U1" } },
      }),
    );
    expect((await events.next()).envelope_id).toBe("env-4");
    expect(messages).toContain("slack socket frame was not valid JSON; dropped");
  });

  it("publishes a dispatch error when the event callback throws", async () => {
    const { messages, publish } = collectPublishes();
    const fake = startFakeSlack();
    const socket = new SlackSocket(
      () => Promise.resolve(fake.url),
      {
        onEvent: () => {
          throw new Error("handler exploded");
        },
      },
      publish,
      immediateDelay,
    );
    cleanups.push(() => {
      socket.stop();
      fake.stop();
    });

    const started = socket.start();
    const ws = await fake.opens.next();
    ws.send(JSON.stringify({ type: "hello" }));
    await started;

    ws.send(
      JSON.stringify({
        type: "events_api",
        envelope_id: "env-5",
        payload: { event: { type: "message", channel: "C1", ts: "5.0", text: "hi", user: "U1" } },
      }),
    );
    expect(await fake.acks.next()).toEqual({ envelope_id: "env-5" });
    // The ack arrived over the wire AFTER dispatch ran locally, so the error is recorded by now.
    expect(messages).toContain("slack event dispatch error");
  });

  it("stop() closes cleanly and never reconnects", async () => {
    let delayCalls = 0;
    const fake = startFakeSlack();
    let fetches = 0;
    const socket = new SlackSocket(
      () => {
        fetches += 1;
        return Promise.resolve(fake.url);
      },
      { onEvent: () => undefined },
      noopPublish,
      () => {
        delayCalls += 1;
        return Promise.resolve();
      },
    );
    cleanups.push(() => fake.stop());

    const started = socket.start();
    (await fake.opens.next()).send(JSON.stringify({ type: "hello" }));
    await started;

    socket.stop();
    expect(await fake.closes.next()).toBe(1000);
    // The close handler runs before this microtask flush; a reconnect would
    // have entered the backoff delay first.
    await Promise.resolve();
    expect(delayCalls).toBe(0);
    expect(fetches).toBe(1);
  });

  it("rejects start when the server closes before hello, without reconnecting", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request, srv) {
        if (srv.upgrade(request)) return;
        return new Response("expected websocket", { status: 400 });
      },
      websocket: {
        open(ws) {
          ws.close(1011, "boot rejected");
        },
        message() {
          // no acks expected
        },
      },
    });
    let fetches = 0;
    const socket = new SlackSocket(
      () => {
        fetches += 1;
        return Promise.resolve(`ws://localhost:${server.port}`);
      },
      { onEvent: () => undefined },
      noopPublish,
      immediateDelay,
    );
    cleanups.push(() => {
      socket.stop();
      server.stop(true);
    });

    await expect(socket.start()).rejects.toThrow("slack socket closed before hello");
    expect(fetches).toBe(1);
  });
});
