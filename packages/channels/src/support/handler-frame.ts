import type { Channel } from "@openomni/protocol";

export function requireHandler(
  handler: Channel.MessageHandler | null,
  surfaceId: string,
): Channel.MessageHandler {
  if (!handler) {
    throw new Error(
      `[${surfaceId}] No message handler registered. Call onMessage() before start().`,
    );
  }
  return handler;
}
