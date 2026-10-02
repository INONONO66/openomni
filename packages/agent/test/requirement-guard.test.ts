import { describe, expect, it } from "bun:test";
import { compileGateRows, type GateHandler } from "../src/kernel/gate/compose";
import { fullPointTable, gateRow } from "./helpers/gate-rows";

const table = fullPointTable();

describe("requirement guard (#1251)", () => {
  it("resolves the row's declared service through a stable registry (#1251 r1)", () => {
    // The resolver is stable: the same ref always returns the same handler,
    // as a production registry would. The handler re-enters itself through
    // the guard, proving the declared requirement resolves at call time.
    let depth = 0;
    const self: GateHandler = (input) => {
      depth += 1;
      if (depth > 1) return { verdict: "allow", payload: { via: "self", depth } };
      return input.service("guard/self")(input);
    };
    const handlers = new Map<string, GateHandler>([["guard/self", self]]);
    const gate = compileGateRows({
      table,
      rows: [gateRow("tool.pre", { how: { ref: "guard/self" } })],
      handlers: [...handlers.keys()],
      generation: 1,
    });
    const { decision } = gate.decide(
      "tool.pre",
      { when: {}, value: null },
      { handlers: (ref) => handlers.get(ref) },
    );
    expect(depth).toBe(2);
    expect(decision.verdict).toBe("allow");
    expect(decision.facts).toEqual([]);
    expect(decision.consulted.map((entry) => entry.payload)).toEqual([{ via: "self", depth: 2 }]);
  });

  it("records a dynamic reference escaping the declared requires as a fact and fails closed", () => {
    const escaping: GateHandler = (input) => {
      input.service("other/secrets");
      return { verdict: "allow", payload: { reached: true } };
    };
    const other: GateHandler = () => ({ verdict: "allow", payload: { leaked: true } });
    const handlers = new Map<string, GateHandler>([
      ["guard/escaping", escaping],
      ["other/secrets", other],
    ]);
    const gate = compileGateRows({
      table,
      rows: [gateRow("tool.pre", { id: "guard/tool.pre#1", how: { ref: "guard/escaping" } })],
      handlers: [...handlers.keys()],
      generation: 1,
    });
    const { decision } = gate.decide(
      "tool.pre",
      { when: {}, value: null },
      { handlers: (ref) => handlers.get(ref) },
    );
    expect(decision.verdict).toBe("deny");
    expect(decision.facts).toEqual([
      { rowId: "guard/tool.pre#1", ref: "other/secrets", code: "requirement_escape" },
    ]);
    // The escaping handler's own response never lands: nothing was consulted.
    expect(decision.consulted).toEqual([]);
  });

  it("fails closed when a row's handler is not resolvable at decision time", () => {
    const gate = compileGateRows({
      table,
      rows: [gateRow("tool.pre", { id: "guard/tool.pre#2", how: { ref: "guard/gone" } })],
      handlers: ["guard/gone"],
      generation: 1,
    });
    const { decision } = gate.decide("tool.pre", { when: {}, value: null }, { handlers: () => undefined });
    expect(decision.verdict).toBe("deny");
    expect(decision.facts).toEqual([
      { rowId: "guard/tool.pre#2", ref: "guard/gone", code: "handler_unavailable" },
    ]);
  });
});
