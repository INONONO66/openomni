import type { Token } from "@openomni/protocol";

/**
 * A step's locally computed token counts. The unit is the same token unit the
 * provider bills in, approximated: this is the substitute accounting used when
 * the provider's own counts are unusable (KERNEL §5.3).
 */
export type UsageEstimate = {
  readonly inputTokens: number;
  readonly outputTokens: number;
};

/**
 * Local usage estimator port. `serializedPrompt` is the step's prompt text as
 * it crossed to the provider; `emittedAssistant` is the assistant text the
 * step produced, tool-call JSON included. Injectable so a host can supply a
 * provider-specific tokenizer without this package growing one.
 */
export type EstimateUsage = (serializedPrompt: string, emittedAssistant: string) => UsageEstimate;

/**
 * The shipped default: deterministic `ceil(chars / 4)`. Four characters per
 * token is the coarse cross-provider ratio; the point is not tokenizer parity
 * but that a real model step never accounts as zero. Deterministic by
 * construction — same text in, same counts out, so multi-step totals are
 * reproducible.
 */
export const estimateUsage: EstimateUsage = (serializedPrompt, emittedAssistant) => ({
  inputTokens: Math.ceil(serializedPrompt.length / 4),
  outputTokens: Math.ceil(emittedAssistant.length / 4),
});

export namespace TokenTracker {
  /**
   * Provider accounting whose required counts may be unusable.
   *
   * `undefined` on `inputTokens`/`outputTokens` means the provider gave nothing
   * trustworthy for that field: the key was absent, its value was not a number,
   * or it was a number outside the count domain (NaN, infinite, negative,
   * fractional, unsafe). A reported numeric `0` is NOT unusable — it stays `0`
   * and remains authoritative. The step-finish fold substitutes the local
   * estimate for exactly the `undefined` fields (#933).
   */
  export function extractUsage(response: {
    readonly usage?: unknown;
    readonly providerMetadata?: unknown;
  }): Omit<Token.ProviderUsage, "inputTokens" | "outputTokens"> & {
    readonly inputTokens: number | undefined;
    readonly outputTokens: number | undefined;
  } {
    // Absent/non-record usage still validates providerMetadata-sourced positions:
    // an empty record makes every usage-field lookup absent without skipping metadata.
    const usage = isRecord(response.usage) ? response.usage : {};

    const inputDetails = recordField(usage, "inputTokenDetails");
    const outputDetails = recordField(usage, "outputTokenDetails");

    /**
     * Resolve a required count across its provider aliases, keyed on presence
     * rather than on usable value.
     *
     * The first alias the provider actually reported decides the outcome: a
     * reported `0` comes back as `0` (never demoted to a lower-priority alias),
     * and a reported-but-unusable value comes back `undefined` (never repaired
     * from a lower-priority alias either — a provider that contradicts itself
     * on one field is not a trustworthy source for that field).
     */
    function requiredCount(keys: readonly string[]): number | undefined {
      for (const key of keys) {
        if (!(key in usage)) continue;
        return numberField(usage, key);
      }
      return undefined;
    }

    const reasoningTokens =
      firstCount(
        numberField(outputDetails, "reasoningTokens"),
        numberField(usage, "reasoningTokens"),
        numberField(usage, "reasoning_tokens"),
        rawReasoningTokens(usage.raw),
        providerMetadataNumber(response.providerMetadata, "anthropic", "reasoningTokens"),
        providerMetadataNumber(response.providerMetadata, "openai", "reasoningTokens"),
      ) ?? 0;

    const cacheReadTokens =
      firstCount(
        numberField(inputDetails, "cacheReadTokens"),
        numberField(usage, "cachedInputTokens"),
        numberField(usage, "cacheReadTokens"),
        numberField(usage, "cache_read_input_tokens"),
        providerMetadataNumber(response.providerMetadata, "anthropic", "cacheReadInputTokens"),
        providerMetadataNumber(response.providerMetadata, "openai", "cachedPromptTokens"),
      ) ?? 0;

    const cacheWriteTokens =
      firstCount(
        numberField(inputDetails, "cacheWriteTokens"),
        numberField(usage, "cacheWriteTokens"),
        numberField(usage, "cache_creation_input_tokens"),
        providerMetadataNumber(response.providerMetadata, "anthropic", "cacheCreationInputTokens"),
      ) ?? 0;

    // The required counts have no zero default by construction: `requiredCount`
    // returns `undefined` for unusable accounting and the fold estimates it.
    return {
      inputTokens: requiredCount([
        "inputTokens",
        "input_tokens",
        "promptTokens",
        "prompt_tokens",
      ]),
      outputTokens: requiredCount([
        "outputTokens",
        "output_tokens",
        "completionTokens",
        "completion_tokens",
      ]),
      reasoningTokens,
      cacheReadTokens,
      cacheWriteTokens,
    };
  }

  function firstCount(...values: Array<number | undefined>): number | undefined {
    return values.find((value) => value !== undefined);
  }

  function numberField(record: Record<string, unknown>, key: string): number | undefined {
    const value = record[key];
    return typeof value === "number" && isCount(value) ? value : undefined;
  }

  function isCount(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function recordField(record: Record<string, unknown>, key: string): Record<string, unknown> {
    const value = record[key];
    return isRecord(value) ? value : {};
  }

  function providerMetadataNumber(
    metadata: unknown,
    provider: string,
    key: string,
  ): number | undefined {
    if (!isRecord(metadata)) return undefined;
    const providerMetadata = metadata[provider];
    if (!isRecord(providerMetadata)) return undefined;
    return numberField(providerMetadata, key);
  }

  function rawReasoningTokens(raw: unknown): number | undefined {
    if (!isRecord(raw)) return undefined;
    const details = raw.completion_tokens_details;
    if (!isRecord(details)) return undefined;
    return numberField(details, "reasoning_tokens");
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }
}
