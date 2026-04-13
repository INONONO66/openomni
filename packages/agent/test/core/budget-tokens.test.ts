import { describe, expect, it } from "bun:test";
import { createBudgetState, recordTokenUsage } from "../../src/core/budget";

describe("BudgetState token tracking", () => {
  it("starts with zero token counts", () => {
    const state = createBudgetState();
    expect(state.totalInputTokens).toBe(0);
    expect(state.totalOutputTokens).toBe(0);
  });

  it("recordTokenUsage accumulates tokens", () => {
    let state = createBudgetState();
    state = recordTokenUsage(state, 100, 50);
    state = recordTokenUsage(state, 200, 100);
    expect(state.totalInputTokens).toBe(300);
    expect(state.totalOutputTokens).toBe(150);
  });
});
