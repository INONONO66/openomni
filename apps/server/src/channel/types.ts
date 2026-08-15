import type { Adapter, BusEvent } from "@openomni/protocol";

/**
 * Observation port: channel code reports Operational telemetry through this
 * injected function instead of importing the session Bus directly (precedent:
 * the execution coordinator's `events.publish` injection). The composition
 * root (bootstrap/channels.ts) binds it to Bus.publish; tests bind a
 * collector or noop. #499 promotes this to the Channel protocol contract.
 */
export type PublishPort = BusEvent.Sink["publish"];

/**
 * Platform API calls: send messages, typing indicators, authentication, rate limiting.
 * MUST NOT: parse inbound payloads, manage adapter lifecycle, call IngressEngine.
 * `send` returns the platform message id when the channel API provides one
 * (Discord and Telegram do); awaited-delivery correlation records it.
 */
export interface ChannelClient {
  /** `traceId` is the causing occurrence's trace (D11) — the inbound message for replies, the surface's documented origin mint for outbound sends; retries of one send share it. */
  send(channelId: string, text: string, traceId: string): Promise<string | undefined>;
  /** `traceId` is the inbound message's trace (D11) — typing is part of that message's causal chain. */
  sendTyping?(channelId: string, traceId: string): Promise<void>;
}

/**
 * Raw platform payload → Adapter.InboundMessage.
 * MUST NOT: call platform API, manage state, or have side effects.
 * Pure transformation function — same input always produces same output.
 */
export interface InboundNormalizer<TPayload = unknown> {
  /** `traceId` is the surface's first-frame mint (D11) — the normalizer stamps it onto the InboundMessage, never mints. */
  normalize(payload: TPayload, traceId: string): Adapter.InboundMessage | null;
}
