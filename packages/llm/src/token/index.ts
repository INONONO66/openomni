import type { Token } from "@openomni/protocol";
import type { LanguageModelUsage } from "ai";

type UsageInput = Partial<LanguageModelUsage>;

export namespace TokenTracker {
  export function extractUsage(response: {
    readonly usage?: UsageInput | unknown;
    readonly providerMetadata?: unknown;
  }): Token.ProviderUsage {
    const usage = response.usage;
    if (!isRecord(usage)) {
      return zeroUsage();
    }

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

  function zeroUsage(): Token.ProviderUsage {
    return {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
  }

  function firstCount(...values: Array<number | undefined>): number | undefined {
    return values.find((value) => value !== undefined);
  }

  function numberField(record: Record<string, unknown>, key: string): number | undefined {
    const value = record[key];
    return isCount(value) ? value : undefined;
  }

  function isCount(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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
    return isCount(details.reasoning_tokens) ? details.reasoning_tokens : undefined;
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }
}
