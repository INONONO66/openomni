import type { RenderPolicy } from "../provider/contract";
import { chunkMarkdown } from "./format/chunk";

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
  let sent = false;
  for (const chunk of chunks) {
    try {
      lastMessageId = (await send(chunk)) ?? lastMessageId;
      sent = true;
    } catch (error) {
      // A later rejection cannot prove the whole logical message was rejected.
      if (sent) throw new Error("partial message delivery", { cause: error });
      throw error;
    }
  }
  return lastMessageId;
}
