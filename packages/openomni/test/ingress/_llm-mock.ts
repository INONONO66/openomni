import { mock } from "bun:test";
import type { Message, Run, Sink } from "@openomni/protocol";

type MockLlmFn = (input: unknown, sink: Sink) => Promise<Run.Outcome>;

export const testState: {
  responseQueue: string[];
  llmInputs: unknown[];
  runFn: MockLlmFn | null;
} = {
  responseQueue: [],
  llmInputs: [],
  runFn: null,
};

export function resetTestState(): void {
  testState.responseQueue.length = 0;
  testState.llmInputs.length = 0;
  testState.runFn = null;
}

export function createAssistantMessage(text: string, sessionID: string): Message.WithParts {
  const id = crypto.randomUUID();
  const now = Date.now();

  const info: Message.AssistantMessage = {
    id,
    sessionID,
    role: "assistant",
    time: { created: now },
    parentID: "",
    modelID: "claude-3-haiku-20240307",
    providerID: "anthropic",
    agent: "chat-agent",
    path: { cwd: "", root: "" },
    cost: 0,
    tokens: {
      input: 1,
      output: 1,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };

  const textPart: Message.TextPart = {
    id: crypto.randomUUID(),
    sessionID,
    messageID: id,
    type: "text",
    text,
  };

  return { info, parts: [textPart] };
}

export function defaultRunFn(sessionID: string): MockLlmFn {
  return async (_input: unknown, sink: Sink) => {
    const text = testState.responseQueue.shift() ?? "{}";
    sink.onMessage(createAssistantMessage(text, sessionID));
    return { type: "stop" } as Run.Outcome;
  };
}

export const mockModelsGet = mock(async () => ({
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
}));

export const mockProviderFromModelsDevModel = mock(() => ({
  id: "claude-3-haiku-20240307",
  providerID: "anthropic",
}));

mock.module("@openomni/llm", () => ({
  ModelsDev: { get: mockModelsGet },
  Provider: { fromModelsDevModel: mockProviderFromModelsDevModel },
  ProviderTransform: {
    resolveVariant: () => ({}),
    variants: () => ({}),
    temperature: () => undefined,
    topP: () => undefined,
    topK: () => undefined,
    maxOutputTokens: () => undefined,
    sdkKey: () => undefined,
    normalizeMessages: (msgs: unknown[]) => msgs,
  },
  run: (input: unknown, sink: Sink) => {
    testState.llmInputs.push(input);
    if (testState.runFn) {
      return testState.runFn(input, sink);
    }
    return Promise.resolve({ type: "stop" } as Run.Outcome);
  },
  TokenTracker: {
    extractUsage: () => ({ inputTokens: 0, outputTokens: 0 }),
  },
}));
