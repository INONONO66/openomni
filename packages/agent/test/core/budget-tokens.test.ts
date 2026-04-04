import { describe, expect, it } from "bun:test";
import { createBudgetState, checkBudget, recordTokenUsage } from "../../src/core/budget";

describe("BudgetState token tracking", () => {
  it("starts with zero token counts", () => {
    const state = createBudgetState();
    expect(state.totalInputTokens).toBe(0);
    expect(state.totalOutputTokens).toBe(0);
    expect(state.totalCost).toBe(0);
  });

  it("recordTokenUsage accumulates tokens", () => {
    let state = createBudgetState();
    state = recordTokenUsage(state, 100, 50, 0.001);
    state = recordTokenUsage(state, 200, 100, 0.002);
    expect(state.totalInputTokens).toBe(300);
    expect(state.totalOutputTokens).toBe(150);
    expect(state.totalCost).toBeCloseTo(0.003);
  });

  it("checkBudget exceeds when maxInputTokens reached", () => {
    let state = createBudgetState();
    state = recordTokenUsage(state, 1000, 0, 0);
    expect(checkBudget(state, { maxInputTokens: 999 })).toBe("exceeded");
    expect(checkBudget(state, { maxInputTokens: 1001 })).toBe("warning");
  });

  it("checkBudget exceeds when maxOutputTokens reached", () => {
    let state = createBudgetState();
    state = recordTokenUsage(state, 0, 500, 0);
    expect(checkBudget(state, { maxOutputTokens: 499 })).toBe("exceeded");
  });

  it("checkBudget exceeds when maxTotalTokens reached", () => {
    let state = createBudgetState();
    state = recordTokenUsage(state, 300, 200, 0);
    expect(checkBudget(state, { maxTotalTokens: 499 })).toBe("exceeded");
    expect(checkBudget(state, { maxTotalTokens: 501 })).toBe("warning");
  });

  it("checkBudget exceeds when maxCost reached", () => {
    let state = createBudgetState();
    state = recordTokenUsage(state, 0, 0, 1.5);
    expect(checkBudget(state, { maxCost: 1.0 })).toBe("exceeded");
    expect(checkBudget(state, { maxCost: 2.0 })).toBe("reassurance");
  });
});
