import { expect, test } from "bun:test";
import { WebSocketHandler } from "../src/websocket";

test("query credentials cannot authenticate a websocket upgrade", async () => {
  const handler = new WebSocketHandler(
    async () => undefined,
    () => undefined,
    {
      token: "secret-token",
    },
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    websocket: handler.ws,
    fetch: (request, instance) => handler.handleUpgrade(request, instance),
  });
  try {
    const response = await fetch(new URL("/ws?token=secret-token", server.url), {
      headers: { Upgrade: "websocket", Connection: "Upgrade" },
    });
    expect(response.status).toBe(401);
  } finally {
    await server.stop(true);
  }
});
