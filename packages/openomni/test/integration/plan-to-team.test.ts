import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { ChatAgent, type AgentResult, type ChatAgentInput } from "@openomni/agent";

let PlanAgent: typeof import("../../src/plan/plan-agent").PlanAgent;
let TeamOrchestrator: typeof import("../../src/team/team-orchestrator").TeamOrchestrator;
type OrchestratorConfig =
  import("../../src/team/team-orchestrator").TeamOrchestrator.OrchestratorConfig;

const originalCreate = ChatAgent.create;
const createSpy = spyOn(ChatAgent, "create");

beforeEach(async () => {
  if (!PlanAgent || !TeamOrchestrator) {
    const planModulePath = `${new URL("../../src/plan/plan-agent.ts", import.meta.url).pathname}?plan-to-team-isolated`;
    const teamModulePath = `${new URL("../../src/team/team-orchestrator.ts", import.meta.url).pathname}?plan-to-team-isolated`;
    ({ PlanAgent } = (await import(planModulePath)) as typeof import("../../src/plan/plan-agent"));
    ({ TeamOrchestrator } = (await import(
      teamModulePath
    )) as typeof import("../../src/team/team-orchestrator"));
  }
});

const responses: string[] = [];
const runInputs: ChatAgentInput[] = [];
let matcher: (input: ChatAgentInput) => boolean = () => false;

function makeAgentResult(text: string): AgentResult {
  return {
    text,
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    finishReason: "stop",
  };
}

beforeEach(() => {
  responses.length = 0;
  runInputs.length = 0;
  matcher = () => false;

  createSpy.mockImplementation((config) => {
    const realAgent = originalCreate(config);
    return {
      ...realAgent,
      run: async (input: ChatAgentInput) => {
        if (!matcher(input)) {
          return realAgent.run(input);
        }

        runInputs.push(input);
        const next = responses.shift();
        if (next === undefined) {
          throw new Error("No mocked response queued for matched ChatAgent.run call");
        }
        return makeAgentResult(next);
      },
    };
  });
});

afterAll(() => {
  createSpy.mockRestore();
});

function enqueuePlan(goal: string, steps: Array<{ stepId: string; dependsOn: string[] }>) {
  responses.push(
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

function makeConfig(): OrchestratorConfig {
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

function extractUserText(input: ChatAgentInput): string {
  return input.messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n");
}

describe("PlanAgent.generate -> TeamOrchestrator.execute integration", () => {
  it("completes two-step dependent plan end-to-end", async () => {
    const goal = "Build and validate release package";
    matcher = (input) => {
      const text = extractUserText(input);
      return (
        text.includes(goal) ||
        text.includes("Task: Do s1") ||
        text.includes("Task: Do s2") ||
        text.includes("Step: Do s1") ||
        text.includes("Step: Do s2")
      );
    };

    enqueuePlan(goal, [
      { stepId: "s1", dependsOn: [] },
      { stepId: "s2", dependsOn: ["s1"] },
    ]);
    responses.push("Step 1 completed");
    responses.push(JSON.stringify({ decision: "accept" }));
    responses.push("Step 2 completed");
    responses.push(JSON.stringify({ decision: "accept" }));

    const planResult = await PlanAgent.generate(goal, {
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    });
    const result = await TeamOrchestrator.execute(planResult.plan, makeConfig());

    expect(result.status).toBe("completed");
    expect(result.completedSteps).toEqual(["s1", "s2"]);
    expect(result.failedSteps).toEqual([]);
    expect(result.skippedSteps).toEqual([]);
  });

  it("completes one-step plan end-to-end", async () => {
    const goal = "Run one verification";
    matcher = (input) => {
      const text = extractUserText(input);
      return text.includes(goal) || text.includes("Task: Do s1") || text.includes("Step: Do s1");
    };

    enqueuePlan(goal, [{ stepId: "s1", dependsOn: [] }]);
    responses.push("Single step completed");
    responses.push(JSON.stringify({ decision: "accept" }));

    const planResult = await PlanAgent.generate(goal, {
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    });
    const result = await TeamOrchestrator.execute(planResult.plan, makeConfig());

    expect(result.status).toBe("completed");
    expect(result.completedSteps).toEqual(["s1"]);
    expect(result.failedSteps).toEqual([]);
    expect(result.skippedSteps).toEqual([]);
  });

  it("retries once after rejection and then succeeds", async () => {
    const goal = "Retry rejected step";
    matcher = (input) => {
      const text = extractUserText(input);
      return text.includes(goal) || text.includes("Task: Do s1") || text.includes("Step: Do s1");
    };

    enqueuePlan(goal, [{ stepId: "s1", dependsOn: [] }]);
    responses.push("Step output attempt 1");
    responses.push(JSON.stringify({ decision: "reject", feedback: "Need fixes" }));
    responses.push("Step output attempt 2");
    responses.push(JSON.stringify({ decision: "accept" }));

    const planResult = await PlanAgent.generate(goal, {
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    });
    const result = await TeamOrchestrator.execute(planResult.plan, makeConfig());

    const executionCalls = runInputs
      .map((input) => extractUserText(input))
      .filter((text) => text.includes("Execute the following task:"));

    expect(result.status).toBe("completed");
    expect(result.completedSteps).toEqual(["s1"]);
    expect(executionCalls).toHaveLength(2);
  });

  it("throws when plan output is invalid JSON", async () => {
    const goal = "Generate broken plan";
    matcher = (input) => extractUserText(input).includes(goal);
    responses.push("{ invalid json");

    return expect(
      PlanAgent.generate(goal, {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      }),
    ).rejects.toThrow(/Failed to parse plan/);
  });
});
