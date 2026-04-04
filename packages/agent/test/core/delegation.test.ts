import { describe, expect, it } from "bun:test";
import { allocateBudget, checkDelegation } from "../../src/core/delegation";
import { createBudgetState } from "../../src/core/budget";
import type { DelegationContext } from "../../src/core/delegation";

const makeContext = (overrides: Partial<DelegationContext> = {}): DelegationContext => ({
  depth: 0,
  maxDepth: 3,
  visitedAgents: new Set(),
  parentAbort: {} as any,
  budgetPolicy: "inherit",
  ...overrides,
});

describe("checkDelegation", () => {
  it("allows delegation when depth is below max and agent not visited", () => {
    const ctx = makeContext({ depth: 0, maxDepth: 3 });
    expect(checkDelegation("agent-a", ctx)).toBe("allow");
  });

  it("detects circular delegation when agent already visited", () => {
    const ctx = makeContext({ visitedAgents: new Set(["agent-a", "agent-b"]) });
    expect(checkDelegation("agent-a", ctx)).toBe("circular_detected");
  });

  it("allows new agent not in visited set", () => {
    const ctx = makeContext({ visitedAgents: new Set(["agent-a", "agent-b"]) });
    expect(checkDelegation("agent-c", ctx)).toBe("allow");
  });

  it("returns depth_exceeded when depth equals maxDepth", () => {
    const ctx = makeContext({ depth: 3, maxDepth: 3 });
    expect(checkDelegation("agent-x", ctx)).toBe("depth_exceeded");
  });

  it("returns depth_exceeded when depth exceeds maxDepth", () => {
    const ctx = makeContext({ depth: 5, maxDepth: 3 });
    expect(checkDelegation("agent-x", ctx)).toBe("depth_exceeded");
  });

  it("allows when depth is one below maxDepth", () => {
    const ctx = makeContext({ depth: 2, maxDepth: 3 });
    expect(checkDelegation("agent-x", ctx)).toBe("allow");
  });

  it("circular detection takes priority over depth check", () => {
    const ctx = makeContext({
      depth: 5,
      maxDepth: 3,
      visitedAgents: new Set(["agent-a"]),
    });
    expect(checkDelegation("agent-a", ctx)).toBe("circular_detected");
  });
});

describe("allocateBudget", () => {
  it("independent returns fixed default budget", () => {
    const state = createBudgetState();
    const result = allocateBudget(state, undefined, { budgetPolicy: "independent" });
    expect(result.maxTurns).toBe(10);
    expect(result.maxToolCalls).toBe(20);
  });

  it("inherit passes remaining turns to child", () => {
    const state = { ...createBudgetState(), turns: 5 };
    const result = allocateBudget(state, { maxTurns: 24 }, { budgetPolicy: "inherit" });
    expect(result.maxTurns).toBe(19);
  });

  it("split allocates remaining × (1-reserve) × allocation", () => {
    const state = { ...createBudgetState(), turns: 12 };
    const result = allocateBudget(
      state,
      { maxTurns: 24 },
      {
        budgetPolicy: "split",
        budgetAllocation: 0.5,
        reserveForParent: 0.2,
      },
    );
    expect(result.maxTurns).toBe(4);
  });

  it("split with near-zero remaining returns at least 1 turn", () => {
    const state = { ...createBudgetState(), turns: 23 };
    const result = allocateBudget(
      state,
      { maxTurns: 24 },
      {
        budgetPolicy: "split",
        budgetAllocation: 0.5,
        reserveForParent: 0.2,
      },
    );
    expect(result.maxTurns).toBeGreaterThanOrEqual(1);
  });

  it("split with cost budget allocates proportionally", () => {
    const state = { ...createBudgetState(), totalCost: 0.5 };
    const result = allocateBudget(
      state,
      { maxTurns: 24, maxCost: 1.0 },
      {
        budgetPolicy: "split",
        budgetAllocation: 0.5,
        reserveForParent: 0.2,
      },
    );
    expect(result.maxCost).toBeCloseTo(0.2, 5);
  });
});
