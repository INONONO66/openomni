import type { Adapter, Ingress } from "@openomni/protocol";

/**
 * Platform API calls: send messages, typing indicators, authentication, rate limiting.
 * MUST NOT: parse inbound payloads, manage adapter lifecycle, call IngressEngine.
 */
export interface ChannelClient {
  send(channelId: string, text: string): Promise<void>;
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

/**
 * IngressResult → platform-specific send operations via ChannelClient.
 * MUST NOT: interpret business logic, call IngressEngine, manage adapter lifecycle.
 */
export interface OutboundFormatter {
  format(result: Ingress.IngressResult, channelId: string, client: ChannelClient): Promise<void>;
}

/**
 * Lifecycle management: start/stop/reconnect, handler wiring, deduplication.
 * MUST NOT: inline platform API calls directly (use ChannelClient for that).
 */
export interface ChannelSurface {
  start(handler: Adapter.MessageHandler): Promise<void>;
  stop(): Promise<void>;
}
