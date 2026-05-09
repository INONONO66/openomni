import { afterEach, describe, expect, it, mock } from "bun:test";
import type { Adapter } from "@openomni/protocol";
import { Log } from "@openomni/session";
import type { ChannelAuthnDecision } from "../../src/channel/channel-authn";
import { WebSocketHandler } from "../../src/channel/websocket";

const originalWarn = Log.warn;

afterEach(() => {
  (Log as { warn: typeof Log.warn }).warn = originalWarn;
});

function createHandler(decisions: ChannelAuthnDecision[] = []): WebSocketHandler {
  const handler: Adapter.MessageHandler = async () => ({ text: "ok" });
  return new WebSocketHandler(handler, {
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
    expect(decisions).toEqual([
      expect.objectContaining({
        name: "channel-authn:websocket-token",
        policyId: "channel.authn.websocket-token",
        verdict: "continue",
        reason: "websocket subprotocol token accepted",
      }),
    ]);
  });

  it("keeps query token fallback and logs a deprecation warning", () => {
    const warn = mock(() => undefined);
    (Log as { warn: typeof Log.warn }).warn = warn;
    const handler = createHandler();
    const upgrade = createUpgradeServer();
    const req = new Request("http://localhost/ws?token=secret-token");

    const res = handler.handleUpgrade(req, upgrade.server);

    expect(res).toBeUndefined();
    expect(upgrade.options?.headers).toBeUndefined();
    expect(warn).toHaveBeenCalledWith("websocket query token auth is deprecated");
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
        policyId: "channel.authn.websocket-token",
        verdict: "abort",
        reason: "websocket token missing or invalid",
      }),
    ]);
  });
});
