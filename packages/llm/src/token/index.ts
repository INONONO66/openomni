import { Log } from "@openomni/session";

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
  cacheReadCost?: number;
  cacheWriteCost?: number;
  reasoningCost?: number;
  totalCost: number;
}

interface ModelPricingEntry {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
  reasoningPerMillion?: number;
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
    const providerMetadata = response.providerMetadata;
    if (!response.usage) {
      return {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
    }

    const u = response.usage as Record<string, unknown>;
    const details = (key: string) => (u[key] ?? {}) as Record<string, unknown>;
    const num = (v: unknown): number => (typeof v === "number" ? v : 0);

    const inputTokens =
      num(u.inputTokens) || num(u.input_tokens) || num(u.promptTokens) || num(u.prompt_tokens);

    const outputTokens =
      num(u.outputTokens) ||
      num(u.output_tokens) ||
      num(u.completionTokens) ||
      num(u.completion_tokens);

    const reasoningTokens =
      num(details("outputTokenDetails").reasoningTokens) ||
      num(u.reasoningTokens) ||
      num(u.reasoning_tokens) ||
      num(
        (details("raw").completion_tokens_details as Record<string, unknown> | undefined)
          ?.reasoning_tokens,
      ) ||
      num(providerMetadata?.anthropic?.reasoningTokens) ||
      num(providerMetadata?.openai?.reasoningTokens);

    const cacheReadTokens =
      num(details("inputTokenDetails").cacheReadTokens) ||
      num(u.cacheReadTokens) ||
      num(u.cache_read_input_tokens) ||
      num(providerMetadata?.anthropic?.cacheReadInputTokens) ||
      num(providerMetadata?.openai?.cachedPromptTokens);

    const cacheWriteTokens =
      num(details("inputTokenDetails").cacheWriteTokens) ||
      num(u.cacheWriteTokens) ||
      num(u.cache_creation_input_tokens) ||
      num(providerMetadata?.anthropic?.cacheCreationInputTokens);

    return {
      inputTokens,
      outputTokens,
      reasoningTokens,
      cacheReadTokens,
      cacheWriteTokens,
    };
  }

  export function calculateCost(
    usage: TokenUsage,
    modelId: string,
    modelCost?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      reasoning?: number;
    },
  ): TokenCost {
    const staticPricing = MODEL_PRICING[modelId];

    const inputRate = modelCost?.input ?? staticPricing?.inputPerMillion ?? 0;
    const outputRate = modelCost?.output ?? staticPricing?.outputPerMillion ?? 0;

    if (!modelCost?.input && !staticPricing) {
      Log.warn("no pricing data for model, cost set to 0", { modelId });
      return { inputCost: 0, outputCost: 0, totalCost: 0 };
    }

    const inputCost = (usage.inputTokens / 1_000_000) * inputRate;
    const outputCost = (usage.outputTokens / 1_000_000) * outputRate;

    const cacheReadRate =
      modelCost?.cacheRead ?? staticPricing?.cacheReadPerMillion ?? inputRate * 0.1;
    const cacheWriteRate =
      modelCost?.cacheWrite ?? staticPricing?.cacheWritePerMillion ?? inputRate * 1.25;
    const reasoningRate = modelCost?.reasoning ?? staticPricing?.reasoningPerMillion ?? outputRate;

    const cacheReadCost = ((usage.cacheReadTokens ?? 0) / 1_000_000) * cacheReadRate;
    const cacheWriteCost = ((usage.cacheWriteTokens ?? 0) / 1_000_000) * cacheWriteRate;
    const reasoningCost = ((usage.reasoningTokens ?? 0) / 1_000_000) * reasoningRate;

    return {
      inputCost,
      outputCost,
      cacheReadCost: cacheReadCost || undefined,
      cacheWriteCost: cacheWriteCost || undefined,
      reasoningCost: reasoningCost || undefined,
      totalCost: inputCost + outputCost + cacheReadCost + cacheWriteCost + reasoningCost,
    };
  }
}
