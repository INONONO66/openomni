export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface TokenCost {
  inputCost: number;
  outputCost: number;
  totalCost: number;
}

interface ModelPricingEntry {
  inputPerMillion: number;
  outputPerMillion: number;
}

const MODEL_PRICING: Record<string, ModelPricingEntry> = {
  "claude-opus-4-5": { inputPerMillion: 15.0, outputPerMillion: 75.0 },
  "claude-sonnet-4-5": { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  "claude-haiku-4-5": { inputPerMillion: 0.8, outputPerMillion: 4.0 },
  "claude-3-5-sonnet-20241022": {
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
  },
  "claude-3-5-haiku-20241022": { inputPerMillion: 0.8, outputPerMillion: 4.0 },
  "claude-3-opus-20240229": { inputPerMillion: 15.0, outputPerMillion: 75.0 },
  "claude-3-haiku-20240307": { inputPerMillion: 0.25, outputPerMillion: 1.25 },
  "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10.0 },
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  "gpt-4-turbo": { inputPerMillion: 10.0, outputPerMillion: 30.0 },
  "gpt-3.5-turbo": { inputPerMillion: 0.5, outputPerMillion: 1.5 },
};

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  raw?: {
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  reasoning_tokens?: number;
  raw?: {
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
}

interface UsageDetails {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  inputTokenDetails?: {
    noCacheTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  outputTokenDetails?: {
    textTokens?: number;
    reasoningTokens?: number;
  };
  raw?: {
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

interface ProviderMetadata {
  anthropic?: {
    reasoningTokens?: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  };
  openai?: {
    reasoningTokens?: number;
    cachedPromptTokens?: number;
  };
}

export namespace TokenTracker {
  export function extractUsage(response: {
    usage?: AnthropicUsage | OpenAIUsage | UsageDetails;
    providerMetadata?: ProviderMetadata;
  }): TokenUsage {
    const usage = response.usage;
    const providerMetadata = response.providerMetadata;
    if (!usage) {
      return {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
    }

    const inputTokens =
      "inputTokens" in usage
        ? (usage.inputTokens ?? 0)
        : "input_tokens" in usage
          ? (usage.input_tokens ?? 0)
          : "prompt_tokens" in usage
            ? (usage.prompt_tokens ?? 0)
            : 0;

    const outputTokens =
      "outputTokens" in usage
        ? (usage.outputTokens ?? 0)
        : "output_tokens" in usage
          ? (usage.output_tokens ?? 0)
          : "completion_tokens" in usage
            ? (usage.completion_tokens ?? 0)
            : 0;

    const reasoningTokens =
      "outputTokenDetails" in usage
        ? (usage.outputTokenDetails?.reasoningTokens ?? 0)
        : "reasoningTokens" in usage
          ? (usage.reasoningTokens ?? 0)
          : "reasoning_tokens" in usage
            ? (usage.reasoning_tokens ?? 0)
            : "raw" in usage
              ? (usage.raw?.completion_tokens_details?.reasoning_tokens ??
                providerMetadata?.anthropic?.reasoningTokens ??
                providerMetadata?.openai?.reasoningTokens ??
                0)
              : (providerMetadata?.anthropic?.reasoningTokens ??
                providerMetadata?.openai?.reasoningTokens ??
                0);

    const cacheReadTokens =
      "inputTokenDetails" in usage
        ? (usage.inputTokenDetails?.cacheReadTokens ?? 0)
        : "cacheReadTokens" in usage
          ? (usage.cacheReadTokens ?? 0)
          : "cache_read_input_tokens" in usage
            ? (usage.cache_read_input_tokens ?? 0)
            : (providerMetadata?.anthropic?.cacheReadInputTokens ??
              providerMetadata?.openai?.cachedPromptTokens ??
              0);

    const cacheWriteTokens =
      "inputTokenDetails" in usage
        ? (usage.inputTokenDetails?.cacheWriteTokens ?? 0)
        : "cacheWriteTokens" in usage
          ? (usage.cacheWriteTokens ?? 0)
          : "cache_creation_input_tokens" in usage
            ? (usage.cache_creation_input_tokens ?? 0)
            : (providerMetadata?.anthropic?.cacheCreationInputTokens ?? 0);

    return {
      inputTokens,
      outputTokens,
      reasoningTokens,
      cacheReadTokens,
      cacheWriteTokens,
    };
  }

  export function calculateCost(usage: TokenUsage, modelId: string): TokenCost {
    const pricing = MODEL_PRICING[modelId];
    if (!pricing) {
      console.warn(`[TokenTracker] No pricing data for model '${modelId}'. Cost set to 0.`);
      return { inputCost: 0, outputCost: 0, totalCost: 0 };
    }

    const inputCost = (usage.inputTokens / 1_000_000) * pricing.inputPerMillion;
    const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputPerMillion;
    return {
      inputCost,
      outputCost,
      totalCost: inputCost + outputCost,
    };
  }
}
