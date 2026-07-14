import { describe, expect, it } from "bun:test";
import { PolicyDecision } from "@openomni/protocol";
import { dispatchBudgetCheck } from "../../../src/core/execution/lifecycle-dispatch";
import { PolicyEngine, type PolicyContext } from "../../../src/core/policy";
import { makeAgentBase, makeConfig, makeState } from "./lifecycle-dispatch-fixture";

describe("dispatchBudgetCheck (budget exhaustion)", () => {
  it("dispatches a truthful max-steps lifecycle outcome when budget is exceeded", async () => {
    const observedOutcomes: unknown[] = [];
    const state = makeState();
    const engine = PolicyEngine.create();
    engine.register({
      kind: "point",
      name: "test:max-steps-observer",
      pointIds: ["run.lifecycle.post"],
      effectCapabilities: { "run.lifecycle.post": [] },
      priority: 0,
      fn: (context: PolicyContext) => {
        observedOutcomes.push(Reflect.get(context, "runOutcome"));
        return PolicyDecision.allow({ policyId: "test.max-steps-observer" });
      },
    });
    state.budgetState = {
      ...state.budgetState,
      turns: 100,
      toolCalls: 100,
      totalInputTokens: 100000,
      totalOutputTokens: 100000,
      toolRuntimeMs: 100000,
    };
    const config = makeConfig({ budget: { maxTurns: 1 } });

    const result = await dispatchBudgetCheck(state, engine, config, makeAgentBase());

    expect(result).not.toBeNull();
    expect(result?.type).toBe("complete");
    expect(observedOutcomes).toEqual([{ type: "max-steps" }]);
  });

  it("returns null when budget is not exceeded", async () => {
    const engine = PolicyEngine.create();
    const state = makeState();
    const config = makeConfig({ budget: { maxTurns: 100 } });

    const result = await dispatchBudgetCheck(state, engine, config, makeAgentBase());
    expect(result).toBeNull();
  });
});
