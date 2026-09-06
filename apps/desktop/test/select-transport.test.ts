import { afterEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import type { UIMessage } from "ai";
import { selectChatTransport } from "../src/renderer/chat/select-transport";

/**
 * Which transport the renderer speaks through is one decision, and it is made
 * here rather than inside `app.tsx` so it can be asserted without mounting a
 * window: a shell that silently fell back to the mock while a gateway was
 * configured would show a fluent, entirely fictional conversation.
 *
 * The mock is the answer when there is no endpoint, and that is deliberate
 * rather than a placeholder — the showcase and `scripts/shoot-chat.ts` render
 * the same renderer with no Electron main behind them.
 */

describe("the transport follows the endpoint", () => {
  test("Given no endpoint, When selected, Then the mock answers", () => {
    const selected = selectChatTransport(undefined);

    expect(selected.kind).toBe("mock");
    // The mock arrives as ABSENCE: `app.tsx` owns the mock's tuning, and a
    // second mock constructed here would replace a stream that paints with one
    // that finishes first.
    expect(selected.transport).toBeUndefined();
  });

  test("Given an endpoint, When selected, Then the gateway answers with a usable transport", () => {
    const selected = selectChatTransport({ url: "ws://127.0.0.1:3000/ws" });

    expect(selected.kind).toBe("gateway");
    expect(typeof selected.transport?.sendMessages).toBe("function");
    expect(typeof selected.transport?.reconnectToStream).toBe("function");
  });

  test("Given an endpoint with a token, When selected, Then it is offered as the auth subprotocol", () => {
    // `["auth", token]` is the offer `packages/channels/src/authn/websocket.ts`
    // reads: the literal `auth` marks the pair, and the next protocol IS the
    // credential. Sending the bare token would authenticate nothing.
    expect(selectChatTransport({ url: "ws://127.0.0.1:3000/ws", token: "s3cret" })).toMatchObject({
      kind: "gateway",
      protocols: ["auth", "s3cret"],
    });
  });

  test("Given an endpoint without a token, When selected, Then no subprotocol is offered", () => {
    // A loopback gateway with no configured token rejects an `auth` offer it
    // cannot match, so an empty offer is not the same as an absent one.
    expect(selectChatTransport({ url: "ws://127.0.0.1:3000/ws" }).protocols).toBeUndefined();
    expect(selectChatTransport({ url: "ws://127.0.0.1:3000/ws", token: "" }).protocols).toBeUndefined();
  });
});

/**
 * The offer, on a real upgrade.
 *
 * Asserting `protocols` on the returned object only proves this module agrees
 * with itself — the load-bearing claim is that the pair reaches the server's
 * `Sec-WebSocket-Protocol` header in the order the gateway's authenticator
 * reads it. So the transport is pointed at a real socket server and the header
 * is read off the upgrade request.
 */
const servers: { stop(closeActiveConnections?: boolean): void }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function serveUpgrade() {
  let header: string | null = null;
  let upgraded: (() => void) | undefined;
  const seen = new Promise<void>((resolve) => {
    upgraded = resolve;
  });
  const server = Bun.serve({
    port: 0,
    fetch(request, self) {
      header = request.headers.get("sec-websocket-protocol");
      upgraded?.();
      // The token is never echoed back as the negotiated protocol — the
      // gateway answers `auth` — so the reply narrows to the marker, and
      // answers nothing at all when nothing was offered: a server naming a
      // protocol the client did not offer is a failed handshake.
      const options = header === null ? {} : { headers: { "sec-websocket-protocol": "auth" } };
      return self.upgrade(request, options)
        ? undefined
        : new Response("expected websocket", { status: 400 });
    },
    websocket: {
      message(ws: ServerWebSocket<undefined>) {
        ws.send(JSON.stringify({ type: "response", text: "ok" }));
      },
    },
  });
  servers.push(server);
  return { header: () => header, port: server.port, seen };
}

const PROMPT: readonly UIMessage[] = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] },
];

describe("the token reaches the wire", () => {
  test("Given a token, When the transport connects, Then the upgrade carries auth then the token", async () => {
    const wire = serveUpgrade();
    const { transport } = selectChatTransport({
      url: `ws://127.0.0.1:${wire.port}/ws`,
      token: "s3cret",
    });

    // Awaited on the upgrade itself rather than on a delay: the request is the
    // event this asserts about.
    const sent = transport?.sendMessages({
      trigger: "submit-message",
      chatId: "chat-1",
      messageId: undefined,
      messages: [...PROMPT],
      abortSignal: undefined,
    });
    await wire.seen;

    expect(wire.header()?.split(",").map((part) => part.trim())).toEqual(["auth", "s3cret"]);
    await sent;
  });

  test("Given no token, When the transport connects, Then the upgrade offers no protocol", async () => {
    const wire = serveUpgrade();
    const { transport } = selectChatTransport({ url: `ws://127.0.0.1:${wire.port}/ws` });

    const sent = transport?.sendMessages({
      trigger: "submit-message",
      chatId: "chat-1",
      messageId: undefined,
      messages: [...PROMPT],
      abortSignal: undefined,
    });
    await wire.seen;

    expect(wire.header()).toBeNull();
    await sent;
  });
});
