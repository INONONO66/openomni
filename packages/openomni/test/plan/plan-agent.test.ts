import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Message, Run, Sink } from "@openomni/protocol";

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
  run: (input: any, sink: Sink) => mockRunFn(input, sink),
  TokenTracker: {
    extractUsage: () => ({ inputTokens: 0, outputTokens: 0 }),
    calculateCost: () => ({ inputCost: 0, outputCost: 0, totalCost: 0 }),
  },
}));

// --- Dynamic import after mock ---

let PlanAgent: typeof import("../../src/plan/plan-agent").PlanAgent;

beforeAll(async () => {
  ({ PlanAgent } = await import("../../src/plan/plan-agent"));
});

// --- Helpers ---

function createAssistantMessage(text: string): Message.WithParts {
  const id = crypto.randomUUID();
  const sessionID = "plan-test";
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
  const textPart: Message.TextPart = {
    id: crypto.randomUUID(),
    sessionID,
    messageID: id,
    type: "text",
    text,
  };
  return { info, parts: [textPart] };
}

function setupMockResponse(text: string) {
  mockRunFn = async (_input: any, sink: Sink) => {
    sink.onMessage(createAssistantMessage(text));
    return { type: "stop" } as Run.Outcome;
  };
}

beforeEach(() => {
  mockRunFn = async () => ({ type: "stop" }) as Run.Outcome;
  mockModelsGet.mockClear();
  mockProviderFromModelsDevModel.mockClear();
});

describe("PlanAgent.generate", () => {
  it("returns PlanResult when LLM returns valid plan JSON", async () => {
    const goal = "Build API gateway";
    const now = new Date().toISOString();
    setupMockResponse(
      JSON.stringify({
        planId: "plan-1",
        goal,
        steps: [
          {
            stepId: "s1",
            description: "Design routes",
            expectedOutput: "Route map",
            dependsOn: [],
          },
        ],
        createdAt: now,
        version: 1,
      }),
    );

    const result = await PlanAgent.generate(goal, {
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    });

    expect(result.plan.planId).toBe("plan-1");
    expect(result.plan.goal).toBe(goal);
    expect(result.plan.steps).toHaveLength(1);
    expect(result.plan.createdAt).toBeInstanceOf(Date);
  });

  it("throws when LLM output is not valid JSON", async () => {
    setupMockResponse("not-json");

    return expect(
      PlanAgent.generate("Write docs", {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      }),
    ).rejects.toThrow(/Failed to parse plan/);
  });

  it("throws when JSON fails Plan schema validation", async () => {
    setupMockResponse(
      JSON.stringify({
        planId: "plan-2",
        goal: "Ship feature",
        steps: [
          {
            stepId: "s1",
            expectedOutput: "Done",
            dependsOn: [],
          },
        ],
        createdAt: new Date().toISOString(),
        version: 1,
      }),
    );

    return expect(
      PlanAgent.generate("Ship feature", {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      }),
    ).rejects.toThrow();
  });

  it("ensures generated plan goal matches input goal", async () => {
    const goal = "Migrate billing service";
    setupMockResponse(
      JSON.stringify({
        planId: "plan-3",
        goal,
        steps: [],
        createdAt: new Date().toISOString(),
        version: 1,
      }),
    );

    const result = await PlanAgent.generate(goal, {
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    });

    expect(result.plan.goal).toBe(goal);
  });

  it("parses steps with dependsOn links", async () => {
    setupMockResponse(
      JSON.stringify({
        planId: "plan-4",
        goal: "Deploy app",
        steps: [
          {
            stepId: "s1",
            description: "Build",
            expectedOutput: "Artifact",
            dependsOn: [],
          },
          {
            stepId: "s2",
            description: "Deploy",
            expectedOutput: "Running service",
            dependsOn: ["s1"],
          },
        ],
        createdAt: new Date().toISOString(),
        version: 1,
      }),
    );

    const result = await PlanAgent.generate("Deploy app", {
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    });

    expect(result.plan.steps[1]?.dependsOn).toEqual(["s1"]);
  });

  it("accepts empty steps array as a valid plan", async () => {
    setupMockResponse(
      JSON.stringify({
        planId: "plan-empty",
        goal: "Simple goal",
        steps: [],
        createdAt: new Date().toISOString(),
        version: 1,
      }),
    );

    const result = await PlanAgent.generate("Simple goal", {
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    });

    expect(result.plan.steps).toEqual([]);
  });
});
