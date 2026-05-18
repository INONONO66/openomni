import type { Run, Sink, Tool } from "@openomni/protocol";
import type { ChatAgentConfig } from "../../src/core/types";

export type MockLlmInput = {
  readonly messages?: readonly unknown[];
  readonly maxSteps?: number;
  readonly signal?: AbortSignal;
  readonly toolExecutor?: (
    call: Tool.Call,
    context?: Tool.ExecutionContext,
  ) => Promise<Tool.Result>;
};

export type MockLlmFn = (input: MockLlmInput, sink: Sink) => Promise<Run.Outcome>;

export function createStopOutcome(): Run.Outcome {
  return { type: "stop" };
}

export function createAbortedOutcome(): Run.Outcome {
  return { type: "aborted" };
}

export function createErrorOutcome(message: string): Run.Outcome {
  return { type: "error", error: { message, name: "Error", stack: "" } };
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
    run: options.run,
    resolveProviderModel: async () => {
      await options.getModels();
      return options.fromModelsDevModel();
    },
  };
}
