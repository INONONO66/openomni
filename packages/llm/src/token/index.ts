export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
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
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

export namespace TokenTracker {
  export function extractUsage(response: {
    usage?: AnthropicUsage | OpenAIUsage;
  }): TokenUsage {
    const usage = response.usage;
    if (!usage) return { inputTokens: 0, outputTokens: 0 };

    if ("input_tokens" in usage) {
      return {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
      };
    }

    if ("prompt_tokens" in usage) {
      return {
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
      };
    }

    return { inputTokens: 0, outputTokens: 0 };
  }

  export function calculateCost(usage: TokenUsage, modelId: string): TokenCost {
    const pricing = MODEL_PRICING[modelId];
    if (!pricing) {
      console.warn(
        `[TokenTracker] No pricing data for model '${modelId}'. Cost set to 0.`,
      );
      return { inputCost: 0, outputCost: 0, totalCost: 0 };
    }

    const inputCost = (usage.inputTokens / 1_000_000) * pricing.inputPerMillion;
    const outputCost =
      (usage.outputTokens / 1_000_000) * pricing.outputPerMillion;
    return {
      inputCost,
      outputCost,
      totalCost: inputCost + outputCost,
    };
  }
}
