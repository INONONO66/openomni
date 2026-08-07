import type { Adapter } from "@openomni/protocol";

/**
 * Platform API calls: send messages, typing indicators, authentication, rate limiting.
 * MUST NOT: parse inbound payloads, manage adapter lifecycle, call IngressEngine.
 * `send` returns the platform message id when the channel API provides one
 * (Discord and Telegram do); awaited-delivery correlation records it.
 */
export interface ChannelClient {
  send(channelId: string, text: string): Promise<string | undefined>;
  sendTyping?(channelId: string): Promise<void>;
}

/**
 * Raw platform payload → Adapter.InboundMessage.
 * MUST NOT: call platform API, manage state, or have side effects.
 * Pure transformation function — same input always produces same output.
 */
export interface InboundNormalizer<TPayload = unknown> {
  normalize(payload: TPayload): Adapter.InboundMessage | null;
}
