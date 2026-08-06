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
      numberField(usage, "inputTokens") ||
      numberField(usage, "input_tokens") ||
      numberField(usage, "promptTokens") ||
      numberField(usage, "prompt_tokens");

    const outputTokens =
      numberField(usage, "outputTokens") ||
      numberField(usage, "output_tokens") ||
      numberField(usage, "completionTokens") ||
      numberField(usage, "completion_tokens");

    const reasoningTokens =
      numberField(outputDetails, "reasoningTokens") ||
      numberField(usage, "reasoningTokens") ||
      numberField(usage, "reasoning_tokens") ||
      rawReasoningTokens(usage.raw) ||
      providerMetadataNumber(response.providerMetadata, "anthropic", "reasoningTokens") ||
      providerMetadataNumber(response.providerMetadata, "openai", "reasoningTokens");

    const cacheReadTokens =
      numberField(inputDetails, "cacheReadTokens") ||
      numberField(usage, "cachedInputTokens") ||
      numberField(usage, "cacheReadTokens") ||
      numberField(usage, "cache_read_input_tokens") ||
      providerMetadataNumber(response.providerMetadata, "anthropic", "cacheReadInputTokens") ||
      providerMetadataNumber(response.providerMetadata, "openai", "cachedPromptTokens");

    const cacheWriteTokens =
      numberField(inputDetails, "cacheWriteTokens") ||
      numberField(usage, "cacheWriteTokens") ||
      numberField(usage, "cache_creation_input_tokens") ||
      providerMetadataNumber(response.providerMetadata, "anthropic", "cacheCreationInputTokens");

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

  function numberField(record: Record<string, unknown>, key: string): number {
    const value = record[key];
    return typeof value === "number" ? value : 0;
  }

  function recordField(record: Record<string, unknown>, key: string): Record<string, unknown> {
    const value = record[key];
    return isRecord(value) ? value : {};
  }

  function providerMetadataNumber(metadata: unknown, provider: string, key: string): number {
    if (!isRecord(metadata)) return 0;
    const providerMetadata = metadata[provider];
    if (!isRecord(providerMetadata)) return 0;
    return numberField(providerMetadata, key);
  }

  function rawReasoningTokens(raw: unknown): number {
    if (!isRecord(raw)) return 0;
    const details = raw.completion_tokens_details;
    if (!isRecord(details)) return 0;
    const tokens = details.reasoning_tokens;
    return typeof tokens === "number" ? tokens : 0;
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }
}
