import { describe, expect, it } from "bun:test";
import {
  createBudgetReassuranceMiddleware,
  createBudgetWarningMiddleware,
} from "../../../../src/core/middleware/builtin/budget";
import type { MiddlewareContext } from "../../../../src/core/middleware";
import type { BudgetState } from "../../../../src/core/budget";

function baseCtx(overrides?: Partial<MiddlewareContext>): MiddlewareContext {
  return {
    timing: "pre_turn",
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
    ...overrides,
  };
}

function createBudgetState(overrides?: Partial<BudgetState>): BudgetState {
  return {
    startTime: Date.now(),
    turns: 0,
    toolCalls: 0,
    toolRuntimeMs: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    ...overrides,
  };
}

describe("createBudgetReassuranceMiddleware", () => {
  it("fires at 0.6 threshold with exact message text", async () => {
    const middleware = createBudgetReassuranceMiddleware();
    const ctx = baseCtx({
      budgetState: createBudgetState({ turns: 15 }),
      budget: { maxTurns: 24 },
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.action).toBe("inject");
    if (verdict.action === "inject") {
      expect(verdict.message).toContain("[Budget Status]");
      expect(verdict.message).toContain("You have plenty of budget remaining");
      expect(verdict.message).toContain("Do NOT rush or skip tasks");
      expect(verdict.message).toContain("Complete your work thoroughly");
    }
  });

  it("fires exactly once (closure state)", async () => {
    const middleware = createBudgetReassuranceMiddleware();
    const ctx = baseCtx({
      budgetState: createBudgetState({ turns: 15 }),
      budget: { maxTurns: 24 },
    });

    const verdict1 = await middleware.fn(ctx);
    const verdict2 = await middleware.fn(ctx);

    expect(verdict1.action).toBe("inject");
    expect(verdict2.action).toBe("continue");
  });

  it("continues below threshold", async () => {
    const middleware = createBudgetReassuranceMiddleware();
    const ctx = baseCtx({
      budgetState: createBudgetState({ turns: 5 }),
      budget: { maxTurns: 24 },
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.action).toBe("continue");
  });

  it("respects custom reassuranceThreshold", async () => {
    const middleware = createBudgetReassuranceMiddleware({ reassuranceThreshold: 0.5 });
    const ctx = baseCtx({
      budgetState: createBudgetState({ turns: 13 }),
      budget: { maxTurns: 24, reassuranceThreshold: 0.5 },
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.action).toBe("inject");
  });

  it("has priority 10", () => {
    const middleware = createBudgetReassuranceMiddleware();
    expect(middleware.priority).toBe(10);
  });

  it("has name builtin:budget-reassurance", () => {
    const middleware = createBudgetReassuranceMiddleware();
    expect(middleware.name).toBe("builtin:budget-reassurance");
  });
});

describe("createBudgetWarningMiddleware", () => {
  it("fires at 0.8 threshold with exact message text", async () => {
    const middleware = createBudgetWarningMiddleware();
    const ctx = baseCtx({
      budgetState: createBudgetState({ turns: 20 }),
      budget: { maxTurns: 24 },
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.action).toBe("inject");
    if (verdict.action === "inject") {
      expect(verdict.message).toContain("[Budget Warning]");
      expect(verdict.message).toContain("Wrap up your current task");
      expect(verdict.message).toContain("provide a summary");
    }
  });

  it("fires exactly once (closure state)", async () => {
    const middleware = createBudgetWarningMiddleware();
    const ctx = baseCtx({
      budgetState: createBudgetState({ turns: 20 }),
      budget: { maxTurns: 24 },
    });

    const verdict1 = await middleware.fn(ctx);
    const verdict2 = await middleware.fn(ctx);

    expect(verdict1.action).toBe("inject");
    expect(verdict2.action).toBe("continue");
  });

  it("continues below threshold", async () => {
    const middleware = createBudgetWarningMiddleware();
    const ctx = baseCtx({
      budgetState: createBudgetState({ turns: 10 }),
      budget: { maxTurns: 24 },
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.action).toBe("continue");
  });

  it("respects custom warningThreshold", async () => {
    const middleware = createBudgetWarningMiddleware({ warningThreshold: 0.7 });
    const ctx = baseCtx({
      budgetState: createBudgetState({ turns: 17 }),
      budget: { maxTurns: 24, warningThreshold: 0.7 },
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.action).toBe("inject");
  });

  it("has priority 20", () => {
    const middleware = createBudgetWarningMiddleware();
    expect(middleware.priority).toBe(20);
  });

  it("has name builtin:budget-warning", () => {
    const middleware = createBudgetWarningMiddleware();
    expect(middleware.name).toBe("builtin:budget-warning");
  });
});
