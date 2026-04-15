import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Gate, Plan } from "@openomni/protocol";

type GenerateFn = Awaited<typeof import("../../src/plan/plan-agent")>["PlanAgent"]["generate"];

const mockGenerate = mock<GenerateFn>(async (_goal, _config) => ({
  plan: createPlan("plan-default"),
}));

let PlanPipeline: typeof import("../../src/plan/plan-pipeline").PlanPipeline;
let originalGenerate: GenerateFn;

beforeAll(async () => {
  const { PlanAgent } = await import("../../src/plan/plan-agent");
  originalGenerate = PlanAgent.generate;
  PlanAgent.generate = mockGenerate;
  ({ PlanPipeline } = await import("../../src/plan/plan-pipeline"));
});

afterAll(async () => {
  if (originalGenerate) {
    const { PlanAgent } = await import("../../src/plan/plan-agent");
    PlanAgent.generate = originalGenerate;
  }
});

beforeEach(() => {
  mockGenerate.mockClear();
});

describe("PlanPipeline.run", () => {
  it("succeeds on first attempt when no gates are configured", async () => {
    mockGenerate.mockResolvedValueOnce({ plan: createPlan("plan-1") });

    const result = await PlanPipeline.run("Create release plan", {
      generator: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
      gates: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.planId).toBe("plan-1");
      expect(result.attempts).toBe(1);
      expect(result.gateResults).toEqual([]);
    }
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it("returns success when all gates pass", async () => {
    const gateA: Gate.Check = {
      name: "gate-a",
      check: () => ({ passed: true, issues: [] }),
    };
    const gateB: Gate.Check = {
      name: "gate-b",
      check: () => ({ passed: true, issues: [] }),
    };

    const result = await PlanPipeline.run("Plan migration", {
      generator: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
      gates: [gateA, gateB],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attempts).toBe(1);
      expect(result.gateResults).toHaveLength(2);
      expect(result.gateResults.map((entry) => entry.gateName)).toEqual(["gate-a", "gate-b"]);
    }
  });

  it("retries after a failed gate and succeeds on second attempt", async () => {
    mockGenerate.mockResolvedValueOnce({ plan: createPlan("plan-1") });
    mockGenerate.mockResolvedValueOnce({ plan: createPlan("plan-2") });

    const contexts: Gate.Context[] = [];
    const retryGate: Gate.Check = {
      name: "retry-gate",
      check: (_plan, context) => {
        contexts.push(context);

        if (context.attempt === 1) {
          return {
            passed: false,
            issues: [
              {
                code: "quality_error",
                severity: "error" as const,
                message: "Needs better decomposition",
              },
            ],
            feedback: "Increase step granularity",
          };
        }

        return { passed: true, issues: [] };
      },
    };

    const result = await PlanPipeline.run("Plan rollout", {
      generator: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
      gates: [retryGate],
      maxRetries: 2,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attempts).toBe(2);
    }
    expect(mockGenerate).toHaveBeenCalledTimes(2);

    const mockCalls = (mockGenerate as any).mock.calls;
    const firstCallGoal = mockCalls[0]?.[0];
    expect(firstCallGoal).toBe("Plan rollout");

    const secondCallGoal = mockCalls[1]?.[0];
    expect(secondCallGoal).toContain("Plan rollout");
    expect(secondCallGoal).toContain("Increase step granularity");

    expect(contexts[0]).toMatchObject({
      attempt: 1,
      previousFeedback: undefined,
    });
    expect(contexts[1]).toMatchObject({
      attempt: 2,
      previousFeedback: "Increase step granularity",
    });
  });

  it("returns failure when max retries are exceeded", async () => {
    mockGenerate.mockResolvedValueOnce({ plan: createPlan("plan-1") });
    mockGenerate.mockResolvedValueOnce({ plan: createPlan("plan-2") });

    const failingGate: Gate.Check = {
      name: "always-fail",
      check: () => ({
        passed: false,
        issues: [
          {
            code: "invalid_plan",
            severity: "error" as const,
            message: "Plan remains invalid",
          },
        ],
        feedback: "Fix dependencies",
      }),
    };

    const result = await PlanPipeline.run("Plan deploy", {
      generator: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
      gates: [failingGate],
      maxRetries: 2,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempts).toBe(2);
      expect(result.reason).toBe("Max retries exceeded");
      expect(result.lastPlan?.planId).toBe("plan-2");
      expect(result.gateResults).toHaveLength(2);
    }
  });

  it("treats warning-only passed gates as success", async () => {
    const warningGate: Gate.Check = {
      name: "warning-gate",
      check: () => ({
        passed: true,
        issues: [
          {
            code: "minor_quality",
            severity: "warning" as const,
            message: "Could be improved",
          },
        ],
      }),
    };

    const result = await PlanPipeline.run("Plan docs", {
      generator: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
      gates: [warningGate],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attempts).toBe(1);
      expect(result.gateResults).toHaveLength(1);
      expect(result.gateResults[0]?.verdict.passed).toBe(true);
    }
  });

  it("short-circuits gate execution on first error-severity issue", async () => {
    const firstGateCheck = mock(() => ({
      passed: false,
      issues: [
        {
          code: "hard_error",
          severity: "error" as const,
          message: "Stop chain",
        },
      ],
      feedback: "Fix hard error",
    }));

    const secondGateCheck = mock(() => ({ passed: true, issues: [] }));

    const firstGate: Gate.Check = { name: "first", check: firstGateCheck };
    const secondGate: Gate.Check = { name: "second", check: secondGateCheck };

    const result = await PlanPipeline.run("Plan QA", {
      generator: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
      gates: [firstGate, secondGate],
      maxRetries: 1,
    });

    expect(result.ok).toBe(false);
    expect(firstGateCheck).toHaveBeenCalledTimes(1);
    expect(secondGateCheck).toHaveBeenCalledTimes(0);
  });
});

function createPlan(planId: string): Plan {
  return {
    planId,
    goal: "Sample goal",
    steps: [
      {
        stepId: "s1",
        description: "Draft implementation",
        expectedOutput: "Draft produced",
        dependsOn: [],
      },
    ],
    createdAt: new Date("2026-03-26T00:00:00.000Z"),
    version: 1,
  };
}
