import { describe, expect, it } from "bun:test";
import {
  createBudgetReassurancePolicy,
  createBudgetWarningPolicy,
} from "../../../../src/core/policy/builtin/budget";
import type { PolicyFn } from "../../../../src/core/policy";
import type { BudgetState } from "../../../../src/core/budget";
import type { Policy } from "@openomni/protocol";

function baseCtx(
  overrides?: Partial<Omit<Parameters<PolicyFn>[0], "pointId">>,
): Parameters<PolicyFn>[0] {
  return {
    timing: "turn.start",
    pointId: "run.turn.pre",
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
    ...overrides,
  };
}

function injectedMessage(verdict: Policy.PolicyDecision): string | undefined {
  return verdict.effects.find((effect) => effect.type === "prompt.inject_message")?.message;
}

function createBudgetState(overrides?: Partial<BudgetState>): BudgetState {
  return {
    startTime: Date.now(),
    turns: 0,
    toolCalls: 0,
    toolRuntimeMs: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    ...overrides,
  };
}

describe("createBudgetReassurancePolicy", () => {
  it("fires at 0.6 threshold with exact message text", async () => {
    const middleware = createBudgetReassurancePolicy();
    const ctx = baseCtx({
      budgetState: createBudgetState({ turns: 15 }),
      budget: { maxTurns: 24 },
    });

    const verdict = await middleware.fn(ctx);
    const message = injectedMessage(verdict);

    expect(verdict.verdict).toBe("allow");
    expect(message).toContain("[Budget Status]");
    expect(message).toContain("You have plenty of budget remaining");
    expect(message).toContain("Do NOT rush or skip tasks");
    expect(message).toContain("Complete your work thoroughly");
  });

  it("fires exactly once (closure state)", async () => {
    const middleware = createBudgetReassurancePolicy();
    const ctx = baseCtx({
      budgetState: createBudgetState({ turns: 15 }),
      budget: { maxTurns: 24 },
    });

    const verdict1 = await middleware.fn(ctx);
    const verdict2 = await middleware.fn(ctx);

    expect(injectedMessage(verdict1)).toBeDefined();
    expect(injectedMessage(verdict2)).toBeUndefined();
  });

  it("continues below threshold", async () => {
    const middleware = createBudgetReassurancePolicy();
    const ctx = baseCtx({
      budgetState: createBudgetState({ turns: 5 }),
      budget: { maxTurns: 24 },
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.verdict).toBe("allow");
  });

  it("respects custom reassuranceThreshold", async () => {
    const middleware = createBudgetReassurancePolicy();
    const ctx = baseCtx({
      budgetState: createBudgetState({ turns: 13 }),
      budget: { maxTurns: 24, reassuranceThreshold: 0.5 },
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.verdict).toBe("allow");
  });

  it("has priority 10", () => {
    const middleware = createBudgetReassurancePolicy();
    expect(middleware.priority).toBe(10);
  });

  it("has name builtin:budget-reassurance", () => {
    const middleware = createBudgetReassurancePolicy();
    expect(middleware.name).toBe("builtin:budget-reassurance");
  });
});

describe("createBudgetWarningPolicy", () => {
  it("fires at 0.8 threshold with exact message text", async () => {
    const middleware = createBudgetWarningPolicy();
    const ctx = baseCtx({
      budgetState: createBudgetState({ turns: 20 }),
      budget: { maxTurns: 24 },
    });

    const verdict = await middleware.fn(ctx);
    const message = injectedMessage(verdict);

    expect(verdict.verdict).toBe("allow");
    expect(message).toContain("[Budget Warning]");
    expect(message).toContain("Wrap up your current task");
    expect(message).toContain("provide a summary");
  });

  it("fires exactly once (closure state)", async () => {
    const middleware = createBudgetWarningPolicy();
    const ctx = baseCtx({
      budgetState: createBudgetState({ turns: 20 }),
      budget: { maxTurns: 24 },
    });

    const verdict1 = await middleware.fn(ctx);
    const verdict2 = await middleware.fn(ctx);

    expect(injectedMessage(verdict1)).toBeDefined();
    expect(injectedMessage(verdict2)).toBeUndefined();
  });

  it("continues below threshold", async () => {
    const middleware = createBudgetWarningPolicy();
    const ctx = baseCtx({
      budgetState: createBudgetState({ turns: 10 }),
      budget: { maxTurns: 24 },
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.verdict).toBe("allow");
  });

  it("respects custom warningThreshold", async () => {
    const middleware = createBudgetWarningPolicy();
    const ctx = baseCtx({
      budgetState: createBudgetState({ turns: 17 }),
      budget: { maxTurns: 24, warningThreshold: 0.7 },
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.verdict).toBe("allow");
  });

  it("has priority 20", () => {
    const middleware = createBudgetWarningPolicy();
    expect(middleware.priority).toBe(20);
  });

  it("has name builtin:budget-warning", () => {
    const middleware = createBudgetWarningPolicy();
    expect(middleware.name).toBe("builtin:budget-warning");
  });
});
