import { describe, expect, it } from "bun:test";
import { RUN_POINT, runMachine } from "../../../src/core/execution/run-machine";

describe("the run machine", () => {
  it("starts unopened and refuses to be read as settled", () => {
    const machine = runMachine();
    expect(machine.tag()).toBe("opening");
    expect(() => machine.assertSettled()).toThrow("without reaching a terminal");
  });

  it("refuses an edge the table does not have", () => {
    const machine = runMachine();
    expect(() => machine.to("settling")).toThrow("cannot move from opening to settling");
    expect(machine.tag()).toBe("opening");
  });

  /**
   * The property the row exists for: a terminal has no outgoing edges, so a
   * run cannot end twice and cannot resume after ending.
   */
  it("has no way out of a terminal", () => {
    for (const terminal of ["completed", "failed"] as const) {
      const machine = runMachine();
      machine.to(terminal);
      machine.assertSettled();
      expect(() => machine.to("turn_start")).toThrow(`cannot move from ${terminal}`);
      expect(() => machine.to(terminal)).toThrow(`cannot move from ${terminal}`);
    }
  });

  it("walks the ordinary run", () => {
    const machine = runMachine();
    for (const tag of ["pre_run", "turn_start", "awaiting_model", "settling"] as const) {
      machine.to(tag);
      expect(machine.tag()).toBe(tag);
    }
    machine.to("turn_start");
    machine.to("completed");
    machine.assertSettled();
  });

  it("names the point dispatched in each non-terminal tag it guards", () => {
    expect(RUN_POINT).toEqual({
      pre_run: "run.lifecycle.pre",
      turn_start: "run.turn.pre",
      awaiting_model: "connection.llm.pre",
      settling: "run.turn.post",
      retrying: "run.error.error",
    });
  });
});
