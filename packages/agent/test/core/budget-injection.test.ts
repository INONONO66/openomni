import { describe, expect, it } from "bun:test";
import { checkBudget, describeBudgetRemaining, createBudgetState } from "../../src/core/budget";

// Test the budget injection logic by verifying the state machine behavior
// (We test the pure functions since the injection logic is in the agent loop)

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

  it("injects reassurance message exactly once at 60% threshold", () => {
    // Simulate the flag logic
    let reassuranceIssued = false;
    const messages: string[] = [];

    const injectIfNeeded = (turns: number) => {
      const state = { ...createBudgetState(), turns };
      const status = checkBudget(state, { maxTurns: 24 });
      if (status === "reassurance" && !reassuranceIssued) {
        messages.push("[Budget Status] message");
        reassuranceIssued = true;
      }
    };

    injectIfNeeded(14); // 58% — ok
    injectIfNeeded(15); // 62.5% — reassurance → inject
    injectIfNeeded(16); // 66.7% — reassurance → already issued, skip
    injectIfNeeded(17); // 70.8% — reassurance → already issued, skip

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("[Budget Status]");
  });

  it("injects both reassurance and warning in sequence", () => {
    let reassuranceIssued = false;
    let warningIssued = false;
    const messages: string[] = [];

    const injectIfNeeded = (turns: number) => {
      const state = { ...createBudgetState(), turns };
      const status = checkBudget(state, { maxTurns: 24 });
      if (status === "reassurance" && !reassuranceIssued) {
        messages.push("[Budget Status]");
        reassuranceIssued = true;
      }
      if (status === "warning" && !warningIssued) {
        messages.push("[Budget Warning]");
        warningIssued = true;
      }
    };

    injectIfNeeded(15); // reassurance
    injectIfNeeded(20); // warning
    injectIfNeeded(21); // warning — already issued

    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain("[Budget Status]");
    expect(messages[1]).toContain("[Budget Warning]");
  });

  it("describeBudgetRemaining includes turns info", () => {
    const state = { ...createBudgetState(), turns: 15 };
    const desc = describeBudgetRemaining(state, { maxTurns: 24 });
    expect(desc).toContain("9 turns remaining");
  });
});
