import { WebSocketHandler } from "../../src/websocket";

type ConnectionData = Parameters<WebSocketHandler["ws"]["open"]>[0]["data"];

export function authenticatedWebSocketServer(): Bun.Server<ConnectionData> {
  const handler = new WebSocketHandler(
    async () => undefined,
    () => undefined,
    { token: "secret-token" },
  );
  return Bun.serve<ConnectionData>({
    hostname: "127.0.0.1",
    port: 0,
    websocket: handler.ws,
    fetch: (request, server) => handler.handleUpgrade(request, server),
  });
}
