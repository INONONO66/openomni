import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { ChatAgent, type AgentResult } from "@openomni/agent";
import type { Plan, PlanStep } from "@openomni/protocol";
import type { Teammate } from "../../src/team/teammate";
import { ReviewLoop } from "../../src/team/review-loop";
import { TeamOrchestrator } from "../../src/team/team-orchestrator";

const responseQueue: string[] = [];
const executedTasks: string[] = [];

const createSpy = spyOn(ChatAgent, "create").mockImplementation(
  () =>
    ({
      run: async (input: { messages: Array<{ role: string; content: string }> }) => {
        const userPrompt = input.messages[0]?.content ?? "";
        if (userPrompt.includes("Execute the following task:")) {
          const matchedTask = userPrompt.match(/Task:\s*(.+)/);
          if (matchedTask?.[1]) {
            executedTasks.push(matchedTask[1].trim());
          }
        }

        const text = responseQueue.shift() ?? "{}";
        return {
          text,
          steps: [],
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
          },
          finishReason: "stop",
        } as AgentResult;
      },
    }) as unknown as ReturnType<typeof ChatAgent.create>,
);

afterAll(() => {
  createSpy.mockRestore();
});

beforeEach(() => {
  responseQueue.length = 0;
  executedTasks.length = 0;
});

function makeStep(stepId: string, dependsOn: string[] = [], suggestedAgent?: string): PlanStep {
  return {
    stepId,
    description: `${stepId} task`,
    expectedOutput: `${stepId} output`,
    dependsOn,
    suggestedAgent,
  };
}

function makePlan(steps: PlanStep[]): Plan {
  return {
    planId: "plan-1",
    goal: "execute plan",
    steps,
    createdAt: new Date(),
    version: 1,
  };
}

const defaultTeammateConfig: Teammate.TeammateConfig = {
  agentId: "default-agent",
  model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
};

function makeConfig(overrides?: {
  teammates?: Map<string, Teammate.TeammateConfig>;
  maxAttemptsPerStep?: number;
  subagentRuntime?: Teammate.SubagentRuntime;
  maxSessionRejections?: number;
  maxTotalAttempts?: number;
  stallConfig?: {
    maxConsecutiveRejections: number;
    maxNoProgressTurns: number;
  };
}) {
  return {
    reviewModel: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    teammates: overrides?.teammates ?? new Map<string, Teammate.TeammateConfig>(),
    defaultTeammateConfig,
    subagentRuntime: overrides?.subagentRuntime,
    maxAttemptsPerStep: overrides?.maxAttemptsPerStep,
    maxSessionRejections: overrides?.maxSessionRejections,
    maxTotalAttempts: overrides?.maxTotalAttempts,
    stallConfig: overrides?.stallConfig,
  };
}

function makeRuntime(outputs: string[]) {
  const spawnCalls: Array<{ prompt: string; sessionId: string }> = [];
  const sendCalls: Array<{ prompt: string; sessionId: string }> = [];
  let nextSession = 1;
  let nextRun = 1;

  const runtime: Teammate.SubagentRuntime = {
    async spawn(config) {
      const sessionId = `worker-session-${nextSession++}`;
      spawnCalls.push({ prompt: config.prompt, sessionId });
      return {
        sessionId,
        runId: `worker-run-${nextRun++}`,
        output: outputs.shift() ?? "runtime-output",
        finishReason: "stop",
      };
    },
    async send(config) {
      sendCalls.push({ prompt: config.prompt, sessionId: config.sessionId });
      return {
        sessionId: config.sessionId,
        runId: `worker-run-${nextRun++}`,
        output: outputs.shift() ?? "runtime-output",
        finishReason: "stop",
      };
    },
  };

  return { runtime, spawnCalls, sendCalls };
}

describe("TeamOrchestrator.execute", () => {
  it("completes a single accepted step", async () => {
    responseQueue.push("single-step output");
    responseQueue.push(JSON.stringify({ decision: "accept" }));

    const plan = makePlan([makeStep("s1")]);
    const result = await TeamOrchestrator.execute(plan, makeConfig());

    expect(result.status).toBe("completed");
    expect(result.completedSteps).toEqual(["s1"]);
    expect(result.failedSteps).toEqual([]);
    expect(result.skippedSteps).toEqual([]);
    expect(result.results.get("s1")).toBe("single-step output");
  });

  it("runs dependent steps in order", async () => {
    responseQueue.push("s1 output");
    responseQueue.push(JSON.stringify({ decision: "accept" }));
    responseQueue.push("s2 output");
    responseQueue.push(JSON.stringify({ decision: "accept" }));

    const plan = makePlan([makeStep("s1"), makeStep("s2", ["s1"])]);
    const result = await TeamOrchestrator.execute(plan, makeConfig());

    expect(result.status).toBe("completed");
    expect(result.completedSteps).toEqual(["s1", "s2"]);
    expect(executedTasks).toEqual(["s1 task", "s2 task"]);
  });

  it("retries once after rejection and then succeeds", async () => {
    responseQueue.push("first attempt output");
    responseQueue.push(JSON.stringify({ decision: "reject", feedback: "needs improvement" }));
    responseQueue.push("second attempt output");
    responseQueue.push(JSON.stringify({ decision: "accept" }));

    const plan = makePlan([makeStep("s1")]);
    const result = await TeamOrchestrator.execute(plan, makeConfig({ maxAttemptsPerStep: 3 }));

    expect(result.status).toBe("completed");
    expect(result.completedSteps).toEqual(["s1"]);
    expect(result.results.get("s1")).toBe("second attempt output");
    expect(executedTasks.filter((task) => task === "s1 task")).toHaveLength(2);
  });

  it("fails when max attempts are exhausted", async () => {
    responseQueue.push("attempt 1 output");
    responseQueue.push(JSON.stringify({ decision: "reject", feedback: "bad" }));
    responseQueue.push("attempt 2 output");
    responseQueue.push(JSON.stringify({ decision: "reject", feedback: "still bad" }));

    const plan = makePlan([makeStep("s1")]);
    const result = await TeamOrchestrator.execute(plan, makeConfig({ maxAttemptsPerStep: 2 }));

    expect(result.status).toBe("failed");
    expect(result.failedSteps).toEqual(["s1"]);
    expect(result.completedSteps).toEqual([]);
  });

  it("retries rejected worker steps in the same session before handoff", async () => {
    const { runtime, spawnCalls, sendCalls } = makeRuntime(["attempt 1", "attempt 2"]);
    responseQueue.push(JSON.stringify({ decision: "reject", feedback: "tighten it" }));
    responseQueue.push(JSON.stringify({ decision: "accept" }));

    const plan = makePlan([makeStep("s1")]);
    const result = await TeamOrchestrator.execute(
      plan,
      makeConfig({
        subagentRuntime: runtime,
        maxSessionRejections: 3,
        maxTotalAttempts: 6,
      }),
    );

    expect(result.status).toBe("completed");
    expect(spawnCalls).toHaveLength(1);
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.sessionId).toBe(spawnCalls[0]?.sessionId);
    expect(sendCalls[0]?.prompt).toContain("Handoff from previous attempt:");
    expect(sendCalls[0]?.prompt).toContain("tighten it");
  });

  it("rotates to a new worker session after the rejection threshold", async () => {
    const { runtime, spawnCalls, sendCalls } = makeRuntime(["attempt 1", "attempt 2", "attempt 3"]);
    const handoffSpy = spyOn(ReviewLoop, "generateHandoff").mockResolvedValue("handoff doc");

    try {
      responseQueue.push(JSON.stringify({ decision: "reject", feedback: "first reject" }));
      responseQueue.push(JSON.stringify({ decision: "reject", feedback: "rotate now" }));
      responseQueue.push(JSON.stringify({ decision: "accept" }));

      const plan = makePlan([makeStep("s1")]);
      const result = await TeamOrchestrator.execute(
        plan,
        makeConfig({
          subagentRuntime: runtime,
          maxSessionRejections: 2,
          maxTotalAttempts: 6,
        }),
      );

      expect(result.status).toBe("completed");
      expect(spawnCalls).toHaveLength(2);
      expect(sendCalls).toHaveLength(1);
      expect(sendCalls[0]?.sessionId).toBe(spawnCalls[0]?.sessionId);
      expect(spawnCalls[1]?.sessionId).not.toBe(spawnCalls[0]?.sessionId);
      expect(spawnCalls[1]?.prompt).toContain("handoff doc");
    } finally {
      handoffSpy.mockRestore();
    }
  });

  it("fails worker execution when total attempt budget is exhausted", async () => {
    const { runtime, spawnCalls, sendCalls } = makeRuntime(["attempt 1", "attempt 2"]);
    responseQueue.push(JSON.stringify({ decision: "reject", feedback: "bad" }));
    responseQueue.push(JSON.stringify({ decision: "reject", feedback: "still bad" }));

    const plan = makePlan([makeStep("s1")]);
    const result = await TeamOrchestrator.execute(
      plan,
      makeConfig({
        subagentRuntime: runtime,
        maxSessionRejections: 5,
        maxTotalAttempts: 2,
      }),
    );

    expect(result.status).toBe("failed");
    expect(result.failedSteps).toEqual(["s1"]);
    expect(spawnCalls).toHaveLength(1);
    expect(sendCalls).toHaveLength(1);
  });

  it("falls back to synthesized handoff text when handoff generation fails", async () => {
    const { runtime, spawnCalls } = makeRuntime(["attempt 1", "attempt 2", "attempt 3"]);
    const handoffSpy = spyOn(ReviewLoop, "generateHandoff").mockRejectedValue(
      new Error("handoff unavailable"),
    );

    try {
      responseQueue.push(JSON.stringify({ decision: "reject", feedback: "first reject" }));
      responseQueue.push(JSON.stringify({ decision: "reject", feedback: "need a new approach" }));
      responseQueue.push(JSON.stringify({ decision: "accept" }));

      const plan = makePlan([makeStep("s1")]);
      const result = await TeamOrchestrator.execute(
        plan,
        makeConfig({
          subagentRuntime: runtime,
          maxSessionRejections: 2,
          maxTotalAttempts: 6,
        }),
      );

      expect(result.status).toBe("completed");
      expect(spawnCalls).toHaveLength(2);
      expect(spawnCalls[1]?.prompt).toContain("Rejection Feedback:");
      expect(spawnCalls[1]?.prompt).toContain("need a new approach");
      expect(spawnCalls[1]?.prompt).toContain("Last Result:");
      expect(spawnCalls[1]?.prompt).toContain("attempt 2");
    } finally {
      handoffSpy.mockRestore();
    }
  });

  it("skips dependents when a prerequisite step fails", async () => {
    responseQueue.push("attempt output");
    responseQueue.push(JSON.stringify({ decision: "reject", feedback: "fatal" }));

    const plan = makePlan([makeStep("s1"), makeStep("s2", ["s1"])]);
    const result = await TeamOrchestrator.execute(plan, makeConfig({ maxAttemptsPerStep: 1 }));

    expect(result.status).toBe("failed");
    expect(result.failedSteps).toEqual(["s1"]);
    expect(result.skippedSteps).toEqual(["s2"]);
  });

  it("returns stalled when consecutive rejection threshold is hit", async () => {
    responseQueue.push("attempt 1 output");
    responseQueue.push(JSON.stringify({ decision: "reject", feedback: "nope" }));
    responseQueue.push("attempt 2 output");
    responseQueue.push(JSON.stringify({ decision: "reject", feedback: "still nope" }));

    const plan = makePlan([makeStep("s1")]);
    const result = await TeamOrchestrator.execute(
      plan,
      makeConfig({
        maxAttemptsPerStep: 10,
        stallConfig: {
          maxConsecutiveRejections: 2,
          maxNoProgressTurns: 100,
        },
      }),
    );

    expect(result.status).toBe("stalled");
    expect(result.stallReason).toBe("consecutive_rejections");
  });

  it("throws on cyclic DAG", async () => {
    const plan = makePlan([makeStep("s1", ["s2"]), makeStep("s2", ["s1"])]);

    return expect(TeamOrchestrator.execute(plan, makeConfig())).rejects.toThrow(/cycle/i);
  });

  it("completes an empty plan", async () => {
    const plan = makePlan([]);
    const result = await TeamOrchestrator.execute(plan, makeConfig());

    expect(result.status).toBe("completed");
    expect(result.completedSteps).toEqual([]);
    expect(result.failedSteps).toEqual([]);
    expect(result.skippedSteps).toEqual([]);
    expect(result.results.size).toBe(0);
  });

  it("enriches system prompt when suggestedAgent matches a builtin category", async () => {
    responseQueue.push("deep-output");
    responseQueue.push(JSON.stringify({ decision: "accept" }));

    const plan = makePlan([makeStep("s1", [], "deep")]);
    const result = await TeamOrchestrator.execute(plan, makeConfig());

    expect(result.status).toBe("completed");
    expect(result.completedSteps).toEqual(["s1"]);

    const agentConfig = createSpy.mock.calls.find((call) => {
      const config = call[0] as { systemPrompt?: string };
      return config.systemPrompt?.includes("broad codebase exploration");
    });
    expect(agentConfig).toBeDefined();
  });

  it("does not enrich prompt when suggestedAgent is not a known category", async () => {
    const callsBefore = createSpy.mock.calls.length;

    responseQueue.push("custom-output");
    responseQueue.push(JSON.stringify({ decision: "accept" }));

    const plan = makePlan([makeStep("s1", [], "unknown-agent")]);
    const result = await TeamOrchestrator.execute(plan, makeConfig());

    expect(result.status).toBe("completed");

    const newCalls = createSpy.mock.calls.slice(callsBefore);
    const enrichedCall = newCalls.find((call) => {
      const config = call[0] as { systemPrompt?: string };
      return config.systemPrompt?.includes("Recommended tools:");
    });
    expect(enrichedCall).toBeUndefined();
  });
});
