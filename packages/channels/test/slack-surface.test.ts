import { afterEach, describe, expect, it } from "bun:test";
import type { Channel } from "@openomni/protocol";
import { SlackAdapter } from "../src/provider/slack/surface";
import { SlackEndpointKeyError, SlackHandlerMissingError } from "../src/provider/slack/error";
import type { PublishPort } from "../src/types";

/**
 * End-to-end surface behavior over a real Socket Mode websocket and a mocked
 * slack Web API: identity-before-socket startup, mention-gated ingest,
 * at-least-once dedupe, thread-pinned replies, and the workspace-mandatory
 * `TEAM:USER` delivery key. Every wait is an event-driven signal — no sleeps.
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

interface ApiCall {
  readonly method: string;
  readonly body: Record<string, unknown>;
}

/**
 * Mocks the slack Web API (`fetch`) and, when a websocket harness is wanted,
 * serves a real Socket Mode endpoint whose `apps.connections.open` points at it.
 */
function installSlackApi(options?: { postMessageTs?: () => string }): {
  calls: ApiCall[];
  posts: Signal<Record<string, unknown>>;
  sockets: Signal<import("bun").ServerWebSocket<unknown>>;
  stop: () => void;
} {
  const calls: ApiCall[] = [];
  const posts = new Signal<Record<string, unknown>>();
  const sockets = new Signal<import("bun").ServerWebSocket<unknown>>();
  const server = Bun.serve({
    port: 0,
    fetch(request, srv) {
      if (srv.upgrade(request)) return;
      return new Response("expected websocket", { status: 400 });
    },
    websocket: {
      open(ws) {
        sockets.emit(ws);
      },
      message() {
        // acks are covered by the socket suite
      },
    },
  });

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = url.slice(url.lastIndexOf("/") + 1);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ method, body });
    const respond = (payload: Record<string, unknown>) =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    if (method === "apps.connections.open") {
      return respond({ ok: true, url: `ws://localhost:${server.port}` });
    }
    if (method === "auth.test") {
      return respond({ ok: true, user_id: "UBOT", team_id: "T9" });
    }
    if (method === "conversations.open") {
      return respond({ ok: true, channel: { id: "D-open" } });
    }
    posts.emit(body);
    return respond({ ok: true, ts: options?.postMessageTs?.() ?? "999.1" });
  }) as typeof fetch;

  return { calls, posts, sockets, stop: () => server.stop(true) };
}

function messageEnvelope(event: Record<string, unknown>, envelopeId: string): string {
  return JSON.stringify({
    type: "events_api",
    envelope_id: envelopeId,
    payload: { event: { type: "message", ...event } },
  });
}

describe("SlackAdapter", () => {
  const realFetch = globalThis.fetch;
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    globalThis.fetch = realFetch;
  });

  function startedAdapter(options?: {
    triggers?: Channel.Config["triggers"];
    handler?: Channel.MessageHandler;
    inbounds?: Signal<Channel.InboundMessage>;
  }) {
    const api = installSlackApi();
    cleanups.push(api.stop);
    const inbounds = options?.inbounds ?? new Signal<Channel.InboundMessage>();
    const adapter = new SlackAdapter(
      { botToken: "xoxb-1", appToken: "xapp-1" },
      { triggers: options?.triggers ?? [{ type: "mention" }] },
      noopPublish,
    );
    adapter.onMessage(
      options?.handler ??
        ((message) => {
          inbounds.emit(message);
          return Promise.resolve({ text: "reply" });
        }),
    );
    cleanups.push(() => adapter.stop("trace-stop"));
    return { api, adapter, inbounds };
  }

  it("refuses to start without a handler", async () => {
    const adapter = new SlackAdapter(
      { botToken: "xoxb-1", appToken: "xapp-1" },
      { triggers: [] },
      noopPublish,
    );
    const error = await adapter.start("trace-1").then(
      () => null,
      (err: unknown) => err,
    );
    expect(SlackHandlerMissingError.isInstance(error)).toBe(true);
  });

  it("routes a channel mention to the handler and pins the reply to the thread", async () => {
    const { api, adapter, inbounds } = startedAdapter();
    const started = adapter.start("trace-1");
    const ws = await api.sockets.next();
    ws.send(JSON.stringify({ type: "hello" }));
    await started;

    ws.send(
      messageEnvelope(
        {
          channel: "C123",
          channel_type: "channel",
          user: "U77",
          text: "<@UBOT> tracking number",
          ts: "1710.0002",
          thread_ts: "1710.0001",
        },
        "env-1",
      ),
    );

    const inbound = await inbounds.next();
    expect(inbound.sender.id).toBe("T9:U77");
    expect(inbound.surfaceKey).toBe("slack:T9:channel:C123:thread:1710.0001");
    expect(await api.posts.next()).toEqual({
      channel: "C123",
      text: "reply",
      thread_ts: "1710.0001",
    });
  });

  it("dedupes redelivered envelopes by (channel, ts)", async () => {
    let handled = 0;
    const inbounds = new Signal<Channel.InboundMessage>();
    const { api, adapter } = startedAdapter({
      handler: (message) => {
        handled += 1;
        inbounds.emit(message);
        return Promise.resolve(null);
      },
    });
    const started = adapter.start("trace-1");
    const ws = await api.sockets.next();
    ws.send(JSON.stringify({ type: "hello" }));
    await started;

    const envelope = {
      channel: "C1",
      channel_type: "channel",
      user: "U1",
      text: "<@UBOT> once",
      ts: "1.0",
    };
    ws.send(messageEnvelope(envelope, "env-1"));
    await inbounds.next();
    // Redelivery of the same platform message, then a distinct one as the
    // ordering fence proving the duplicate was dropped, not still in flight.
    ws.send(messageEnvelope(envelope, "env-1-redelivered"));
    ws.send(messageEnvelope({ ...envelope, ts: "2.0", text: "<@UBOT> twice" }, "env-2"));
    await inbounds.next();
    expect(handled).toBe(2);
  });

  it("drops a non-mention channel message under the mention trigger", async () => {
    const { api, adapter, inbounds } = startedAdapter();
    const started = adapter.start("trace-1");
    const ws = await api.sockets.next();
    ws.send(JSON.stringify({ type: "hello" }));
    await started;

    ws.send(
      messageEnvelope(
        { channel: "C1", channel_type: "channel", user: "U1", text: "just chatting", ts: "1.0" },
        "env-1",
      ),
    );
    // Ordering fence: the accepted mention arrives after the drop candidate.
    ws.send(
      messageEnvelope(
        { channel: "C1", channel_type: "channel", user: "U1", text: "<@UBOT> now", ts: "2.0" },
        "env-2",
      ),
    );
    expect((await inbounds.next()).text).toBe("now");
  });

  it("lets a DM through the mention trigger and replies without a thread anchor", async () => {
    const { api, adapter, inbounds } = startedAdapter();
    const started = adapter.start("trace-1");
    const ws = await api.sockets.next();
    ws.send(JSON.stringify({ type: "hello" }));
    await started;

    ws.send(
      messageEnvelope(
        { channel: "D42", channel_type: "im", user: "U5", text: "status?", ts: "3.0" },
        "env-1",
      ),
    );
    expect((await inbounds.next()).surfaceKey).toBe("slack:T9:dm:U5");
    expect(await api.posts.next()).toEqual({ channel: "D42", text: "reply" });
  });

  it("re-admits a message whose handler failed (dedupe forget)", async () => {
    let attempts = 0;
    const inbounds = new Signal<Channel.InboundMessage>();
    const { api, adapter } = startedAdapter({
      handler: (message) => {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new Error("transient"));
        inbounds.emit(message);
        return Promise.resolve(null);
      },
    });
    const started = adapter.start("trace-1");
    const ws = await api.sockets.next();
    ws.send(JSON.stringify({ type: "hello" }));
    await started;

    const envelope = {
      channel: "C1",
      channel_type: "channel",
      user: "U1",
      text: "<@UBOT> retry me",
      ts: "1.0",
    };
    ws.send(messageEnvelope(envelope, "env-1"));
    // The redelivery only succeeds if the failed attempt forgot its dedupe claim.
    ws.send(messageEnvelope(envelope, "env-1-redelivered"));
    await inbounds.next();
    expect(attempts).toBe(2);
  });

  it("ignores non-message envelopes and unnormalizable events", async () => {
    const { api, adapter, inbounds } = startedAdapter();
    const started = adapter.start("trace-1");
    const ws = await api.sockets.next();
    ws.send(JSON.stringify({ type: "hello" }));
    await started;

    ws.send(JSON.stringify({ type: "events_api", envelope_id: "e0", payload: {} }));
    ws.send(
      JSON.stringify({
        type: "events_api",
        envelope_id: "e1",
        payload: { event: { type: "reaction_added", channel: "C1", ts: "0.5" } },
      }),
    );
    // Bot echo of our own outbound must never loop back in.
    ws.send(
      messageEnvelope(
        { channel: "C1", user: "UBOT", bot_id: "B1", text: "reply", ts: "0.9" },
        "e2",
      ),
    );
    ws.send(
      messageEnvelope(
        { channel: "C1", channel_type: "channel", user: "U1", text: "<@UBOT> real", ts: "1.0" },
        "e3",
      ),
    );
    expect((await inbounds.next()).text).toBe("real");
  });

  it("delivers to a workspace-mandatory TEAM:USER endpoint via DM", async () => {
    const api = installSlackApi();
    cleanups.push(api.stop);
    const adapter = new SlackAdapter(
      { botToken: "xoxb-1", appToken: "xapp-1" },
      { triggers: [] },
      noopPublish,
    );

    const receipt = adapter.deliver("T9:U5", "direct note");
    expect(await api.posts.next()).toEqual({ channel: "D-open", text: "direct note" });
    expect(await receipt).toEqual({ externalMessageId: "999.1" });
    expect(api.calls.map((call) => call.method)).toEqual([
      "conversations.open",
      "chat.postMessage",
    ]);
    expect(api.calls[0]?.body).toEqual({ users: "U5" });
  });

  it("refuses a delivery key without the workspace half", async () => {
    const adapter = new SlackAdapter(
      { botToken: "xoxb-1", appToken: "xapp-1" },
      { triggers: [] },
      noopPublish,
    );
    const error = await adapter.deliver("U5", "no workspace").then(
      () => null,
      (err: unknown) => err,
    );
    expect(SlackEndpointKeyError.isInstance(error)).toBe(true);
  });

  it("chunks a long delivery and reports the final chunk's ts", async () => {
    let sent = 0;
    const api = installSlackApi({ postMessageTs: () => `ts.${++sent}` });
    cleanups.push(api.stop);
    const adapter = new SlackAdapter(
      { botToken: "xoxb-1", appToken: "xapp-1" },
      { triggers: [] },
      noopPublish,
    );

    const receipt = adapter.deliver("T9:U5", "a".repeat(4001));
    await api.posts.next();
    await api.posts.next();
    expect(await receipt).toEqual({ externalMessageId: "ts.2" });
  });

  it("collapses idempotent deliveries onto one send", async () => {
    const api = installSlackApi();
    cleanups.push(api.stop);
    const adapter = new SlackAdapter(
      { botToken: "xoxb-1", appToken: "xapp-1" },
      { triggers: [] },
      noopPublish,
    );

    const [first, second] = await Promise.all([
      adapter.deliver("T9:U5", "once", "key-1"),
      adapter.deliver("T9:U5", "once", "key-1"),
    ]);
    expect(first).toEqual(second);
    expect(api.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
  });
});
