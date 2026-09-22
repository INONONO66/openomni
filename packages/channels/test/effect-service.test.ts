import { expect, test } from "bun:test";
import { Context, Effect } from "effect";
import type { Channel } from "@openomni/protocol";
import { WebSocketFrames, WebSocketHandler } from "../src/index";
import { runEffect } from "./helpers/effect";

test("the published frame service admits messages and preserves typed validation failures", async () => {
  const received: Channel.InboundMessage[] = [];
  const handler = new WebSocketHandler(
    (message: Channel.InboundMessage) => Effect.sync(() => { received.push(message); }),
    () => undefined,
  );
  const service = { handleFrame: handler.handleFrame.bind(handler) };
  const context = Context.make(WebSocketFrames, service);
  const connection = { surfaceKey: "ws::dm:fixture", authenticated: true, externalId: "fixture" };
  const admit = Effect.gen(function* () {
    const frames = yield* WebSocketFrames;
    return yield* frames.handleFrame(connection, JSON.stringify({ text: "hello", eventId: "frame-1" }));
  }).pipe(Effect.provide(context));
  expect(await runEffect(admit)).toEqual({ type: "receipt", status: "accepted" });
  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({ facts: { render: "hello", eventId: "frame-1" } });
  expect(await runEffect(Effect.flip(Context.get(context, WebSocketFrames).handleFrame(connection, "{"))))
    .toMatchObject({ _tag: "InvalidInbound", operation: "websocket.frame", reason: "invalid_json" });
  expect(received).toHaveLength(1);
});
