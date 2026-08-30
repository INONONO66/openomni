import type { Token } from "@openomni/protocol";
import { InvalidUsageError } from "../error";

export namespace TokenTracker {
  export function extractUsage(response: {
    readonly usage?: unknown;
    readonly providerMetadata?: unknown;
  }): Token.ProviderUsage {
    // Absent/non-record usage still validates providerMetadata-sourced positions:
    // an empty record makes every usage-field lookup absent without skipping metadata.
    const usage = isRecord(response.usage) ? response.usage : {};

    const inputDetails = recordField(usage, "inputTokenDetails");
    const outputDetails = recordField(usage, "outputTokenDetails");

    const inputTokens =
      firstCount(
        numberField(usage, "inputTokens"),
        numberField(usage, "input_tokens"),
        numberField(usage, "promptTokens"),
        numberField(usage, "prompt_tokens"),
      ) ?? 0;

    const outputTokens =
      firstCount(
        numberField(usage, "outputTokens"),
        numberField(usage, "output_tokens"),
        numberField(usage, "completionTokens"),
        numberField(usage, "completion_tokens"),
      ) ?? 0;

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

    return {
      inputTokens,
      outputTokens,
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
    if (typeof value !== "number") return undefined;
    if (isCount(value)) return value;

    const valueClass = classifyInvalidCount(value);
    throw new InvalidUsageError({
      key,
      value: String(value),
      valueClass,
      message: `invalid token usage ${key}: ${valueClass} value (${String(value)})`,
    });
  }

  function isCount(value: number): value is number {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function classifyInvalidCount(value: number): string {
    if (Number.isNaN(value)) return "NaN";
    if (!Number.isFinite(value)) return "infinite";
    if (value < 0) return "negative";
    if (!Number.isInteger(value)) return "fractional";
    return "unsafe integer";
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
