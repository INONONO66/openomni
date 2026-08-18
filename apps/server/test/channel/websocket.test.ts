import { describe, expect, it } from "bun:test";
import type { Adapter } from "@openomni/protocol";
import { Operational } from "@openomni/protocol";
import type { ChannelAuthnDecisionObserver } from "../../src/channel/authn/types";
import type { PublishPort } from "../../src/channel/types";
import { WebSocketHandler } from "../../src/channel/websocket";

type ChannelAuthnDecision = Parameters<ChannelAuthnDecisionObserver>[0];

const noopPublish: PublishPort = () => undefined;

function createHandler(
  decisions: ChannelAuthnDecision[] = [],
  publish: PublishPort = noopPublish,
): WebSocketHandler {
  const handler: Adapter.MessageHandler = async () => ({ text: "ok" });
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
  it("authenticates with auth subprotocol and selects the auth protocol", () => {
    const decisions: ChannelAuthnDecision[] = [];
    const handler = createHandler(decisions);
    const upgrade = createUpgradeServer();
    const req = new Request("http://localhost/ws", {
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
        reason: "websocket subprotocol token accepted",
      }),
    ]);
  });

  it("keeps query token fallback and publishes a deprecation warning", () => {
    const warnings: string[] = [];
    const collector: PublishPort = (event, data) => {
      if (event.name === Operational.Events.Warn.name) {
        warnings.push((data as { msg: string }).msg);
      }
    };
    const handler = createHandler([], collector);
    const upgrade = createUpgradeServer();
    const req = new Request("http://localhost/ws?token=secret-token");

    const res = handler.handleUpgrade(req, upgrade.server);

    expect(res).toBeUndefined();
    expect(upgrade.options?.headers).toBeUndefined();
    expect((upgrade.options?.data as { authenticated: boolean }).authenticated).toBe(true);
    expect(warnings).toEqual(["websocket query token auth is deprecated"]);
  });

  it("marks websocket connections unauthenticated when token auth is not configured", () => {
    const handler = new WebSocketHandler(async () => ({ text: "ok" }), noopPublish);
    const upgrade = createUpgradeServer();
    const req = new Request("http://localhost/ws");

    const res = handler.handleUpgrade(req, upgrade.server);

    expect(res).toBeUndefined();
    expect((upgrade.options?.data as { authenticated: boolean }).authenticated).toBe(false);
  });

  it("marks websocket connections unauthenticated when token auth is configured as empty", () => {
    const handler = new WebSocketHandler(async () => ({ text: "ok" }), noopPublish, {
      token: "",
    });
    const upgrade = createUpgradeServer();
    const req = new Request("http://localhost/ws");

    const res = handler.handleUpgrade(req, upgrade.server);

    expect(res).toBeUndefined();
    expect((upgrade.options?.data as { authenticated: boolean }).authenticated).toBe(false);
  });

  it("passes websocket authentication state through inbound message raw metadata", async () => {
    let message: Adapter.InboundMessage | undefined;
    const handler = new WebSocketHandler(async (inbound) => {
      message = inbound;
      return { text: "ok" };
    }, noopPublish);
    const sent: string[] = [];
    const ws = {
      data: { surfaceKey: "ws:test", authenticated: true },
      send: (msg: string) => sent.push(msg),
    };

    handler.ws.message(ws, JSON.stringify({ text: "show open tasks" }));
    await new Promise((resolve) => setTimeout(resolve, 0));

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
