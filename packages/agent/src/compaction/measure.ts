import type { Message } from "@openomni/protocol";

/**
 * The context a model call actually consumed, as the provider measured it:
 * fresh input plus both cache lanes — a cached token still occupies the
 * window. This is ground truth from the last response, not an estimate; the
 * old trigger summed the run's cumulative spend, which re-counts every prior
 * turn's input and only ever grows.
 */
export function measuredContextTokens(tokens: Message.AssistantMessage["tokens"]): number {
  return tokens.input + tokens.cache.read + tokens.cache.write;
}
