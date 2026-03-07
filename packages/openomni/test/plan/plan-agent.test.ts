import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

type MockAgentResult = {
  text: string;
  steps: [];
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  finishReason: "stop";
};

const mockRun = mock(
  async (): Promise<MockAgentResult> => ({
    text: "{}",
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    finishReason: "stop",
  }),
);

const mockCreate = mock(() => ({
  run: mockRun,
  stream: async function* () {
    return;
  },
}));

mock.module("@openomni/agent", () => ({
  ChatAgent: {
    create: mockCreate,
  },
}));

let PlanAgent: typeof import("../../src/plan/plan-agent").PlanAgent;

beforeAll(async () => {
  ({ PlanAgent } = await import("../../src/plan/plan-agent"));
});

beforeEach(() => {
  mockRun.mockClear();
  mockCreate.mockClear();
});

describe("PlanAgent.generate", () => {
  it("returns PlanResult when LLM returns valid plan JSON", async () => {
    const goal = "Build API gateway";
    const now = new Date().toISOString();
    mockRun.mockResolvedValueOnce({
      text: JSON.stringify({
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
      steps: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    });

    const result = await PlanAgent.generate(goal, {
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    });

    expect(result.plan.planId).toBe("plan-1");
    expect(result.plan.goal).toBe(goal);
    expect(result.plan.steps).toHaveLength(1);
    expect(result.plan.createdAt).toBeInstanceOf(Date);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it("throws when LLM output is not valid JSON", async () => {
    mockRun.mockResolvedValueOnce({
      text: "not-json",
      steps: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    });

    return expect(
      PlanAgent.generate("Write docs", {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      }),
    ).rejects.toThrow(/Failed to parse plan/);
  });

  it("throws when JSON fails Plan schema validation", async () => {
    mockRun.mockResolvedValueOnce({
      text: JSON.stringify({
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
      steps: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    });

    return expect(
      PlanAgent.generate("Ship feature", {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      }),
    ).rejects.toThrow();
  });

  it("ensures generated plan goal matches input goal", async () => {
    const goal = "Migrate billing service";
    mockRun.mockResolvedValueOnce({
      text: JSON.stringify({
        planId: "plan-3",
        goal,
        steps: [],
        createdAt: new Date().toISOString(),
        version: 1,
      }),
      steps: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    });

    const result = await PlanAgent.generate(goal, {
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    });

    expect(result.plan.goal).toBe(goal);
  });

  it("parses steps with dependsOn links", async () => {
    mockRun.mockResolvedValueOnce({
      text: JSON.stringify({
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
      steps: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    });

    const result = await PlanAgent.generate("Deploy app", {
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    });

    expect(result.plan.steps[1]?.dependsOn).toEqual(["s1"]);
  });

  it("accepts empty steps array as a valid plan", async () => {
    mockRun.mockResolvedValueOnce({
      text: JSON.stringify({
        planId: "plan-empty",
        goal: "Simple goal",
        steps: [],
        createdAt: new Date().toISOString(),
        version: 1,
      }),
      steps: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    });

    const result = await PlanAgent.generate("Simple goal", {
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    });

    expect(result.plan.steps).toEqual([]);
  });
});
