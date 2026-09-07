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
  const handler: Channel.MessageHandler = async () => undefined;
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
  it("accepts the canonical protocol and records authentication", () => {
    const decisions: ChannelAuthnDecision[] = [];
    const handler = createHandler(decisions);
    const upgrade = createUpgradeServer();
    const req = new Request("http://localhost/ws", {
      headers: { "Sec-WebSocket-Protocol": "auth, secret-token" },
    });

    expect(handler.handleUpgrade(req, upgrade.server)).toBeUndefined();
    expect(req.headers.get("sec-websocket-protocol")).toBe("auth");
    expect((upgrade.options?.data as { authenticated: boolean }).authenticated).toBe(true);
    expect(decisions.map((decision) => decision.verdict)).toEqual(["allow"]);
  });

  it("rejects missing websocket auth before upgrade", () => {
    const decisions: ChannelAuthnDecision[] = [];
    const handler = createHandler(decisions);
    let upgrades = 0;
    const response = handler.handleUpgrade(new Request("http://localhost/ws"), {
      upgrade() {
        upgrades += 1;
        return true;
      },
    });

    expect(response?.status).toBe(401);
    expect(upgrades).toBe(0);
    expect(decisions.map((decision) => decision.verdict)).toEqual(["deny"]);
  });

  it("does not bind an actor on tokenless bootstrap", () => {
    const handler = new WebSocketHandler(async () => undefined, noopPublish);
    const upgrade = createUpgradeServer();

    expect(
      handler.handleUpgrade(new Request("http://localhost/ws?actor=alice"), upgrade.server),
    ).toBeUndefined();
    expect(upgrade.options?.data).toMatchObject({
      externalId: expect.stringMatching(/^connection:/),
    });
    expect(upgrade.options?.data).not.toMatchObject({ externalId: "alice" });
  });
});

describe("WebSocketHandler ingress and receipts", () => {
  function connection(data: { surfaceKey: string; authenticated: boolean; externalId: string }) {
    const sent: string[] = [];
    const framed = Promise.withResolvers<void>();
    return {
      sent,
      framed: framed.promise,
      ws: {
        data,
        send: (message: string) => {
          sent.push(message);
          framed.resolve();
        },
      },
    };
  }

  it("emits Gateway.IngressFacts and an accepted receipt", async () => {
    let inbound: Channel.InboundMessage | undefined;
    const handler = new WebSocketHandler(async (message) => {
      inbound = message;
    }, noopPublish);
    const { ws, framed, sent } = connection({
      surfaceKey: "ws::dm:c1",
      authenticated: true,
      externalId: "connection:c1",
    });

    handler.ws.message(ws, JSON.stringify({ text: "done", replyToId: "frame-7" }));
    await framed;

    expect(inbound).toMatchObject({
      sender: { kind: "external", surface: "ws", externalId: "connection:c1" },
      facts: {
        surface: "ws",
        channelId: "ws::dm:c1",
        dm: true,
        reply: { chain: ["frame-7"] },
        render: "done",
      },
    });
    expect(sent).toEqual([JSON.stringify({ type: "receipt", status: "accepted" })]);
  });

  it("push returns an accepted receipt with a stable external message id", () => {
    const handler = createHandler();
    const { sent, ws } = connection({
      surfaceKey: "ws::dm:c1",
      authenticated: true,
      externalId: "alice",
    });
    handler.ws.open(ws);

    const receipt = handler.push("alice", "review", "message-1");
    expect(receipt).toEqual({ value: "accepted", externalMessageId: "message-1" });
    expect(JSON.parse(sent[0] ?? "{}")).toMatchObject({
      type: "message",
      messageId: "message-1",
      text: "review",
    });
  });

  it("reconnects without losing the current delivery target", () => {
    const handler = createHandler();
    const first = connection({ surfaceKey: "ws::dm:c1", authenticated: true, externalId: "alice" });
    const second = connection({
      surfaceKey: "ws::dm:c2",
      authenticated: true,
      externalId: "alice",
    });
    handler.ws.open(first.ws);
    handler.ws.open(second.ws);
    handler.ws.close(first.ws);
    handler.push("alice", "still here", "message-2");
    expect(second.sent).toHaveLength(1);
    expect(first.sent).toHaveLength(0);
  });
});
