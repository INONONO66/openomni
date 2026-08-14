import { describe, expect, it } from "bun:test";
import { PolicyDecision } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import {
  advanceRunTurn,
  createRunState,
  recordRunTurn,
} from "../../../src/core/execution/run-state";
import { runAgent } from "../../../src/core/execution/runner";
import {
  createMockLlmConfig,
  createStopOutcome,
  mockProviderData,
  mockProviderModel,
} from "../../helpers/mock-llm";
import { runInput } from "../../helpers/run-input";

/**
 * A retried attempt is the same turn, tried again.
 *
 * `buildTurn` charges the turn budget before the model call, and the runner
 * re-enters `buildTurn` on retry without advancing `turnIndex` — so charging
 * per entry let a transient provider error eat headroom an operator sized in
 * turns of work. Instrumenting `recordRunTurn` on a run whose first model call
 * throws showed two charges at `turnIndex=0`, taking `turns` to 2 for one turn
 * of work.
 */
describe("turn budget across retries", () => {
  it("charges a turn once however many attempts it takes", () => {
    const state = createRunState(runInput([{ role: "user", content: "hi" }]));

    recordRunTurn(state);
    expect(state.budgetState.turns).toBe(1);

    // The retry: same turn, re-entered.
    recordRunTurn(state);
    recordRunTurn(state);
    expect(state.budgetState.turns).toBe(1);
  });

  it("charges again once the run moves to the next turn", () => {
    const state = createRunState(runInput([{ role: "user", content: "hi" }]));

    recordRunTurn(state);
    advanceRunTurn(state);
    recordRunTurn(state);
    recordRunTurn(state);

    expect(state.budgetState.turns).toBe(2);
  });
});

/**
 * The same fact through a real run. `run.lifecycle.post` fires once, from
 * `dispatchPostRunTransform`, after every charge — so it reads the run's total.
 *
 * This is the case #630's first attempt wrongly concluded could not exist: that
 * harness never let the retry succeed, so `handleStop` never ran and the only
 * `run.lifecycle.post` came from mid-run. It is also the only guard on the
 * runner's call site — resetting `chargedTurnIndex` in the retry branch leaves
 * the two unit cases above green.
 */
describe("turn budget across retries, through a run", () => {
  it("reports one turn for a run whose first attempt failed", async () => {
    let calls = 0;
    const postRunTurnCounts: unknown[] = [];

    const result = await runAgent(runInput([{ role: "user", content: "hi" }]), {
      events: Bus,
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      middleware: [
        {
          kind: "point",
          name: "test:no-backoff",
          pointIds: ["run.error.error"],
          effectCapabilities: { "run.error.error": ["run.retry_after"] },
          priority: 0,
          fn: () =>
            PolicyDecision.allow({
              policyId: "test.no-backoff",
              effects: [{ type: "run.retry_after", delayMs: 0 }],
            }),
        },
        {
          kind: "point",
          name: "test:post-run-observer",
          pointIds: ["run.lifecycle.post"],
          effectCapabilities: { "run.lifecycle.post": [] },
          priority: 0,
          fn: (ctx) => {
            postRunTurnCounts.push(Reflect.get(ctx, "turnCount"));
            return PolicyDecision.allow({ policyId: "test.post-run-observer" });
          },
        },
      ],
      llm: createMockLlmConfig({
        getModels: async () => mockProviderData,
        fromModelsDevModel: () => mockProviderModel,
        run: async () => {
          calls += 1;
          if (calls === 1) throw new Error("transient provider hiccup");
          return createStopOutcome();
        },
      }),
    });

    expect(calls).toBe(2);
    expect(result.finishReason).toBe("stop");
    expect(postRunTurnCounts).toEqual([1]);
  });
});
