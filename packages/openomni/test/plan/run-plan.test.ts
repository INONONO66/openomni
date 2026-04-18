import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Message, Run, Sink, Tool } from "@openomni/protocol";

// --- Mock setup (must be before dynamic import) ---

type MockLlmFn = (input: any, sink: Sink) => Promise<Run.Outcome>;

let mockRunFn: MockLlmFn = async () => ({ type: "stop" });

const mockModelsGet = mock(async () => ({
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

const mockProviderFromModelsDevModel = mock(() => ({
  id: "claude-3-haiku-20240307",
  providerID: "anthropic",
}));

mock.module("@openomni/llm", () => ({
  ModelsDev: { get: mockModelsGet },
  Provider: { fromModelsDevModel: mockProviderFromModelsDevModel },
  ProviderTransform: { resolveVariant: () => ({}) },
  run: (input: any, sink: Sink) => mockRunFn(input, sink),
  TokenTracker: {
    extractUsage: () => ({ inputTokens: 0, outputTokens: 0 }),
  },
}));

// --- Dynamic import after mock ---

let runPlan: typeof import("../../src/plan/run-plan").runPlan;

beforeAll(async () => {
  ({ runPlan } = await import("../../src/plan/run-plan"));
});

afterAll(() => {
  mock.restore();
});

// --- Helpers ---

function createToolCallMessage(toolName: string, args: Record<string, unknown>): Message.WithParts {
  const id = crypto.randomUUID();
  const sessionID = "run-plan-test";
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
      input: 10,
      output: 5,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };

  const toolCallPart: Message.ToolCallPart = {
    id: crypto.randomUUID(),
    sessionID,
    messageID: id,
    type: "tool-call",
    toolCallId: crypto.randomUUID(),
    tool: toolName,
    args,
  };

  return { info, parts: [toolCallPart] };
}

// --- Tests ---

describe("runPlan", () => {
  it("returns planId when agent calls plan_write tool", async () => {
    const planContent = {
      title: "Test Plan",
      steps: [
        {
          stepId: "step-1",
          title: "Step 1",
          description: "First step",
          dependsOn: [],
        },
      ],
    };

    mockRunFn = async (input: any, sink: Sink) => {
      const toolCall: Tool.Call = {
        id: crypto.randomUUID(),
        tool: "plan_write",
        args: { content: JSON.stringify(planContent) },
      };
      sink.onToolCall?.(toolCall);

      const result: Tool.Result = {
        id: crypto.randomUUID(),
        toolCallId: toolCall.id,
        output: "Plan written",
        isError: false,
      };
      sink.onToolResult?.(result);

      return { type: "stop" };
    };

    const result = await runPlan("Generate a test plan", {
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    });

    expect(result).toHaveProperty("planId");
    expect(typeof result.planId).toBe("string");
    expect(result.planId.length).toBeGreaterThan(0);
  });

  it("throws error when agent does not call plan_write", async () => {
    mockRunFn = async () => ({ type: "stop" });

    const promise = runPlan("Generate a test plan", {
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    });

    await expect(promise).rejects.toThrow();
  });

  it("returns deterministic planId when passed in config", async () => {
    const planContent = {
      title: "Test Plan",
      steps: [
        {
          stepId: "step-1",
          title: "Step 1",
          description: "First step",
          dependsOn: [],
        },
      ],
    };

    mockRunFn = async (input: any, sink: Sink) => {
      const toolCall: Tool.Call = {
        id: crypto.randomUUID(),
        tool: "plan_write",
        args: { content: JSON.stringify(planContent) },
      };
      sink.onToolCall?.(toolCall);

      const result: Tool.Result = {
        id: crypto.randomUUID(),
        toolCallId: toolCall.id,
        output: "Plan written",
        isError: false,
      };
      sink.onToolResult?.(result);

      return { type: "stop" };
    };

    const expectedPlanId = "test-plan-123";
    const result = await runPlan("Generate a test plan", {
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      planId: expectedPlanId,
    });

    expect(result.planId).toBe(expectedPlanId);
  });
});
