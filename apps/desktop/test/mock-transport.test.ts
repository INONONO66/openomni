import { describe, expect, test } from "bun:test";
import type { UIMessage, UIMessageChunk } from "ai";
import { createMockChatTransport } from "../src/renderer/chat/mock-transport";

const tick = (): Promise<void> => Promise.resolve();

function user(text: string): UIMessage {
  return { id: "user-1", role: "user", parts: [{ type: "text", text }] };
}

async function collect(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = [];
  const reader = stream.getReader();
  for (;;) {
    const result = await reader.read();
    if (result.done) return chunks;
    chunks.push(result.value);
  }
}

function send(
  transport: ReturnType<typeof createMockChatTransport>,
  messages: readonly UIMessage[],
  abortSignal?: AbortSignal,
) {
  return transport.sendMessages({
    trigger: "submit-message",
    chatId: "chat-1",
    messageId: undefined,
    messages: [...messages],
    abortSignal,
  });
}

describe("createMockChatTransport", () => {
  test("emits the SDK text chunk sequence with fixed-size deltas", async () => {
    const transport = createMockChatTransport({ replies: ["hello world"], chunkSize: 5, tick });

    const chunks = await collect(await send(transport, [user("hi")]));

    expect(chunks).toEqual([
      { type: "start" },
      { type: "text-start", id: "mock-text-0" },
      { type: "text-delta", id: "mock-text-0", delta: "hello" },
      { type: "text-delta", id: "mock-text-0", delta: " worl" },
      { type: "text-delta", id: "mock-text-0", delta: "d" },
      { type: "text-end", id: "mock-text-0" },
      { type: "finish" },
    ]);
  });

  test("cycles through canned replies", async () => {
    const transport = createMockChatTransport({ replies: ["one", "two"], tick });

    const first = await collect(await send(transport, [user("first")]));
    const second = await collect(await send(transport, [user("second")]));
    const third = await collect(await send(transport, [user("third")]));

    const text = (chunks: readonly UIMessageChunk[]) =>
      chunks
        .filter(
          (chunk): chunk is Extract<UIMessageChunk, { type: "text-delta" }> =>
            chunk.type === "text-delta",
        )
        .map((chunk) => chunk.delta)
        .join("");
    expect([text(first), text(second), text(third)]).toEqual(["one", "two", "one"]);
  });

  test("releases its abort listener when a stream completes", async () => {
    const controller = new AbortController();
    const removeEventListener = controller.signal.removeEventListener.bind(controller.signal);
    let removed = 0;
    Object.defineProperty(controller.signal, "removeEventListener", {
      value(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions,
      ) {
        if (type === "abort") removed += 1;
        removeEventListener(type, listener, options);
      },
    });
    const transport = createMockChatTransport({ replies: ["done"], tick });

    await collect(await send(transport, [user("finish")], controller.signal));

    expect(removed).toBe(1);
  });

  test("abort closes the stream before a pending delta tick resumes", async () => {
    let releaseTick: (() => void) | undefined;
    const tickGate = () =>
      new Promise<void>((resolve) => {
        releaseTick = resolve;
      });
    const transport = createMockChatTransport({ replies: ["hello"], chunkSize: 2, tick: tickGate });
    const controller = new AbortController();
    const stream = await send(transport, [user("stop")], controller.signal);
    const reader = stream.getReader();

    const first = await reader.read();
    expect(first.value?.type).toBe("start");
    const second = await reader.read();
    expect(second.value?.type).toBe("text-start");
    const third = await reader.read();
    expect(third.value?.type).toBe("text-delta");
    const pendingDelta = reader.read();
    controller.abort();
    releaseTick?.();

    expect(await pendingDelta).toMatchObject({ done: true });
  });
});
