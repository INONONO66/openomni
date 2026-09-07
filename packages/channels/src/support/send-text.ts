import type { RenderPolicy } from "../provider/contract";
import { chunkMarkdown } from "./format/chunk";

export class PartialDeliveryError extends Error {
  constructor(
    readonly acceptedChunks: { index: number; externalMessageId: string }[],
    readonly attemptedChunks: number,
    readonly totalChunks: number,
    readonly reason: "missing_receipt" | "send_failed",
    options?: ErrorOptions,
  ) {
    super("partial message delivery", options);
    this.name = "PartialDeliveryError";
  }
}

/** Rendering and chunk sequencing are shared; each driver owns its physical send. */
export async function sendText(
  content: string,
  render: RenderPolicy,
  send: (chunk: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  if (content.length === 0) return undefined;
  let lastMessageId: string | undefined;
  const rendered = render.renderMarkdown(content);
  const chunks =
    render.messageLimit === null ? [rendered] : chunkMarkdown(rendered, render.messageLimit);
  const acceptedChunks: { index: number; externalMessageId: string }[] = [];
  let attemptedChunks = 0;
  for (const chunk of chunks) {
    attemptedChunks += 1;
    try {
      lastMessageId = await send(chunk);
      if (lastMessageId !== undefined) {
        acceptedChunks.push({ index: attemptedChunks, externalMessageId: lastMessageId });
      }
    } catch (error) {
      // Earlier acceptance or uncertainty prevents a whole-message rejection.
      if (attemptedChunks > 1) {
        throw new PartialDeliveryError(
          acceptedChunks,
          attemptedChunks,
          chunks.length,
          "send_failed",
          { cause: error },
        );
      }
      throw error;
    }
  }
  if (acceptedChunks.length > 0 && acceptedChunks.length !== chunks.length) {
    throw new PartialDeliveryError(
      acceptedChunks,
      attemptedChunks,
      chunks.length,
      "missing_receipt",
    );
  }
  return lastMessageId;
}
