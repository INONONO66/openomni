import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { ChatAgent, type AgentResult } from "@openomni/agent";
import type { Plan, PlanStep } from "@openomni/protocol";
import type { Teammate } from "../../src/team/teammate";
import { ApprovalGate } from "../../src/team/approval-gate";
import { TeamOrchestrator } from "../../src/team/team-orchestrator";

const responseQueue: string[] = [];

const createSpy = spyOn(ChatAgent, "create").mockImplementation(
  () =>
    ({
      run: async () => {
        const text = responseQueue.shift() ?? "{}";
        return {
          text,
          steps: [],
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
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
});

function makeStep(
  stepId: string,
  opts?: { dependsOn?: string[]; requiresApproval?: boolean },
): PlanStep {
  return {
    stepId,
    description: `${stepId} task`,
    expectedOutput: `${stepId} output`,
    dependsOn: opts?.dependsOn ?? [],
    requiresApproval: opts?.requiresApproval,
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

function makeConfig(overrides?: { approvalGate?: ApprovalGate.Gate; maxAttemptsPerStep?: number }) {
  return {
    reviewModel: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    teammates: new Map<string, Teammate.TeammateConfig>(),
    defaultTeammateConfig,
    maxAttemptsPerStep: overrides?.maxAttemptsPerStep,
    approvalGate: overrides?.approvalGate,
  };
}

describe("ApprovalGate", () => {
  describe("createDefaultGate", () => {
    it("auto-rejects after timeout", async () => {
      const gate = ApprovalGate.createDefaultGate({ timeoutMs: 50 });
      const plan = makePlan([makeStep("s1")]);

      const result = await gate.requestApproval({
        stepId: "s1",
        stepTitle: "s1 task",
        plan,
      });

      expect(result).toBe("rejected");
    });

    it("resolves with approved when respond is called", async () => {
      const gate = ApprovalGate.createDefaultGate({ timeoutMs: 5000 });
      const plan = makePlan([makeStep("s1")]);

      const promise = gate.requestApproval({
        stepId: "s1",
        stepTitle: "s1 task",
        plan,
      });

      gate.respond("approved");

      const result = await promise;
      expect(result).toBe("approved");
    });

    it("resolves with rejected when respond is called with rejected", async () => {
      const gate = ApprovalGate.createDefaultGate({ timeoutMs: 5000 });
      const plan = makePlan([makeStep("s1")]);

      const promise = gate.requestApproval({
        stepId: "s1",
        stepTitle: "s1 task",
        plan,
      });

      gate.respond("rejected");

      const result = await promise;
      expect(result).toBe("rejected");
    });

    it("calls onApprovalRequested callback", async () => {
      let capturedContext: ApprovalGate.ApprovalContext | null = null;
      const gate = ApprovalGate.createDefaultGate({
        timeoutMs: 50,
        onApprovalRequested: (ctx) => {
          capturedContext = ctx;
        },
      });

      const plan = makePlan([makeStep("s1")]);

      await gate.requestApproval({
        stepId: "s1",
        stepTitle: "s1 task",
        stepDescription: "s1 output",
        plan,
      });

      expect(capturedContext).not.toBeNull();
      expect(capturedContext!.stepId).toBe("s1");
      expect(capturedContext!.stepTitle).toBe("s1 task");
      expect(capturedContext!.stepDescription).toBe("s1 output");
    });
  });

  describe("ApprovalGate.respond utility", () => {
    it("calls respond on a default gate", async () => {
      const gate = ApprovalGate.createDefaultGate({ timeoutMs: 5000 });
      const plan = makePlan([makeStep("s1")]);

      const promise = gate.requestApproval({
        stepId: "s1",
        stepTitle: "s1 task",
        plan,
      });

      ApprovalGate.respond(gate, "approved");

      const result = await promise;
      expect(result).toBe("approved");
    });

    it("is a no-op on gates without respond method", () => {
      const customGate: ApprovalGate.Gate = {
        requestApproval: async () => "approved",
      };

      expect(() => ApprovalGate.respond(customGate, "rejected")).not.toThrow();
    });
  });
});

describe("TeamOrchestrator with ApprovalGate", () => {
  it("executes step when approval is granted", async () => {
    const gate = ApprovalGate.createDefaultGate({ timeoutMs: 5000 });

    responseQueue.push("step output");
    responseQueue.push(JSON.stringify({ decision: "accept" }));

    const plan = makePlan([makeStep("s1", { requiresApproval: true })]);

    const resultPromise = TeamOrchestrator.execute(plan, makeConfig({ approvalGate: gate }));

    // Small delay to let orchestrator reach the approval gate
    await new Promise((r) => setTimeout(r, 10));
    gate.respond("approved");

    const result = await resultPromise;
    expect(result.status).toBe("completed");
    expect(result.completedSteps).toEqual(["s1"]);
    expect(result.results.get("s1")).toBe("step output");
  });

  it("fails step when approval is rejected", async () => {
    const gate = ApprovalGate.createDefaultGate({ timeoutMs: 5000 });

    const plan = makePlan([makeStep("s1", { requiresApproval: true })]);

    const resultPromise = TeamOrchestrator.execute(plan, makeConfig({ approvalGate: gate }));

    await new Promise((r) => setTimeout(r, 10));
    gate.respond("rejected");

    const result = await resultPromise;
    expect(result.status).toBe("failed");
    expect(result.failedSteps).toEqual(["s1"]);
  });

  it("auto-rejects step after timeout", async () => {
    const gate = ApprovalGate.createDefaultGate({ timeoutMs: 50 });

    const plan = makePlan([makeStep("s1", { requiresApproval: true })]);

    const result = await TeamOrchestrator.execute(plan, makeConfig({ approvalGate: gate }));

    expect(result.status).toBe("failed");
    expect(result.failedSteps).toEqual(["s1"]);
  });

  it("skips dependents when approval is rejected", async () => {
    const gate = ApprovalGate.createDefaultGate({ timeoutMs: 5000 });

    const plan = makePlan([
      makeStep("s1", { requiresApproval: true }),
      makeStep("s2", { dependsOn: ["s1"] }),
    ]);

    const resultPromise = TeamOrchestrator.execute(plan, makeConfig({ approvalGate: gate }));

    await new Promise((r) => setTimeout(r, 10));
    gate.respond("rejected");

    const result = await resultPromise;
    expect(result.failedSteps).toEqual(["s1"]);
    expect(result.skippedSteps).toEqual(["s2"]);
  });

  it("does not require approval when requiresApproval is not set", async () => {
    responseQueue.push("step output");
    responseQueue.push(JSON.stringify({ decision: "accept" }));

    const plan = makePlan([makeStep("s1")]);

    const result = await TeamOrchestrator.execute(plan, makeConfig());

    expect(result.status).toBe("completed");
    expect(result.completedSteps).toEqual(["s1"]);
  });

  it("does not require approval when no gate is configured", async () => {
    responseQueue.push("step output");
    responseQueue.push(JSON.stringify({ decision: "accept" }));

    const plan = makePlan([makeStep("s1", { requiresApproval: true })]);

    const result = await TeamOrchestrator.execute(plan, makeConfig());

    expect(result.status).toBe("completed");
    expect(result.completedSteps).toEqual(["s1"]);
  });

  it("works with custom gate implementation", async () => {
    const customGate: ApprovalGate.Gate = {
      requestApproval: async () => "approved",
    };

    responseQueue.push("step output");
    responseQueue.push(JSON.stringify({ decision: "accept" }));

    const plan = makePlan([makeStep("s1", { requiresApproval: true })]);

    const result = await TeamOrchestrator.execute(plan, makeConfig({ approvalGate: customGate }));

    expect(result.status).toBe("completed");
    expect(result.completedSteps).toEqual(["s1"]);
  });
});
