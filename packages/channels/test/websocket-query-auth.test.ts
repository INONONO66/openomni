import { expect, test } from "bun:test";
import { authenticatedWebSocketServer } from "./helpers/websocket-server";

// Preserve origin/main's canonical-only auth semantics (#974).
test.each(["", "auth", "auth, wrong-token"])(
  "query credentials cannot replace missing or invalid subprotocol auth (%s)",
  async (protocols) => {
    const server = authenticatedWebSocketServer();
    try {
      const response = await fetch(new URL("/ws?token=secret-token", server.url), {
        headers: {
          Upgrade: "websocket",
          Connection: "Upgrade",
          ...(protocols ? { "Sec-WebSocket-Protocol": protocols } : {}),
        },
      });
      expect(response.status).toBe(401);
    } finally {
      await server.stop(true);
    }
  },
);
