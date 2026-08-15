import type { Message } from "@openomni/protocol";

/**
 * The context the turn's final model call actually consumed, as the provider
 * measured it: the last step-finish part's input tokens.
 *
 * Two shapes that look usable here are not. `message.info.tokens` sums every
 * step of the turn — a tool-using turn resends the conversation per step, so
 * the sum grows with step count while the window does not. And the cache
 * lanes are NOT addends: the ai SDK normalizes each step's `input` to the
 * cache-inclusive prompt total on both bundled providers (the token-tracker
 * pin fixes input 100 = 90 fresh + 7 read + 3 write), so adding `cache.read`
 * back would double-count a warm cache. The last step's `input`, alone, is
 * the window.
 *
 * Undefined when no step finished — nothing was measured, and the caller
 * records nothing rather than a guess.
 */
export function measuredContextTokens(message: Message.WithParts): number | undefined {
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index];
    if (part?.type === "step-finish") return part.tokens.input;
  }
  return undefined;
}
