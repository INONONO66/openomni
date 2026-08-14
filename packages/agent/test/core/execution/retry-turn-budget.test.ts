import { describe, expect, it } from "bun:test";
import {
  advanceRunTurn,
  createRunState,
  recordRunTurn,
} from "../../../src/core/execution/run-state";
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
