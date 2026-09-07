import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";

interface MockChatTransportOptions {
  readonly replies?: readonly string[];
  readonly chunkSize?: number;
  readonly tick?: (ms: number) => Promise<void>;
}

async function microtaskTick(_ms: number): Promise<void> {
  await Promise.resolve();
}

/** A deterministic local transport for exercising streamed chat without a server. */
export function createMockChatTransport({
  replies = ["Mock response."],
  chunkSize = 12,
  tick = microtaskTick,
}: MockChatTransportOptions = {}): ChatTransport<UIMessage> {
  const size = Math.max(1, Math.floor(chunkSize));
  let replyIndex = 0;
  let textPartIndex = 0;

  return {
    async sendMessages({ abortSignal }) {
      const reply = replies.length === 0 ? "" : (replies[replyIndex % replies.length] ?? "");
      replyIndex += 1;
      const textPartId = `mock-text-${textPartIndex}`;
      textPartIndex += 1;

      let closed = false;
      let controller: ReadableStreamDefaultController<UIMessageChunk> | undefined;
      const abort = () => close();
      const close = () => {
        if (closed) return;
        closed = true;
        abortSignal?.removeEventListener("abort", abort);
        controller?.close();
      };

      const stream = new ReadableStream<UIMessageChunk>({
        start(streamController) {
          controller = streamController;
          abortSignal?.addEventListener("abort", abort, { once: true });

          if (abortSignal?.aborted) {
            close();
            return;
          }

          streamController.enqueue({ type: "start" });
          streamController.enqueue({ type: "text-start", id: textPartId });

          void (async () => {
            for (let at = 0; at < reply.length; at += size) {
              if (at > 0) await tick(0);
              if (closed) return;
              streamController.enqueue({
                type: "text-delta",
                id: textPartId,
                delta: reply.slice(at, at + size),
              });
            }
            if (closed) return;
            streamController.enqueue({ type: "text-end", id: textPartId });
            streamController.enqueue({ type: "finish" });
            close();
          })().catch((error: Error) => {
            if (!closed) streamController.error(error);
            closed = true;
            abortSignal?.removeEventListener("abort", abort);
          });
        },
        cancel() {
          closed = true;
          abortSignal?.removeEventListener("abort", abort);
        },
      });

      return stream;
    },

    reconnectToStream() {
      return Promise.resolve(null);
    },
  };
}
