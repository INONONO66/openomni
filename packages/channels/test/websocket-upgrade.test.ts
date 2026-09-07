import { expect, it } from "bun:test";
import { connect } from "node:net";
import { WebSocketHandler } from "../src/websocket";

it.each([
  "auth, secret-token",
  "other, auth, secret-token",
])("negotiates exactly one auth response header for %s", async (protocols) => {
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
    fetch: (request, bunServer) => handler.handleUpgrade(request, bunServer),
  });
  const socket = connect({ host: server.url.hostname, port: Number(server.url.port) });
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("WebSocket handshake timed out")), 2000);
      let raw = "";
      socket.setEncoding("utf8");
      socket.on("error", reject);
      socket.on("data", (chunk) => {
        raw += chunk;
        if (raw.includes("\r\n\r\n")) resolve(raw);
      });
      socket.once("connect", () =>
        socket.write(
          [
            "GET /ws HTTP/1.1",
            `Host: 127.0.0.1:${server.port}`,
            "Connection: Upgrade",
            "Upgrade: websocket",
            "Sec-WebSocket-Version: 13",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            `Sec-WebSocket-Protocol: ${protocols}`,
            "",
            "",
          ].join("\r\n"),
        ),
      );
    });
    const lines = response.split("\r\n");
    expect(lines[0]).toBe("HTTP/1.1 101 Switching Protocols");
    expect(
      lines
        .filter((line) => /^sec-websocket-protocol:/i.test(line))
        .map((line) => line.slice(line.indexOf(":") + 1).trim()),
    ).toEqual(["auth"]);
  } finally {
    clearTimeout(timer);
    socket.destroy();
    await closed;
    await server.stop(true);
  }
});
