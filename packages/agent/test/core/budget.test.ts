import { describe, expect, it } from "bun:test";
import { checkBudget, describeBudgetRemaining, createBudgetState } from "../../src/core/budget";

describe("checkBudget 4-state", () => {
  it("returns ok when below reassurance threshold", () => {
    const s = { ...createBudgetState(), turns: 12 };
    expect(checkBudget(s, { maxTurns: 24 })).toBe("ok");
  });

  it("returns reassurance when between reassurance and warning thresholds", () => {
    const s = { ...createBudgetState(), turns: 15 };
    expect(checkBudget(s, { maxTurns: 24 })).toBe("reassurance");
  });

  it("returns warning when between warning and exceeded thresholds", () => {
    const s = { ...createBudgetState(), turns: 20 };
    expect(checkBudget(s, { maxTurns: 24 })).toBe("warning");
  });

  it("returns exceeded when at limit", () => {
    const s = { ...createBudgetState(), turns: 24 };
    expect(checkBudget(s, { maxTurns: 24 })).toBe("exceeded");
  });

  it("highest ratio wins (cost at 85%, turns at 21%)", () => {
    const s = { ...createBudgetState(), totalCost: 0.85 };
    expect(checkBudget(s, { maxTurns: 24, maxCost: 1.0 })).toBe("warning");
  });

  it("backward compat: undefined budget uses defaults", () => {
    expect(checkBudget(createBudgetState())).toBe("ok");
  });

  it("custom thresholds override defaults", () => {
    const s = { ...createBudgetState(), turns: 18 };
    expect(checkBudget(s, { maxTurns: 24, warningThreshold: 0.9, reassuranceThreshold: 0.7 })).toBe(
      "reassurance",
    );
  });
});

describe("describeBudgetRemaining", () => {
  it("includes turns remaining", () => {
    const s = { ...createBudgetState(), turns: 5 };
    const desc = describeBudgetRemaining(s, { maxTurns: 24 });
    expect(desc).toContain("19 turns remaining");
  });

  it("includes cost when maxCost provided", () => {
    const s = { ...createBudgetState(), totalCost: 0.5 };
    const desc = describeBudgetRemaining(s, { maxCost: 1.0 });
    expect(desc).toContain("$0.5000 budget remaining");
  });

  it("singular turn when 1 remaining", () => {
    const s = { ...createBudgetState(), turns: 23 };
    const desc = describeBudgetRemaining(s, { maxTurns: 24 });
    expect(desc).toContain("1 turn remaining");
    expect(desc).not.toContain("turns");
  });
});
