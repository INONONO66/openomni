import { describe, expect, it } from "bun:test";
import { checkBudget, describeBudgetRemaining, createBudgetState } from "../../src/core/budget";

// Pure-function coverage of the budget thresholds. The loop-side injection
// behavior lives in the execution seam and is tested there:
// core/execution/lifecycle-budget.test.ts (dispatchBudgetCheck),
// core/execution/lifecycle-turn-pre.test.ts (budget events via buildTurn),
// and core/budget.test.ts (publishBudgetTelemetry emits once).

describe("budget injection state machine", () => {
  it("returns reassurance at 60% threshold", () => {
    // 15/24 = 62.5% — above reassuranceThreshold (0.6)
    const state = { ...createBudgetState(), turns: 15 };
    expect(checkBudget(state, { maxTurns: 24 })).toBe("reassurance");
  });

  it("returns warning at 80% threshold", () => {
    // 20/24 = 83.3% — above warningThreshold (0.8)
    const state = { ...createBudgetState(), turns: 20 };
    expect(checkBudget(state, { maxTurns: 24 })).toBe("warning");
  });

  it("describeBudgetRemaining includes turns info", () => {
    const state = { ...createBudgetState(), turns: 15 };
    const desc = describeBudgetRemaining(state, { maxTurns: 24 });
    expect(desc).toContain("9 turns remaining");
  });
});
