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

  it("replay restores the recorded rewrite output without re-running the rewriter (#1251 r1)", () => {
    let calls = 0;
    const rewriter: GateHandler = () => {
      calls += 1;
      return { value: { model: "safe-model" }, payload: { rewrote: true } };
    };
    const gate = compileGateRows({
      table,
      rows: [gateRow("llm.pre", { do: "rewrite", how: { ref: "rewrite/model", fields: ["model"] } })],
      handlers: ["rewrite/model"],
      generation: 1,
    });
    const input = { when: {}, value: { model: "raw", temperature: 1 } };
    const first = gate.decide("llm.pre", input, { handlers: () => rewriter });
    expect(first.value).toEqual({ model: "safe-model", temperature: 1 });
    expect(first.decision.output).toEqual({ model: "safe-model", temperature: 1 });
    expect(calls).toBe(1);

    // Replay has no handler available at all: the recorded output must carry.
    const replay = gate.decide("llm.pre", input, {
      handlers: () => undefined,
      recorded: first.decision,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.value).toEqual({ model: "safe-model", temperature: 1 });
    expect(calls).toBe(1);
  });

  it("replay of chained rewrites restores the final folded value and untouched fields (#1251 r1)", () => {
    const upgrade: GateHandler = (input) => {
      const value = input.value as { model: string };
      return { value: { model: `${value.model}+a` }, payload: { step: "a" } };
    };
    const suffix: GateHandler = (input) => {
      const value = input.value as { model: string };
      return { value: { model: `${value.model}+b` }, payload: { step: "b" } };
    };
    const handlers = new Map<string, GateHandler>([
      ["rewrite/upgrade", upgrade],
      ["rewrite/suffix", suffix],
    ]);
    const gate = compileGateRows({
      table,
      rows: [
        gateRow("llm.pre", { order: 1, do: "rewrite", how: { ref: "rewrite/upgrade", fields: ["model"] } }),
        gateRow("llm.pre", { order: 2, do: "rewrite", how: { ref: "rewrite/suffix", fields: ["model"] } }),
      ],
      handlers: [...handlers.keys()],
      generation: 1,
    });
    const input = { when: {}, value: { model: "base", temperature: 0.2 } };
    const first = gate.decide("llm.pre", input, { handlers: (ref) => handlers.get(ref) });
    expect(first.value).toEqual({ model: "base+a+b", temperature: 0.2 });

    const replay = gate.decide("llm.pre", input, {
      handlers: () => undefined,
      recorded: first.decision,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.value).toEqual({ model: "base+a+b", temperature: 0.2 });
    expect(replay.decision).toEqual(first.decision);
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
