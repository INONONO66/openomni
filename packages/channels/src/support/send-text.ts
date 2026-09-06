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
  const chunks = render.messageLimit === null ? [rendered] : chunkMarkdown(rendered, render.messageLimit);
  for (const chunk of chunks) {
    lastMessageId = (await send(chunk)) ?? lastMessageId;
  }
  return lastMessageId;
}
