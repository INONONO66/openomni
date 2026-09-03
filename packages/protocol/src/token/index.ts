import { z } from "zod";

export namespace Token {
  export const Count = z.number().int().nonnegative();

  /**
   * Shared token usage shape used by runtime and provider-facing contracts.
   *
   * `totalTokens` is optional at provider boundaries because some SDKs only
   * return split input/output counts. Agent-runtime events use `AgentUsage`
   * when total accounting is required.
   *
   * Invariant: `totalTokens` is the runtime accounting total. Today that means
   * input + output tokens; reasoning/cache counters are auxiliary dimensions,
   * not extra additive fields.
   */
  export const Usage = z.object({
    inputTokens: Count,
    outputTokens: Count,
    totalTokens: Count.optional(),
    reasoningTokens: Count.optional(),
    cacheReadTokens: Count.optional(),
    cacheWriteTokens: Count.optional(),
  });
  export type Usage = z.infer<typeof Usage>;

  /**
   * Agent-runtime accounting requires `totalTokens` so budget and execution
   * events can make deterministic accounting decisions.
   */
  export const AgentUsage = Usage.extend({
    totalTokens: Count,
  });
  export type AgentUsage = z.infer<typeof AgentUsage>;

  /**
   * Provider-facing usage omits `totalTokens` because many SDK responses expose
   * only split token counters.
   */
  export const ProviderUsage = Usage.omit({
    totalTokens: true,
  });
  export type ProviderUsage = z.infer<typeof ProviderUsage>;
}
