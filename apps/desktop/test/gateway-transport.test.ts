import { Chat } from "@ai-sdk/react";
import { afterEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket, Server } from "bun";
import type { UIMessage, UIMessageChunk } from "ai";
import { z } from "zod";
import { createGatewayChatTransport } from "../src/renderer/chat/gateway-transport";

/**
 * The wire is asserted against a REAL socket, not a stubbed WebSocket. What
 * this file has to prove is that the openomni frames (`receipt`, `message`,
 * `error`) reduce to the exact chunk sequence the AI SDK reads — and a fake
 * wire would let a wrong sequence pass because it would mirror the
 * implementation. The lifecycle tests inject a controllable socket solely to
 * force otherwise unreachable event orderings such as an old `close` after a
 * replacement has opened.
 *
 * Every wait is an EVENT: a served frame, a stream chunk, an `open`. There is no
 * sleep anywhere, so a slow machine cannot turn a pass into a flake or the
 * reverse.
 */

/** What the server was asked, in order — the client half of the wire. */
const receivedSchema = z.object({ text: z.string(), replyToId: z.string().optional() });
type Received = z.infer<typeof receivedSchema>;

/**
 * A server whose reply to each inbound frame is scripted: `script[n]` is sent
 * back for the nth message. Anything the script does not cover is answered with
 * an empty `message`, so a test that sends one more turn than it scripted fails
 * on the assertion rather than hanging.
 */
function serveWire(script: readonly (readonly Readonly<Record<string, string>>[])[]) {
  const received: Received[] = [];
  const protocols: (string | null)[] = [];
  let connectionCount = 0;
  let turn = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request, self) {
      protocols.push(request.headers.get("sec-websocket-protocol"));
      return self.upgrade(request)
        ? undefined
        : new Response("expected websocket", { status: 400 });
    },
    websocket: {
      open() {
        connectionCount += 1;
      },
      message(ws: ServerWebSocket<undefined>, raw: string | Buffer) {
        received.push(
          receivedSchema.parse(JSON.parse(typeof raw === "string" ? raw : raw.toString())),
        );
        const frames = script[turn] ?? [
          { type: "message", messageId: `message-${turn}`, text: "" },
        ];
        turn += 1;
        for (const frame of frames) ws.send(JSON.stringify(frame));
      },
    },
  });
  servers.push(server);
  return {
    connectionCount: () => connectionCount,
    received,
    protocols,
    url: `ws://127.0.0.1:${server.port}`,
  };
}

const servers: Server<undefined>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

/** Drain a chunk stream to completion. */
async function collect(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = [];
  const reader = stream.getReader();
  for (;;) {
    const result = await reader.read();
    if (result.done) return chunks;
    chunks.push(result.value);
  }
}

let messageCounter = 0;
function userMessage(text: string): UIMessage {
  messageCounter += 1;
  return { id: `m${messageCounter}`, role: "user", parts: [{ type: "text", text }] };
}

function send(
  transport: ReturnType<typeof createGatewayChatTransport>,
  messages: readonly UIMessage[],
  abortSignal?: AbortSignal,
  chatId = "chat-1",
) {
  return transport.sendMessages({
    trigger: "submit-message",
    chatId,
    messageId: undefined,
    messages: [...messages],
    abortSignal,
  });
}

/** A browser socket whose close event can be held behind its replacement. */
class ControlledSocket {
  static readonly instances: ControlledSocket[] = [];

  readyState = 0;
  readonly sent: Received[] = [];
  private readonly closeListeners: (() => void)[] = [];
  private readonly errorListeners: (() => void)[] = [];
  private readonly messageListeners: ((event: { data: string | ArrayBuffer | Blob }) => void)[] =
    [];
  private readonly openListeners: (() => void)[] = [];

  constructor(_url: string, _protocols?: string | readonly string[]) {
    ControlledSocket.instances.push(this);
  }

  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "error", listener: () => void): void;
  addEventListener(
    type: "message",
    listener: (event: { data: string | ArrayBuffer | Blob }) => void,
  ): void;
  addEventListener(
    ...[type, listener]:
      | [type: "open" | "close" | "error", listener: () => void]
      | [type: "message", listener: (event: { data: string | ArrayBuffer | Blob }) => void]
  ): void {
    if (type === "open") this.openListeners.push(listener);
    if (type === "close") this.closeListeners.push(listener);
    if (type === "error") this.errorListeners.push(listener);
    if (type === "message") {
      this.messageListeners.push(listener);
    }
  }

  open(): void {
    this.readyState = 1;
    for (const listener of this.openListeners) listener();
  }

  beginClose(): void {
    this.readyState = 2;
  }

  finishClose(): void {
    this.readyState = 3;
    for (const listener of this.closeListeners) listener();
  }

  fail(): void {
    for (const listener of this.errorListeners) listener();
  }

  respond(text: string): void {
    this.receive(JSON.stringify({ type: "message", messageId: `message-${text}`, text }));
  }

  receive(data: string | ArrayBuffer | Blob): void {
    const event = { data };
    for (const listener of this.messageListeners) listener(event);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("socket is not open");
    this.sent.push(receivedSchema.parse(JSON.parse(data)));
  }

  close(): void {
    this.beginClose();
  }
}

describe("createGatewayChatTransport", () => {
  test("a server message becomes start / text-start / text-delta / text-end / finish", async () => {
    const { received, url } = serveWire([
      [
        { type: "receipt", status: "accepted" },
        { type: "message", messageId: "message-1", text: "the ledger appended" },
        { type: "error", message: "turn already completed" },
      ],
    ]);
    const transport = createGatewayChatTransport({ url });

    const chunks = await collect(await send(transport, [userMessage("append it")]));

    expect(received).toEqual([{ text: "append it" }]);
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      "start",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ]);
    const delta = chunks[2];
    if (delta?.type !== "text-delta") throw new Error("third chunk is not a text-delta");
    expect(delta.delta).toBe("the ledger appended");
    const start = chunks[1];
    const end = chunks[3];
    if (start?.type !== "text-start" || end?.type !== "text-end") {
      throw new Error("text part is not bracketed");
    }
    expect(delta.id).toBe(start.id);
    expect(end.id).toBe(start.id);
  });

  test("an error frame becomes one error chunk and closes the stream", async () => {
    const { url } = serveWire([
      [
        { type: "receipt", status: "accepted" },
        { type: "error", message: "text field required" },
      ],
    ]);
    const transport = createGatewayChatTransport({ url });

    const chunks = await collect(await send(transport, [userMessage("")]));

    expect(chunks).toEqual([{ type: "error", errorText: "text field required" }]);
  });

  test("an outstanding server message id is echoed as replyToId on the next turn", async () => {
    const { received, url } = serveWire([
      [{ type: "message", messageId: "wait-7", text: "which branch?" }],
      [{ type: "message", messageId: "done", text: "done" }],
    ]);
    const transport = createGatewayChatTransport({ url });

    await collect(await send(transport, [userMessage("ship it")]));
    await collect(await send(transport, [userMessage("main")]));

    expect(received).toEqual([{ text: "ship it" }, { text: "main", replyToId: "wait-7" }]);
  });

  test("reply ids stay with their chat when two turns share the socket", async () => {
    const { received, connectionCount, url } = serveWire([
      [{ type: "receipt", status: "accepted" }],
      [
        { type: "receipt", status: "accepted" },
        { type: "message", messageId: "wait-a", text: "answer A" },
        { type: "message", messageId: "wait-b", text: "answer B" },
      ],
      [{ type: "message", messageId: "done-a", text: "done A" }],
      [{ type: "message", messageId: "done-b", text: "done B" }],
    ]);
    const transport = createGatewayChatTransport({ url });

    const first = send(transport, [userMessage("start A")], undefined, "chat-a");
    const second = send(transport, [userMessage("start B")], undefined, "chat-b");
    const [firstChunks, secondChunks] = await Promise.all([
      first.then(collect),
      second.then(collect),
    ]);
    expect(
      firstChunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.delta),
    ).toEqual(["answer A"]);
    expect(
      secondChunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.delta),
    ).toEqual(["answer B"]);
    await collect(await send(transport, [userMessage("reply A")], undefined, "chat-a"));
    await collect(await send(transport, [userMessage("reply B")], undefined, "chat-b"));

    expect(received).toEqual([
      { text: "start A" },
      { text: "start B" },
      { text: "reply A", replyToId: "wait-a" },
      { text: "reply B", replyToId: "wait-b" },
    ]);
    expect(connectionCount()).toBe(1);
  });

  test("preserves subprotocol offers on the real socket", async () => {
    const { protocols, url } = serveWire([
      [{ type: "message", messageId: "authenticated", text: "connected" }],
    ]);
    const transport = createGatewayChatTransport({
      url,
      protocols: ["openomni", "bearer.test-token"],
    });

    await collect(await send(transport, [userMessage("connect")]));

    expect(protocols).toEqual(["openomni, bearer.test-token"]);
  });

  test("ignores malformed frames and retains unsolicited reply correlation", async () => {
    ControlledSocket.instances.length = 0;
    const transport = createGatewayChatTransport({
      url: "ws://controlled",
      WebSocketImpl: ControlledSocket,
    });
    const sending = send(transport, [userMessage("first")]);
    const controlled = ControlledSocket.instances[0];
    if (controlled === undefined) throw new Error("socket was not constructed");
    controlled.open();
    const collected = collect(await sending);
    for (const raw of [
      "not-json",
      "null",
      "[]",
      JSON.stringify({ type: "message", messageId: "missing-text" }),
      JSON.stringify({ type: "message", text: "missing-id" }),
      JSON.stringify({ type: "message", messageId: 3, text: "wrong-id" }),
      JSON.stringify({ type: "receipt", status: "rejected" }),
      JSON.stringify({ type: "error", message: 3 }),
      JSON.stringify({ type: "future" }),
      new ArrayBuffer(0),
      new Blob(["binary"]),
    ])
      controlled.receive(raw);
    controlled.respond("first");
    expect(
      (await collected).filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.delta),
    ).toEqual(["first"]);

    controlled.receive(
      JSON.stringify({ type: "message", messageId: "unsolicited", text: "next question" }),
    );
    const reply = collect(await send(transport, [userMessage("answer")]));
    controlled.respond("done");
    await reply;
    expect(controlled.sent).toEqual([
      { text: "first" },
      { text: "answer", replyToId: "unsolicited" },
    ]);
  });

  test("cancelling a stream invalidates its socket and clears reply correlation", async () => {
    ControlledSocket.instances.length = 0;
    const transport = createGatewayChatTransport({
      url: "ws://controlled",
      WebSocketImpl: ControlledSocket,
    });
    const sending = send(transport, [userMessage("first")]);
    const controlled = ControlledSocket.instances[0];
    if (controlled === undefined) throw new Error("socket was not constructed");
    controlled.open();
    const first = collect(await sending);
    controlled.respond("first");
    await first;
    const cancelled = await send(transport, [userMessage("cancel")]);
    await cancelled.cancel();
    expect(controlled.readyState).toBe(2);

    const retry = send(transport, [userMessage("retry")]);
    const replacement = ControlledSocket.instances[1];
    if (replacement === undefined) throw new Error("replacement was not constructed");
    replacement.open();
    const result = collect(await retry);
    replacement.respond("done");
    await result;
    expect(replacement.sent).toEqual([{ text: "retry" }]);
  });

  test("rejects regeneration instead of appending the historical prompt again", async () => {
    const { received, url } = serveWire([]);
    const transport = createGatewayChatTransport({ url });

    await expect(
      transport.sendMessages({
        trigger: "regenerate-message",
        chatId: "chat-1",
        messageId: "assistant-1",
        messages: [userMessage("do not duplicate")],
        abortSignal: undefined,
      }),
    ).rejects.toThrow("does not support regeneration");
    expect(received).toEqual([]);
  });

  test("an already-aborted turn never reaches the gateway", async () => {
    const { received, url } = serveWire([]);
    const transport = createGatewayChatTransport({ url });
    const controller = new AbortController();
    controller.abort();

    const chunks = await collect(
      await send(transport, [userMessage("do not send")], controller.signal),
    );

    expect(chunks).toEqual([]);
    expect(received).toEqual([]);
  });

  test("an abort settles while the socket is still opening", async () => {
    ControlledSocket.instances.length = 0;
    const transport = createGatewayChatTransport({
      url: "ws://controlled",
      WebSocketImpl: ControlledSocket,
    });
    const controller = new AbortController();

    const aborted = send(transport, [userMessage("first")], controller.signal);
    const openingSocket = ControlledSocket.instances[0];
    if (openingSocket === undefined) throw new Error("opening socket was not constructed");
    controller.abort();

    expect(await collect(await aborted)).toEqual([]);
    expect(openingSocket.readyState).toBe(2);
  });

  test("aborting ends the stream", async () => {
    // The server never answers, so only the abort can end this read.
    const { url } = serveWire([[]]);
    const transport = createGatewayChatTransport({ url });
    const controller = new AbortController();

    const stream = await send(transport, [userMessage("hang")], controller.signal);
    const reader = stream.getReader();
    const read = reader.read();
    controller.abort();

    expect((await read).done).toBe(true);
  });

  test("aborting one turn fails sibling turns on the invalidated socket", async () => {
    ControlledSocket.instances.length = 0;
    const transport = createGatewayChatTransport({
      url: "ws://controlled",
      WebSocketImpl: ControlledSocket,
    });
    const controller = new AbortController();

    const firstSend = send(transport, [userMessage("one")], controller.signal, "chat-a");
    const controlled = ControlledSocket.instances[0];
    if (controlled === undefined) throw new Error("socket was not constructed");
    controlled.open();
    const firstStream = await firstSend;
    const secondStream = await send(transport, [userMessage("two")], undefined, "chat-b");

    controller.abort();

    expect(await collect(firstStream)).toEqual([]);
    expect(await collect(secondStream)).toEqual([
      { type: "error", errorText: "gateway socket closed by another turn" },
    ]);
  });

  test("a completed turn cannot later close the shared socket", async () => {
    const { connectionCount, url } = serveWire([
      [{ type: "message", messageId: "first", text: "first" }],
      [{ type: "message", messageId: "second", text: "second" }],
    ]);
    const transport = createGatewayChatTransport({ url });
    const firstController = new AbortController();

    await collect(await send(transport, [userMessage("one")], firstController.signal));
    firstController.abort();
    const chunks = await collect(await send(transport, [userMessage("two")]));

    expect(chunks.some((chunk) => chunk.type === "text-delta" && chunk.delta === "second")).toBe(
      true,
    );
    expect(connectionCount()).toBe(1);
  });

  test("an unexpected socket close fails its pending turn", async () => {
    ControlledSocket.instances.length = 0;
    const transport = createGatewayChatTransport({
      url: "ws://controlled",
      WebSocketImpl: ControlledSocket,
    });

    const sending = send(transport, [userMessage("one")]);
    const controlled = ControlledSocket.instances[0];
    if (controlled === undefined) throw new Error("socket was not constructed");
    controlled.open();
    const stream = await sending;
    controlled.finishClose();

    expect(await collect(stream)).toEqual([
      { type: "error", errorText: "gateway socket closed unexpectedly" },
    ]);
  });

  test("an old socket close cannot drain a turn on its replacement", async () => {
    ControlledSocket.instances.length = 0;
    const transport = createGatewayChatTransport({
      url: "ws://controlled",
      WebSocketImpl: ControlledSocket,
    });

    const firstSend = send(transport, [userMessage("one")]);
    const firstSocket = ControlledSocket.instances[0];
    if (firstSocket === undefined) throw new Error("first socket was not constructed");
    firstSocket.open();
    const firstStream = await firstSend;
    firstSocket.respond("first");
    await collect(firstStream);

    firstSocket.beginClose();
    const secondSend = send(transport, [userMessage("two")]);
    const secondSocket = ControlledSocket.instances[1];
    if (secondSocket === undefined) throw new Error("replacement socket was not constructed");
    secondSocket.open();
    const secondStream = await secondSend;

    firstSocket.finishClose();
    secondSocket.respond("second");
    const chunks = await collect(secondStream);

    expect(chunks.some((chunk) => chunk.type === "text-delta" && chunk.delta === "second")).toBe(
      true,
    );
  });

  test("a socket that fails while opening is replaced on retry", async () => {
    ControlledSocket.instances.length = 0;
    const transport = createGatewayChatTransport({
      url: "ws://controlled",
      WebSocketImpl: ControlledSocket,
    });

    const failedSend = send(transport, [userMessage("first")]);
    const failedSocket = ControlledSocket.instances[0];
    if (failedSocket === undefined) throw new Error("failed socket was not constructed");
    const failure = failedSend.then(
      () => {
        throw new Error("opening failure unexpectedly succeeded");
      },
      (error: Error) => error,
    );
    failedSocket.fail();
    expect((await failure).message).toContain("gateway socket failed");

    const retry = send(transport, [userMessage("retry")]);
    const replacement = ControlledSocket.instances[1];
    if (replacement === undefined) throw new Error("replacement socket was not constructed");
    replacement.open();
    const stream = await retry;
    replacement.respond("recovered");

    expect(
      (await collect(stream)).some(
        (chunk) => chunk.type === "text-delta" && chunk.delta === "recovered",
      ),
    ).toBe(true);
  });

  test("the SDK reduces the chunks into one assistant message", async () => {
    const { url } = serveWire([
      [
        { type: "receipt", status: "accepted" },
        { type: "message", messageId: "sdk-message", text: "two files touched" },
      ],
    ]);
    let ids = 0;
    const chat = new Chat<UIMessage>({
      transport: createGatewayChatTransport({ url }),
      generateId: () => {
        ids += 1;
        return `id-${ids}`;
      },
    });

    await chat.sendMessage({ text: "what changed?" });

    expect(chat.status).toBe("ready");
    const last = chat.lastMessage;
    if (last === undefined) throw new Error("no message was reduced");
    expect(last.role).toBe("assistant");
    expect(last.parts.map((part) => (part.type === "text" ? part.text : "")).join("")).toBe(
      "two files touched",
    );
  });
});
