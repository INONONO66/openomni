import { describe, expect, it } from "bun:test";
import { compileGateRows, type GateHandler } from "../src/kernel/gate/compose";
import { fullPointTable, gateRow } from "./helpers/gate-rows";

const table = fullPointTable();

describe("requirement guard (#1251)", () => {
  it("resolves a row's own declared service through the guard", () => {
    const handler: GateHandler = (input) => input.service("guard/self")(input);
    const inner: GateHandler = () => ({ verdict: "allow", payload: { via: "self" } });
    const gate = compileGateRows({
      table,
      rows: [gateRow("tool.pre", { how: { ref: "guard/self" } })],
      handlers: ["guard/self"],
      generation: 1,
    });
    let outer = true;
    const { decision } = gate.decide(
      "tool.pre",
      { when: {}, value: null },
      {
        handlers: (ref) => {
          if (ref !== "guard/self") return undefined;
          if (outer) {
            outer = false;
            return handler;
          }
          return inner;
        },
      },
    );
    expect(decision.verdict).toBe("allow");
    expect(decision.facts).toEqual([]);
    expect(decision.consulted.map((entry) => entry.payload)).toEqual([{ via: "self" }]);
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
