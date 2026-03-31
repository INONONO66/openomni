import type { Run, Sink } from "@openomni/protocol";

export type MockLlmFn = (input: unknown, sink: Sink) => Promise<Run.Outcome>;

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
    models: {
      "claude-3-haiku-20240307": {
        id: "claude-3-haiku-20240307",
        name: "Claude 3 Haiku",
      },
    },
  },
};

export const mockProviderModel = {
  id: "claude-3-haiku-20240307",
  providerID: "anthropic",
};
