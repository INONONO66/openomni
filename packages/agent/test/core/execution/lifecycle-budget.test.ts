import { describe, expect, it } from "bun:test";
import { deny, registerAt } from "../../helpers/policy-decision";
import { Operational, PolicyDecision } from "@openomni/protocol";
import { Bus, collector } from "@openomni/telemetry";
import { dispatchBudgetCheck } from "../../../src/core/execution/lifecycle-dispatch";
import { PolicyEngine, type PolicyContext } from "../../../src/core/policy";
import { makeAgentBase, makeConfig, makeState } from "./lifecycle-dispatch-fixture";
import { captureBusEvents } from "../../helpers/bus-event";

describe("dispatchBudgetCheck (budget exhaustion)", () => {
  /**
   * `publishBudgetTelemetry` proves it uses the `run` it was handed; only this
   * proves the lifecycle hands it the real one. Pinning the invariant one
   * frame below where the trace enters leaves the wiring free to be wrong.
   */
  it("files the budget event under the run's trace, from the dispatch frame", async () => {
    const warning = captureBusEvents(Operational.Events.Warn);
    const agentBase = makeAgentBase();
    const state = makeState();
    state.budgetState.turns = 20;

    try {
      await dispatchBudgetCheck(
        state,
        PolicyEngine.create({ clock: Date.now }),
        makeConfig({ budget: { maxTurns: 24 } }),
        agentBase,
      );
      const [seen] = await warning.done;
      expect(warning.events).toHaveLength(1);
      expect(seen).toMatchObject({
        traceId: agentBase.traceId,
        sessionId: agentBase.sessionId,
      });
    } finally {
      warning.unsubscribe();
    }
  });
  it("dispatches a truthful max-steps lifecycle outcome when budget is exceeded", async () => {
    const observedOutcomes: unknown[] = [];
    const state = makeState();
    const engine = PolicyEngine.create({ clock: Date.now });
    registerAt(
      engine,
      "run.lifecycle.post",
      "test:max-steps-observer",
      0,
      (context: PolicyContext) => {
        observedOutcomes.push(Reflect.get(context, "runOutcome"));
        return PolicyDecision.allow({ policyId: "test.max-steps-observer" });
      },
    );
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

  /**
   * Audit L4: wall-time exhaustion still ends with finishReason "max-steps" —
   * the AgentResult union's only budget-exhaustion member — but the REAL
   * limit is on the record: the budget-exceeded Warn emitted in the same
   * dispatch names it, on the run's trace.
   */
  it("wall-time exhaustion: finishReason max-steps, with the real limit named on the record", async () => {
    const collected = collector();
    const state = makeState();
    // startTime pushed into the past: wall time is the exceeded limit while
    // every countable pool is untouched.
    state.budgetState = { ...state.budgetState, startTime: Date.now() - 10_000 };
    const config = makeConfig({ events: collected, budget: { maxWallTimeMs: 1000 } });

    const result = await dispatchBudgetCheck(
      state,
      PolicyEngine.create({ clock: Date.now }),
      config,
      makeAgentBase(),
    );

    expect(result).not.toBeNull();
    expect(result?.finishReason).toBe("max-steps");
    const warns = collected.named(Operational.Events.Warn.name);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({
      msg: "budget exceeded: wall time",
      context: { type: "exceeded" },
    });
  });

  it("still returns max-steps when the post-run observer denies", async () => {
    const engine = PolicyEngine.create({ clock: Date.now });
    registerAt(engine, "run.lifecycle.post", "test:deny-post-budget", 0, () => deny());
    const state = makeState();
    state.budgetState.turns = 1;

    const result = await dispatchBudgetCheck(
      state,
      engine,
      makeConfig({ budget: { maxTurns: 1 } }),
      makeAgentBase(),
    );

    expect(result?.finishReason).toBe("max-steps");
  });

  it("returns null when budget is not exceeded", async () => {
    const engine = PolicyEngine.create({ clock: Date.now });
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
        PolicyEngine.create({ clock: Date.now }),
        makeConfig({ events: collected, budget: { maxTurns: 24 } }),
        agentBase,
      );
    } finally {
      unsubscribe();
    }

    expect(collected.named(Operational.Events.Warn.name)).toHaveLength(1);
    expect(busSaw).toEqual([]);
  });
});
