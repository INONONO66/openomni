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

  it("maxTurns -1 allows unlimited turns", () => {
    const s = { ...createBudgetState(), turns: 1000 };
    expect(checkBudget(s, { maxTurns: -1 })).toBe("ok");
  });

  it("maxTurns -1 with maxToolCalls limit uses only toolCalls ratio", () => {
    const s = { ...createBudgetState(), turns: 1000, toolCalls: 9 };
    expect(checkBudget(s, { maxTurns: -1, maxToolCalls: 10 })).toBe("warning");
  });

  it("all limits -1 always returns ok", () => {
    const s = { ...createBudgetState(), turns: 1000, toolCalls: 1000, toolRuntimeMs: 1000000 };
    expect(
      checkBudget(s, {
        maxTurns: -1,
        maxToolCalls: -1,
        maxWallTimeMs: -1,
        maxToolRuntimeMs: -1,
      }),
    ).toBe("ok");
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

  it("displays unlimited when maxTurns is -1", () => {
    const s = { ...createBudgetState(), turns: 5 };
    const desc = describeBudgetRemaining(s, { maxTurns: -1 });
    expect(desc).toContain("unlimited turns remaining");
  });

  it("singular turn when 1 remaining", () => {
    const s = { ...createBudgetState(), turns: 23 };
    const desc = describeBudgetRemaining(s, { maxTurns: 24 });
    expect(desc).toContain("1 turn remaining");
    expect(desc).not.toContain("turns");
  });
});
