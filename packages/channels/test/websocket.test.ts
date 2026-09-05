import { describe, expect, it } from "bun:test";
import type { Channel } from "@openomni/protocol";
import type { ChannelAuthnDecisionObserver } from "../src/authn/types";
import type { PublishPort } from "../src/types";
import { WebSocketHandler } from "../src/websocket";

type ChannelAuthnDecision = Parameters<ChannelAuthnDecisionObserver>[0];

const noopPublish: PublishPort = () => undefined;

function createHandler(
  decisions: ChannelAuthnDecision[] = [],
  publish: PublishPort = noopPublish,
): WebSocketHandler {
  const handler: Channel.MessageHandler = async () => ({ text: "ok" });
  return new WebSocketHandler(handler, publish, {
    token: "secret-token",
    onAuthDecision: (decision) => {
      decisions.push(decision);
    },
  });
}

function createUpgradeServer() {
  let options: { data?: unknown; headers?: Record<string, string> } | undefined;
  return {
    server: {
      upgrade(
        _req: Request,
        nextOptions?: { data?: unknown; headers?: Record<string, string> },
      ): boolean {
        options = nextOptions;
        return true;
      },
    },
    get options() {
      return options;
    },
  };
}

describe("WebSocketHandler authentication", () => {
  it.each(["", "?token=wrong-token"])("967-U1 canonical auth ignores query %s", (query) => {
    const decisions: ChannelAuthnDecision[] = [];
    const handler = createHandler(decisions);
    const upgrade = createUpgradeServer();
    const req = new Request(`http://localhost/ws${query}`, {
      headers: { "Sec-WebSocket-Protocol": "auth, secret-token" },
    });

    const res = handler.handleUpgrade(req, upgrade.server);

    expect(res).toBeUndefined();
    expect(upgrade.options?.headers).toEqual({ "Sec-WebSocket-Protocol": "auth" });
    expect((upgrade.options?.data as { surfaceKey: string }).surfaceKey).toStartWith("ws:");
    expect((upgrade.options?.data as { authenticated: boolean }).authenticated).toBe(true);
    expect(decisions).toEqual([
      expect.objectContaining({
        name: "channel-authn:websocket-token",
        policyId: "guardrail.permission",
        verdict: "allow",
      }),
    ]);
  });

  it.each([
    ["query-only", "?token=secret-token", ""],
    ["missing", "", ""],
    ["bare auth", "", "auth"],
    ["wrong protocol", "", "auth, wrong-token"],
    ["wrong protocol with valid query", "?token=secret-token", "auth, wrong-token"],
  ])("967-U1 rejects %s credentials before upgrade", (_name, query, protocol) => {
    let upgrades = 0;
    const decisions: ChannelAuthnDecision[] = [];
    const handler = createHandler(decisions);
    const req = new Request(`http://localhost/ws${query}`, {
      headers: { "Sec-WebSocket-Protocol": protocol },
    });

    const res = handler.handleUpgrade(req, {
      upgrade() {
        upgrades += 1;
        return true;
      },
    });

    expect(res?.status).toBe(401);
    expect(upgrades).toBe(0);
    expect(decisions.map((decision) => decision.verdict)).toEqual(["deny"]);
  });

  it("967-U1 tokenless bootstrap does not bind actor", () => {
    const handler = new WebSocketHandler(async () => ({ text: "ok" }), noopPublish);
    const upgrade = createUpgradeServer();
    const req = new Request("http://localhost/ws?actor=alice");

    const res = handler.handleUpgrade(req, upgrade.server);

    expect(res).toBeUndefined();
    expect((upgrade.options?.data as { authenticated: boolean }).authenticated).toBe(false);
    expect(upgrade.options?.data).not.toHaveProperty("externalId");
  });

  it("967-U1 empty-token bootstrap does not bind actor", () => {
    const handler = new WebSocketHandler(async () => ({ text: "ok" }), noopPublish, {
      token: "",
    });
    const upgrade = createUpgradeServer();
    const req = new Request("http://localhost/ws?actor=alice");

    const res = handler.handleUpgrade(req, upgrade.server);

    expect(res).toBeUndefined();
    expect((upgrade.options?.data as { authenticated: boolean }).authenticated).toBe(false);
    expect(upgrade.options?.data).not.toHaveProperty("externalId");
  });

  it("passes websocket authentication state through inbound message raw metadata", async () => {
    let message: Channel.InboundMessage | undefined;
    const handler = new WebSocketHandler(async (inbound) => {
      message = inbound;
      return { text: "ok" };
    }, noopPublish);
    // `handler.ws.message` fires `void handleMessage(...)`
    // (src/websocket.ts:72) and returns nothing to await. The reply frame is
    // the LAST step of that path (src/websocket.ts:171), so resolving from
    // inside `send` is the exact completion signal for the whole path -
    // strictly stronger than a macrotask guess, which cannot distinguish
    // "finished" from "not started yet".
    const replied = Promise.withResolvers<void>();
    const sent: string[] = [];
    const ws = {
      data: { surfaceKey: "ws:test", authenticated: true },
      send: (msg: string) => {
        sent.push(msg);
        replied.resolve();
      },
    };

    handler.ws.message(ws, JSON.stringify({ text: "show open tasks" }));
    await replied.promise;

    expect(message?.raw).toEqual({ websocket: { authenticated: true } });
    expect(sent).toEqual([JSON.stringify({ type: "response", text: "ok" })]);
  });

  it("rejects missing websocket auth", async () => {
    const decisions: ChannelAuthnDecision[] = [];
    let upgraded = false;
    const handler = createHandler(decisions);
    const req = new Request("http://localhost/ws");

    const res = handler.handleUpgrade(req, {
      upgrade() {
        upgraded = true;
        return true;
      },
    });

    expect(res?.status).toBe(401);
    expect(await res?.text()).toBe("Unauthorized");
    expect(upgraded).toBe(false);
    expect(decisions).toEqual([
      expect.objectContaining({
        name: "channel-authn:websocket-token",
        policyId: "guardrail.permission",
        verdict: "deny",
        reason: "websocket token missing or invalid",
      }),
    ]);
  });
});

describe("WebSocketHandler actor connections", () => {
  function wsConnection(data: Record<string, unknown>) {
    const sent: string[] = [];
    // Resolves on the first frame the handler writes back. `ws.send` is the
    // final step of the inbound path (src/websocket.ts:171), so awaiting it is
    // the exact completion signal for a `handler.ws.message` call, which is
    // fire-and-forget (src/websocket.ts:72).
    const framed = Promise.withResolvers<void>();
    return {
      sent,
      framed: framed.promise,
      ws: {
        data: data as never,
        send: (msg: string) => {
          sent.push(msg);
          framed.resolve();
        },
      },
    };
  }

  it("binds ?actor= only on an authenticated upgrade", () => {
    const handler = createHandler();
    const upgrade = createUpgradeServer();
    handler.handleUpgrade(
      new Request("http://localhost/ws?actor=alice", {
        headers: { "Sec-WebSocket-Protocol": "auth, secret-token" },
      }),
      upgrade.server,
    );
    const data = upgrade.options?.data as { externalId?: string; surfaceKey: string };
    expect(data.externalId).toBe("alice");
    // Empty namespace: no workspace is derived from the connection uuid.
    expect(data.surfaceKey).toStartWith("ws::dm:");
  });

  it("ignores ?actor= on a tokenless upgrade — an actor declaration requires the shared token", () => {
    const handler = new WebSocketHandler(async () => ({ text: "ok" }), noopPublish);
    const upgrade = createUpgradeServer();
    handler.handleUpgrade(new Request("http://localhost/ws?actor=alice"), upgrade.server);
    const data = upgrade.options?.data as { externalId?: string; authenticated: boolean };
    expect(data.authenticated).toBe(false);
    expect(data.externalId).toBeUndefined();
  });

  it("push delivers to the declared connection and mints the platform message id", () => {
    const handler = createHandler();
    const { sent, ws } = wsConnection({
      surfaceKey: "ws::dm:c1",
      authenticated: true,
      externalId: "alice",
    });
    handler.ws.open(ws);

    const receipt = handler.push("alice", "review the report");
    const frame = JSON.parse(sent[0] ?? "{}") as Record<string, unknown>;
    expect(frame.type).toBe("message");
    expect(frame.text).toBe("review the report");
    expect(frame.messageId).toBe(receipt.externalMessageId);
  });

  it("push to an actor with no live connection fails loudly", () => {
    const handler = createHandler();
    expect(() => handler.push("alice", "hello")).toThrow(
      "no live websocket connection for actor alice",
    );
  });

  it("a reconnect replaces the delivery target and a stale close does not unregister it", () => {
    const handler = createHandler();
    const first = wsConnection({ surfaceKey: "ws::dm:c1", authenticated: true, externalId: "alice" });
    const second = wsConnection({ surfaceKey: "ws::dm:c2", authenticated: true, externalId: "alice" });
    handler.ws.open(first.ws);
    handler.ws.open(second.ws);
    // The stale socket closing after the reconnect must not orphan the actor.
    handler.ws.close(first.ws);
    handler.push("alice", "still here");
    expect(second.sent).toHaveLength(1);
    expect(first.sent).toHaveLength(0);

    handler.ws.close(second.ws);
    expect(() => handler.push("alice", "gone")).toThrow(
      "no live websocket connection for actor alice",
    );
  });

  it("carries replyToId and the declared sender identity into the inbound message", async () => {
    let inbound: Channel.InboundMessage | undefined;
    const handler = new WebSocketHandler(
      async (message) => {
        inbound = message;
        return { text: "ok" };
      },
      noopPublish,
      { token: "secret-token" },
    );
    const { ws, framed, sent } = wsConnection({
      surfaceKey: "ws::dm:c1",
      authenticated: true,
      externalId: "alice",
    });

    handler.ws.message(ws, JSON.stringify({ text: "done", replyToId: "frame-7" }));
    await framed;

    expect(inbound?.sender).toEqual({ id: "alice", name: "alice" });
    expect(inbound?.replyToId).toBe("frame-7");
    // The frame the wait resolved on is the handler's reply, not an error
    // frame from the catch arm (src/websocket.ts:173-180).
    expect(sent).toEqual([JSON.stringify({ type: "response", text: "ok" })]);
  });
});
