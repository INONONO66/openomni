import { describe, expect, it } from "bun:test";
import { Operational, PolicyDecision } from "@openomni/protocol";
import { Bus, collector } from "@openomni/telemetry";
import { dispatchBudgetCheck } from "../../../src/core/execution/lifecycle-dispatch";
import { PolicyEngine, type PolicyContext } from "../../../src/core/policy";
import { makeAgentBase, makeConfig, makeState } from "./lifecycle-dispatch-fixture";

describe("dispatchBudgetCheck (budget exhaustion)", () => {
  /**
   * `publishBudgetTelemetry` proves it uses the `run` it was handed; only this
   * proves the lifecycle hands it the real one. Pinning the invariant one
   * frame below where the trace enters leaves the wiring free to be wrong.
   */
  it("files the budget event under the run's trace, from the dispatch frame", async () => {
    const seen: Array<{ traceId: string; sessionId?: string }> = [];
    const unsubscribe = Bus.subscribe(Operational.Warn, (event) => {
      seen.push(event as unknown as { traceId: string; sessionId?: string });
    });
    const agentBase = makeAgentBase();
    const state = makeState();
    state.budgetState.turns = 20;

    try {
      await dispatchBudgetCheck(
        state,
        PolicyEngine.create(),
        makeConfig({ budget: { maxTurns: 24 } }),
        agentBase,
      );
      await Bun.sleep(0);
    } finally {
      unsubscribe();
    }

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      traceId: agentBase.traceId,
      sessionId: agentBase.sessionId,
    });
  });
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
    expect(observedOutcomes).toEqual([{ type: "max-steps" }]);
  });

  it("returns null when budget is not exceeded", async () => {
    const engine = PolicyEngine.create();
    const state = makeState();
    const config = makeConfig({ budget: { maxTurns: 100 } });

    const result = await dispatchBudgetCheck(state, engine, config, makeAgentBase());
    expect(result).toBeNull();
  });

  /**
   * The point of the port. The loop reports to whatever the composition root
   * hands it — no process-wide `Bus`, and P2 can put a fail-closed ledger
   * append behind this without touching the loop.
   */
  it("reports through the injected sink, not a global bus", async () => {
    const collected = collector();
    const busSaw: string[] = [];
    const unsubscribe = Bus.observe((descriptor) => busSaw.push(descriptor.name));
    const agentBase = makeAgentBase();
    const state = makeState();
    state.budgetState.turns = 20;

    try {
      await dispatchBudgetCheck(
        state,
        PolicyEngine.create(),
        makeConfig({ events: collected, budget: { maxTurns: 24 } }),
        agentBase,
      );
      await Bun.sleep(0);
    } finally {
      unsubscribe();
    }

    expect(collected.named(Operational.Warn.name)).toHaveLength(1);
    expect(busSaw).toEqual([]);
  });
});
