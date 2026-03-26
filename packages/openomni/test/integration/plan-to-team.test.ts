import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import * as SessionModule from "@openomni/session";
import type { Message, Run, Sink } from "@openomni/protocol";

const responseQueue: string[] = [];
const llmInputs: unknown[] = [];

type MockLlmFn = (input: unknown, sink: Sink) => Promise<Run.Outcome>;

let mockRunFn: MockLlmFn = async (_input: unknown, sink: Sink) => {
  const text = responseQueue.shift() ?? "{}";
  sink.onMessage(createAssistantMessage(text));
  return { type: "stop" } as Run.Outcome;
};

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

const mockBusPublish = mock(() => {});

mock.module("@openomni/llm", () => ({
  ModelsDev: { get: mockModelsGet },
  Provider: { fromModelsDevModel: mockProviderFromModelsDevModel },
  run: (input: unknown, sink: Sink) => {
    llmInputs.push(input);
    return mockRunFn(input, sink);
  },
  TokenTracker: {
    extractUsage: () => ({ inputTokens: 0, outputTokens: 0 }),
    calculateCost: () => ({ inputCost: 0, outputCost: 0, totalCost: 0 }),
  },
}));

mock.module("@openomni/session", () => ({
  ...SessionModule,
  Bus: { ...SessionModule.Bus, publish: mockBusPublish },
}));

let PlanAgent: typeof import("../../src/plan/plan-agent").PlanAgent;
let TeamOrchestrator: typeof import("../../src/team/team-orchestrator").TeamOrchestrator;

beforeAll(async () => {
  ({ PlanAgent } = await import("../../src/plan/plan-agent"));
  ({ TeamOrchestrator } = await import("../../src/team/team-orchestrator"));
});

beforeEach(() => {
  responseQueue.length = 0;
  llmInputs.length = 0;
  mockBusPublish.mockClear();
  mockModelsGet.mockClear();
  mockProviderFromModelsDevModel.mockClear();
  mockRunFn = async (_input: unknown, sink: Sink) => {
    const text = responseQueue.shift() ?? "{}";
    sink.onMessage(createAssistantMessage(text));
    return { type: "stop" } as Run.Outcome;
  };
});

function createAssistantMessage(text: string): Message.WithParts {
  const id = crypto.randomUUID();
  const sessionID = "integration-test";
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

function enqueuePlan(
  goal: string,
  steps: Array<{ stepId: string; dependsOn: string[] }>,
) {
  responseQueue.push(
    JSON.stringify({
      planId: "plan-integration",
      goal,
      steps: steps.map((step) => ({
        stepId: step.stepId,
        description: `Do ${step.stepId}`,
        expectedOutput: `Output ${step.stepId}`,
        dependsOn: step.dependsOn,
      })),
      createdAt: new Date().toISOString(),
      version: 1,
    }),
  );
}

function makeConfig(): import("../../src/team/team-orchestrator").TeamOrchestrator.OrchestratorConfig {
  return {
    reviewModel: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    teammates: new Map(),
    defaultTeammateConfig: {
      agentId: "default-agent",
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    },
    maxAttemptsPerStep: 3,
  };
}

function extractUserText(input: unknown): string {
  if (!input || typeof input !== "object") {
    return "";
  }

  const candidate = input as {
    messages?: Array<{ parts?: Array<{ type?: string; text?: string }> }>;
  };

  const messages = candidate.messages ?? [];
  return messages
    .flatMap((message) => message.parts ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

describe("PlanAgent.generate -> TeamOrchestrator.execute integration", () => {
  it("completes two-step dependent plan end-to-end", async () => {
    const goal = "Build and validate release package";

    enqueuePlan(goal, [
      { stepId: "s1", dependsOn: [] },
      { stepId: "s2", dependsOn: ["s1"] },
    ]);
    responseQueue.push("Step 1 completed");
    responseQueue.push(JSON.stringify({ decision: "accept" }));
    responseQueue.push("Step 2 completed");
    responseQueue.push(JSON.stringify({ decision: "accept" }));

    const planResult = await PlanAgent.generate(goal, {
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    });
    const result = await TeamOrchestrator.execute(
      planResult.plan,
      makeConfig(),
    );

    expect(result.status).toBe("completed");
    expect(result.completedSteps).toEqual(["s1", "s2"]);
    expect(result.failedSteps).toEqual([]);
    expect(result.skippedSteps).toEqual([]);
  });

  it("completes one-step plan end-to-end", async () => {
    const goal = "Run one verification";

    enqueuePlan(goal, [{ stepId: "s1", dependsOn: [] }]);
    responseQueue.push("Single step completed");
    responseQueue.push(JSON.stringify({ decision: "accept" }));

    const planResult = await PlanAgent.generate(goal, {
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    });
    const result = await TeamOrchestrator.execute(
      planResult.plan,
      makeConfig(),
    );

    expect(result.status).toBe("completed");
    expect(result.completedSteps).toEqual(["s1"]);
    expect(result.failedSteps).toEqual([]);
    expect(result.skippedSteps).toEqual([]);
  });

  it("retries once after rejection and then succeeds", async () => {
    const goal = "Retry rejected step";

    enqueuePlan(goal, [{ stepId: "s1", dependsOn: [] }]);
    responseQueue.push("Step output attempt 1");
    responseQueue.push(
      JSON.stringify({ decision: "reject", feedback: "Need fixes" }),
    );
    responseQueue.push("Step output attempt 2");
    responseQueue.push(JSON.stringify({ decision: "accept" }));

    const planResult = await PlanAgent.generate(goal, {
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    });
    const result = await TeamOrchestrator.execute(
      planResult.plan,
      makeConfig(),
    );

    const executionCalls = llmInputs
      .map((input) => extractUserText(input))
      .filter((text) => text.includes("Execute the following task:"));

    expect(result.status).toBe("completed");
    expect(result.completedSteps).toEqual(["s1"]);
    expect(executionCalls).toHaveLength(2);
  });

  it("throws when plan output is invalid JSON", async () => {
    responseQueue.push("{ invalid json");

    return expect(
      PlanAgent.generate("Generate broken plan", {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      }),
    ).rejects.toThrow(/Failed to parse plan/);
  });
});
