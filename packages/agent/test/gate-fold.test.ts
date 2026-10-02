import { describe, expect, it } from "bun:test";
import { canonicalDigest, emittedRowKey } from "@openomni/protocol";
import { compileGateRows, type GateHandler } from "../src/kernel/gate/compose";
import { fullPointTable, gateRow } from "./helpers/gate-rows";

const table = fullPointTable();

describe("gate decision fold (#1251)", () => {
  it("folds deny > require_approval > allow and records every matched row id in order", () => {
    const gate = compileGateRows({
      table,
      rows: [
        gateRow("tool.pre", { id: "a/tool.pre#1", order: 1, how: { verdict: "allow" } }),
        gateRow("tool.pre", { id: "c/tool.pre#3", order: 3, how: { verdict: "deny" } }),
        gateRow("tool.pre", { id: "b/tool.pre#2", order: 2, how: { verdict: "require_approval" } }),
      ],
      handlers: [],
      generation: 7,
    });
    const { decision } = gate.decide("tool.pre", { when: {}, value: { op: "read" } });
    expect(decision.verdict).toBe("deny");
    expect(decision.rowIds).toEqual(["a/tool.pre#1", "b/tool.pre#2", "c/tool.pre#3"]);
    expect(decision.generation).toBe(7);
  });

  it("require_approval beats allow when nothing denies", () => {
    const gate = compileGateRows({
      table,
      rows: [
        gateRow("tool.pre", { how: { verdict: "require_approval" } }),
        gateRow("tool.pre", { how: { verdict: "allow" } }),
      ],
      handlers: [],
      generation: 1,
    });
    expect(gate.decide("tool.pre", { when: {}, value: null }).decision.verdict).toBe(
      "require_approval",
    );
  });

  it("matches rows on their `when` fields only", () => {
    const gate = compileGateRows({
      table,
      rows: [gateRow("tool.pre", { when: { op: "write" }, how: { verdict: "deny" } })],
      handlers: [],
      generation: 1,
    });
    expect(gate.decide("tool.pre", { when: { op: "read" }, value: null }).decision.verdict).toBe(
      "allow",
    );
    const matched = gate.decide("tool.pre", { when: { op: "write" }, value: null }).decision;
    expect(matched.verdict).toBe("deny");
    expect(matched.rowIds).toHaveLength(1);
  });

  it("records consulted handler payloads with their digests", () => {
    const payload = { risk: "low", checked: ["path"] };
    const handler: GateHandler = () => ({ verdict: "allow", payload });
    const gate = compileGateRows({
      table,
      rows: [gateRow("tool.pre", { how: { ref: "guard/scan" } })],
      handlers: ["guard/scan"],
      generation: 1,
    });
    const { decision } = gate.decide(
      "tool.pre",
      { when: {}, value: null },
      { handlers: () => handler },
    );
    expect(decision.consulted).toEqual([
      { ref: "guard/scan", digest: canonicalDigest(payload), payload },
    ]);
  });

  it("applies rewrites in row order, each over the prior output, to declared fields only", () => {
    const upgrade: GateHandler = (input) => {
      const value = input.value as { model: string };
      return { value: { model: `${value.model}+a`, extra: "dropped" }, payload: { step: "a" } };
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
    const outcome = gate.decide(
      "llm.pre",
      { when: {}, value: { model: "base", temperature: 0.2 } },
      { handlers: (ref) => handlers.get(ref) },
    );
    expect(outcome.value).toEqual({ model: "base+a+b", temperature: 0.2 });
    expect(outcome.decision.consulted.map((entry) => entry.payload)).toEqual([
      { step: "a" },
      { step: "b" },
    ]);
  });

  it("folds obligations and journals emit rows under deterministic idempotency keys", () => {
    const gate = compileGateRows({
      table,
      rows: [
        gateRow("turn.post", { how: { verdict: "allow", metric: "continuations", limit: 8 } }),
        gateRow("compaction.pre", {
          id: "janitor/compaction.pre#1",
          do: "emit",
          how: { emit: "message", intent: { body: "compacting" } },
        }),
      ],
      handlers: [],
      generation: 1,
    });
    const post = gate.decide("turn.post", { when: {}, value: null }).decision;
    expect(post.obligations).toEqual([{ metric: "continuations", limit: 8 }]);

    const outcome = gate.decide("compaction.pre", { when: {}, value: null });
    expect(outcome.emissions).toEqual([
      {
        key: emittedRowKey(outcome.decision.inputHash, "janitor/compaction.pre#1", 0),
        kind: "message",
        rowId: "janitor/compaction.pre#1",
        intent: { body: "compacting" },
      },
    ]);
  });
});
