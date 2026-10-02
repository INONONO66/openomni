import { Effect } from "effect";
import { WebSocketHandler, type WsConnection } from "../../src/websocket";
import { runEffect } from "./effect";

type ConnectionData = Parameters<WebSocketHandler["ws"]["open"]>[0]["data"];

/** Deterministic per-server id minter; websocket tests never read ambient entropy. */
export function testWebSocketId(): () => string {
  const state = { value: 0 };
  return () => {
    state.value += 1;
    return `ws-id-${state.value}`;
  };
}

export function websocketCallbacks(handler: WebSocketHandler) {
  return {
    ...handler.ws,
    message(ws: WsConnection, data: string | Buffer): Promise<void> {
      return runEffect(
        handler.handleFrame(ws.data, data).pipe(
          Effect.match({
            onSuccess: (outcome) => outcome,
            onFailure: (error) => ({ type: "error" as const, reason: error._tag }),
          }),
        ),
      ).then((outcome) => {
        ws.send(JSON.stringify(outcome));
      });
    },
  };
}

export function authenticatedWebSocketServer(): Bun.Server<ConnectionData> {
  const handler = new WebSocketHandler(
    () => Effect.void,
    () => undefined,
    { token: "secret-token", now: () => 1, id: testWebSocketId() },
  );
  return Bun.serve<ConnectionData>({
    hostname: "127.0.0.1",
    port: 0,
    websocket: websocketCallbacks(handler),
    fetch: (request, server) => handler.handleUpgrade(request, server),
  });
}
