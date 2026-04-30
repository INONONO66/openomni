import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import type { Run, Sink } from "@openomni/protocol";

// mock.module must precede dynamic import of the module under test
type MockLlmFn = (input: unknown, sink: Sink) => Promise<Run.Outcome>;

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
  run: (input: unknown, sink: Sink) => mockRunFn(input, sink),
  TokenTracker: {
    extractUsage: () => ({ inputTokens: 0, outputTokens: 0 }),
  },
}));

// --- Dynamic import after mock ---

let runPlan: typeof import("../../src/plan/run-plan").runPlan;
let PlanValidationFailedError: typeof import("../../src/plan/run-plan").PlanValidationFailedError;

beforeAll(async () => {
  ({ runPlan, PlanValidationFailedError } = await import("../../src/plan/run-plan"));
});

afterAll(() => {
  mock.restore();
});

describe("runPlan", () => {
  it("returns planId when plan is written to adapter", async () => {
    const { memoryPlanAdapter } = await import("../../src/plan/memory-plan-adapter");
    const adapter = memoryPlanAdapter();

    mockRunFn = async () => {
      // simulate what plan tool executor does when LLM calls plan_write
      await adapter.write("test-plan", "# My Plan\n## Steps\n- step 1");
      return { type: "stop" };
    };

    const result = await runPlan("Generate a test plan", {
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      planSubAdapter: adapter,
      planId: "test-plan",
    });

    expect(result.planId).toBe("test-plan");
  });

  it("throws error when plan is not written to adapter", async () => {
    mockRunFn = async () => ({ type: "stop" });

    const { memoryPlanAdapter } = await import("../../src/plan/memory-plan-adapter");
    let caught: unknown;
    try {
      await runPlan("Generate a test plan", {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        planSubAdapter: memoryPlanAdapter(),
        planId: "missing-plan",
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("plan agent did not write plan");
  });

  it("returns deterministic planId when passed in config", async () => {
    const { memoryPlanAdapter } = await import("../../src/plan/memory-plan-adapter");
    const adapter = memoryPlanAdapter();
    const expectedPlanId = "test-plan-123";

    mockRunFn = async () => {
      await adapter.write(expectedPlanId, "# Plan content");
      return { type: "stop" };
    };

    const result = await runPlan("Generate a test plan", {
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      planSubAdapter: adapter,
      planId: expectedPlanId,
    });

    expect(result.planId).toBe(expectedPlanId);
  });

  it("rejects a generated markdown plan with cyclic dependencies", async () => {
    const { memoryPlanAdapter } = await import("../../src/plan/memory-plan-adapter");
    const adapter = memoryPlanAdapter();

    mockRunFn = async () => {
      await adapter.write(
        "cyclic-plan",
        [
          "# Plan",
          "## Steps",
          "- A: Build the first piece",
          "- B: Build the second piece",
          "## Dependencies",
          "- A depends on B",
          "- B depends on A",
        ].join("\n"),
      );
      return { type: "stop" };
    };

    let caught: unknown;
    try {
      await runPlan("Generate a cyclic test plan", {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        planSubAdapter: adapter,
        planId: "cyclic-plan",
      });
    } catch (err) {
      caught = err;
    }

    expect(PlanValidationFailedError.isInstance(caught)).toBe(true);
    if (!PlanValidationFailedError.isInstance(caught)) throw new Error("expected validation error");
    expect(caught.name).toBe("PLAN_VALIDATION_FAILED");
    expect(caught.data.code).toBe("PLAN_VALIDATION_FAILED");
    expect(caught.data.message).toContain("Dependency cycle detected");
  });
});
