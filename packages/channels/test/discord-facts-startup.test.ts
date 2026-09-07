import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import type { Channel } from "@openomni/protocol";
import { z } from "zod";
import { DiscordAdapter } from "../src/provider/discord/surface";
import { bounded } from "./helpers/bounded";

test("Discord READY binds the facts-only handler on a real gateway connection", async () => {
  const connected = Promise.withResolvers<ServerWebSocket<undefined>>();
  const incoming = Promise.withResolvers<Channel.InboundMessage>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, self) {
      return self.upgrade(request) ? undefined : new Response("upgrade required", { status: 400 });
    },
    websocket: {
      open(socket: ServerWebSocket<undefined>) {
        connected.resolve(socket);
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60000 } }));
      },
      message(socket, data) {
        const frame = z.object({ op: z.number() }).parse(JSON.parse(String(data)));
        if (frame.op === 2)
          socket.send(
            JSON.stringify({
              op: 0,
              t: "READY",
              s: 1,
              d: {
                session_id: "session",
                resume_gateway_url: `ws://127.0.0.1:${server.port}`,
                user: { id: "bot", username: "openomni" },
              },
            }),
          );
        if (frame.op === 1) socket.send(JSON.stringify({ op: 11, d: null }));
      },
    },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async () => Response.json({ url: `ws://127.0.0.1:${server.port}` }),
    { preconnect: realFetch.preconnect },
  );
  const adapter = new DiscordAdapter("token", {}, () => undefined);
  adapter.onMessage(async (message) => {
    incoming.resolve(message);
  });
  try {
    await bounded(adapter.start("boot"));
    const socket = await bounded(connected.promise);
    socket.send(
      JSON.stringify({
        op: 0,
        t: "MESSAGE_CREATE",
        s: 2,
        d: {
          id: "message",
          channel_id: "dm",
          author: { id: "user", username: "Sender" },
          content: "hello",
        },
      }),
    );
    expect(await bounded(incoming.promise)).toMatchObject({
      sender: { kind: "external", externalId: "user" },
      facts: { eventId: "message", render: "hello" },
    });
  } finally {
    adapter.stop("stop");
    await server.stop(true);
    globalThis.fetch = realFetch;
  }
});
