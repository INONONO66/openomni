import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Gate, Plan } from "@openomni/protocol";

// Prevent module cache contamination from @openomni/llm missing exports
mock.module("@openomni/agent", () => ({
  ChatAgent: { create: () => ({ run: async () => ({ text: "{}" }) }) },
}));

const mockGenerate = mock(async () => ({ plan: createPlan("plan-default") }));

mock.module("../../src/plan/plan-agent", () => ({
  PlanAgent: {
    generate: mockGenerate,
  },
}));

let PlanPipeline: typeof import("../../src/plan/plan-pipeline").PlanPipeline;

beforeAll(async () => {
  ({ PlanPipeline } = await import("../../src/plan/plan-pipeline"));
});

beforeEach(() => {
  mockGenerate.mockClear();
});

describe("PlanPipeline enrichers", () => {
  it("runs without enrichers like before", async () => {
    mockGenerate.mockResolvedValueOnce({ plan: createPlan("p1") });

    const result = await PlanPipeline.run("goal", {
      generator: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
      gates: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.enricherResults).toBeUndefined();
    }
  });

  it("enriches plan before passing to gates", async () => {
    mockGenerate.mockResolvedValueOnce({ plan: createPlan("p1", "orig-step") });

    const enrichedPlan = createPlan("p1", "orig-step");
    enrichedPlan.steps.push({
      stepId: "added-step",
      description: "verify the implementation thoroughly",
      expectedOutput: "implementation is verified",
      dependsOn: ["orig-step"],
    });

    const enricher: Gate.Enricher = {
      name: "gap-enricher",
      enrich: async () => ({
        plan: enrichedPlan,
        applied: [
          {
            type: "added_step",
            stepId: "added-step",
            description: "added gap step",
          },
        ],
      }),
    };

    let planReceivedByGate: Plan | null = null;
    const gate: Gate.Check = {
      name: "capture-gate",
      check: (plan) => {
        planReceivedByGate = plan;
        return { passed: true, issues: [] };
      },
    };

    const result = await PlanPipeline.run("goal", {
      generator: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
      enrichers: [enricher],
      gates: [gate],
    });

    expect(result.ok).toBe(true);
    expect(planReceivedByGate).not.toBeNull();
    expect(planReceivedByGate!.steps).toHaveLength(2);
    if (result.ok) {
      expect(result.plan.steps).toHaveLength(2);
      expect(result.enricherResults?.[0]?.enricherName).toBe("gap-enricher");
      expect(result.enricherResults?.[0]?.action).toBe("added_step");
    }
  });

  it("keeps original plan when enricher returns skip (empty applied)", async () => {
    mockGenerate.mockResolvedValueOnce({ plan: createPlan("p1") });

    const enricher: Gate.Enricher = {
      name: "skip-enricher",
      enrich: async (plan) => ({ plan, applied: [] }),
    };

    let planReceivedByGate: Plan | null = null;
    const gate: Gate.Check = {
      name: "capture-gate",
      check: (plan) => {
        planReceivedByGate = plan;
        return { passed: true, issues: [] };
      },
    };

    await PlanPipeline.run("goal", {
      generator: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
      enrichers: [enricher],
      gates: [gate],
    });

    expect(planReceivedByGate).not.toBeNull();
    expect(planReceivedByGate!.steps).toHaveLength(1);
  });

  it("runs multiple enrichers in order", async () => {
    mockGenerate.mockResolvedValueOnce({ plan: createPlan("p1") });
    const callOrder: string[] = [];

    const enricherA: Gate.Enricher = {
      name: "enricher-a",
      enrich: async (plan) => {
        callOrder.push("a");
        return { plan, applied: [] };
      },
    };
    const enricherB: Gate.Enricher = {
      name: "enricher-b",
      enrich: async (plan) => {
        callOrder.push("b");
        return { plan, applied: [] };
      },
    };

    await PlanPipeline.run("goal", {
      generator: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
      enrichers: [enricherA, enricherB],
      gates: [],
    });

    expect(callOrder).toEqual(["a", "b"]);
  });

  it("returns error when enricher throws", async () => {
    mockGenerate.mockResolvedValueOnce({ plan: createPlan("p1") });

    const enricher: Gate.Enricher = {
      name: "bad-enricher",
      enrich: async () => {
        throw new Error("enrichment failed");
      },
    };

    const result = await PlanPipeline.run("goal", {
      generator: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
      enrichers: [enricher],
      gates: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("bad-enricher");
      expect(result.reason).toContain("enrichment failed");
    }
  });

  it("fails when enriched plan is structurally invalid", async () => {
    mockGenerate.mockResolvedValueOnce({ plan: createPlan("p1") });

    const enricher: Gate.Enricher = {
      name: "bad-plan-enricher",
      enrich: async () => ({
        plan: {
          planId: "p1",
          goal: "test",
          steps: [
            {
              stepId: "s1",
              description: "step one in detail",
              expectedOutput: "output one",
              dependsOn: [],
            },
            {
              stepId: "s1",
              description: "duplicate step id",
              expectedOutput: "oops",
              dependsOn: [],
            },
          ],
          createdAt: new Date(),
          version: 1,
        },
        applied: [{ type: "added_step", stepId: "s1", description: "added duplicate" }],
      }),
    };

    const result = await PlanPipeline.run("goal", {
      generator: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
      enrichers: [enricher],
      gates: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("validation failed after enrichment");
    }
  });

  it("runs enrichers on each retry attempt", async () => {
    mockGenerate.mockResolvedValueOnce({ plan: createPlan("p1") });
    mockGenerate.mockResolvedValueOnce({ plan: createPlan("p2") });

    let enrichCallCount = 0;
    const enricher: Gate.Enricher = {
      name: "counting-enricher",
      enrich: async (plan) => {
        enrichCallCount++;
        return { plan, applied: [] };
      },
    };

    let gateCallCount = 0;
    const gate: Gate.Check = {
      name: "fail-first-gate",
      check: () => {
        gateCallCount++;
        if (gateCallCount === 1) {
          return {
            passed: false,
            issues: [{ code: "fail", severity: "error", message: "fail" }],
            feedback: "retry",
          };
        }
        return { passed: true, issues: [] };
      },
    };

    const result = await PlanPipeline.run("goal", {
      generator: {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
      enrichers: [enricher],
      gates: [gate],
      maxRetries: 3,
    });

    expect(result.ok).toBe(true);
    expect(enrichCallCount).toBe(2);
  });
});

function createPlan(planId: string, stepId = "step-1"): Plan {
  return {
    planId,
    goal: "test goal",
    steps: [
      {
        stepId,
        description: "do something important",
        expectedOutput: "something is done",
        dependsOn: [],
      },
    ],
    createdAt: new Date(),
    version: 1,
  };
}
