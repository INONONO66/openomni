import type { Channel } from "@openomni/protocol";

/** Boot guard shared by the polling/webhook surfaces: starting without a handler is a wiring bug, fail loud. */
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

/**
 * Shared run-and-reply frame for typing-capable surfaces: keep the typing
 * indicator alive while the handler runs, deliver its reply, and on a handler
 * throw record the error (via `onError`) and send the apology line instead of
 * going silent. The typing interval is always cleared, throw or not; an
 * apology-send failure propagates to the caller's dedupe-release path.
 */
export async function respondUnderTyping(opts: {
  readonly typing: () => void;
  readonly typingIntervalMs: number;
  readonly run: () => Promise<Channel.OutboundMessage | null | undefined>;
  readonly send: (message: Channel.OutboundMessage) => Promise<string | undefined>;
  readonly onError: (err: string) => void;
}): Promise<void> {
  opts.typing();
  const typingInterval = setInterval(opts.typing, opts.typingIntervalMs);
  try {
    const outbound = await opts.run();
    if (outbound) await opts.send(outbound);
  } catch (err) {
    opts.onError(String(err));
    await opts.send({ text: "Sorry, an error occurred." });
  } finally {
    clearInterval(typingInterval);
  }
}
