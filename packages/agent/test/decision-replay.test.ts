import { describe, expect, it } from "bun:test";
import { compileGateRows, type GateHandler } from "../src/kernel/gate/compose";
import { fullPointTable, gateRow } from "./helpers/gate-rows";

const table = fullPointTable();

describe("decision replay (#1251)", () => {
  it("replays a recorded decision for the same input hash without re-running handlers", () => {
    let calls = 0;
    const handler: GateHandler = () => {
      calls += 1;
      return { verdict: "require_approval", payload: { call: calls } };
    };
    const gate = compileGateRows({
      table,
      rows: [gateRow("tool.pre", { how: { ref: "guard/count" } })],
      handlers: ["guard/count"],
      generation: 1,
    });
    const input = { when: { op: "write" }, value: { path: "/etc" } };
    const first = gate.decide("tool.pre", input, { handlers: () => handler });
    expect(first.replayed).toBe(false);
    expect(calls).toBe(1);

    const replay = gate.decide("tool.pre", input, {
      handlers: () => handler,
      recorded: first.decision,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.decision).toEqual(first.decision);
    expect(replay.emissions).toEqual([]);
    expect(calls).toBe(1);
  });

  it("re-decides when the input hash differs from the recorded decision", () => {
    let calls = 0;
    const handler: GateHandler = () => {
      calls += 1;
      return { verdict: "allow", payload: { call: calls } };
    };
    const gate = compileGateRows({
      table,
      rows: [gateRow("tool.pre", { how: { ref: "guard/count" } })],
      handlers: ["guard/count"],
      generation: 1,
    });
    const first = gate.decide("tool.pre", { when: {}, value: { path: "/a" } }, { handlers: () => handler });
    const second = gate.decide(
      "tool.pre",
      { when: {}, value: { path: "/b" } },
      { handlers: () => handler, recorded: first.decision },
    );
    expect(second.replayed).toBe(false);
    expect(second.decision.inputHash).not.toBe(first.decision.inputHash);
    expect(calls).toBe(2);
  });

  it("treats an unrecorded handler response as observe-only: it cannot change the decision", () => {
    const silent: GateHandler = () => ({ verdict: "deny" });
    const gate = compileGateRows({
      table,
      rows: [gateRow("tool.pre", { id: "guard/tool.pre#9", how: { ref: "guard/silent" } })],
      handlers: ["guard/silent"],
      generation: 1,
    });
    const { decision } = gate.decide(
      "tool.pre",
      { when: {}, value: null },
      { handlers: () => silent },
    );
    expect(decision.verdict).toBe("allow");
    expect(decision.consulted).toEqual([]);
    expect(decision.facts).toEqual([
      { rowId: "guard/tool.pre#9", ref: "guard/silent", code: "unrecorded_response" },
    ]);
  });
});
