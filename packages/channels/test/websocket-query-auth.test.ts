import { expect, test } from "bun:test";
import { authenticatedWebSocketServer } from "./helpers/websocket-server";

test("query credentials cannot authenticate a websocket upgrade", async () => {
  const server = authenticatedWebSocketServer();
  try {
    const response = await fetch(new URL("/ws?token=secret-token", server.url), {
      headers: { Upgrade: "websocket", Connection: "Upgrade" },
    });
    expect(response.status).toBe(401);
  } finally {
    await server.stop(true);
  }
});
