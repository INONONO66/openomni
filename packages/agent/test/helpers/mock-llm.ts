import { Run, type Sink } from "@openomni/llm";
import type { ChatAgentConfig } from "../../src/core/types";
import { modelFixture } from "./model-fixture";

type MockLlmInput = {
  readonly messages?: readonly unknown[];
  readonly maxSteps?: number;
  readonly signal?: ChatAgentConfig["signal"];
  /** The steering stop condition the loop passes when config.steeringPending is set (#751). */
  readonly shouldYield?: () => boolean;
  /** The window-yield arm point — undefined when the yield is disarmed or the window unknown. */
  readonly yieldAtInputTokens?: number;
  /** The resolved model this call runs — reflects a model.override (#753) when one fired. */
  readonly model?: { readonly id: string; readonly providerID: string };
};

export type MockLlmFn = (input: MockLlmInput, sink: Sink) => Promise<Run.Outcome>;

export function createStopOutcome(): Run.Outcome {
  return { type: "stop" };
}

export function providerFailure(
  message: string,
  options: {
    retryable?: boolean;
    statusCode?: number;
    contextOverflow?: boolean;
    aborted?: boolean;
  } = {},
): Run.Failure {
  const cause = Object.assign(new Error(message), {
    name: "AI_APICallError",
    isRetryable: options.retryable ?? true,
    statusCode: options.statusCode ?? 529,
    responseHeaders: { "retry-after-ms": "0" },
  });
  return new Run.FailureError(
    {
      message,
      aborted: options.aborted ?? false,
      contextOverflow: options.contextOverflow ?? false,
      visibleOutput: false,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
    { cause },
  );
}

export const mockProviderData = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    npm: "@ai-sdk/anthropic",
    models: {
      "claude-3-haiku-20240307": {
        id: "claude-3-haiku-20240307",
        name: "Claude 3 Haiku",
      },
    },
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    env: ["OPENAI_API_KEY"],
    npm: "@ai-sdk/openai",
    models: {
      "gpt-4o": {
        id: "gpt-4o",
        name: "GPT-4o",
      },
      "gpt-5.1-codex-max": {
        id: "gpt-5.1-codex-max",
        name: "GPT-5.1 Codex Max",
      },
    },
  },
};

export const mockProviderModel = {
  id: "claude-3-haiku-20240307",
  name: "Claude 3 Haiku",
  providerID: "anthropic",
};

export function createMockLlmConfig(options: {
  readonly getModels: () => Promise<typeof mockProviderData>;
  readonly fromModelsDevModel: () => typeof mockProviderModel;
  readonly run: MockLlmFn;
}): NonNullable<ChatAgentConfig["llm"]> {
  return {
    run: modelFixture(options.run),
    resolveModel: async () => {
      await options.getModels();
      return options.fromModelsDevModel();
    },
  };
}
