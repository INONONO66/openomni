import { describe, expect, test } from "bun:test";
import { canonicalDigest, type PlainValue, RowVerdict, PolicyRow } from "@openomni/protocol";
import {
  compilePolicySnapshot,
  createNamedPolicyRegistry,
  createPolicyCompiler,
  KERNEL_POLICY_REGISTRY,
  NamedPolicyRegistryError,
  PolicyCompileError,
  SEEDED_POLICY_ROWS,
} from "../src/index";
import { atGeneration, compaction, draft, MemoryPolicyRows } from "./row-fixtures";

const input = {
  kind: "tool",
  phase: "pre",
  op: "bash",
  value: { secret: "original", keep: true },
} as const;

describe("immutable named policy registry", () => {
  test("copy-on-write append emits refs while retaining historical generation bytes", async () => {
    const source = new MemoryPolicyRows([
      atGeneration(compaction, 1),
      atGeneration(
        draft("redact", "tool", "pre", { type: "transform", name: "redact", paths: ["secret"] }),
        1,
      ),
    ]);
    const bytes = JSON.stringify(source.rows(1));
    const compiler = createPolicyCompiler({ source, registry: KERNEL_POLICY_REGISTRY });
    const before = compiler.pin(1);
    const generation = await compiler.append([]);
    expect(generation).toBe(2);
    expect(source.rows(2).find((row) => row.name === "redact")?.verdict.value).toEqual({
      type: "transform",
      ref: "kernel/redact",
      config: { paths: ["secret"] },
    });
    expect(JSON.stringify(source.rows(1))).toBe(bytes);
    expect(compiler.pin(2).evaluate(input).value).toEqual(before.evaluate(input).value);
    expect(compiler.pin(2).contentHash).not.toBe(before.contentHash);
  });

  test.each([
    "transform",
    "obligation",
  ] as const)("missing %s refs fail typed before execution", (type) => {
    const verdict: PlainValue =
      type === "transform"
        ? { type, ref: "demo/missing" }
        : { type, ref: "demo/missing", metric: "fanout", limit: 2 };
    try {
      compilePolicySnapshot({
        generation: 7,
        registry: KERNEL_POLICY_REGISTRY,
        rows: [
          atGeneration(compaction, 7),
          atGeneration(draft("missing", "tool", "pre", verdict), 7),
        ],
      });
      throw new Error("compile unexpectedly succeeded");
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyCompileError);
      if (!(error instanceof PolicyCompileError)) throw error;
      expect(error.data).toMatchObject({
        code: type === "transform" ? "unknown_transformer" : "unknown_obligation",
        generation: 7,
        ruleName: "missing",
        ref: "demo/missing",
      });
    }
  });

  test("ordered transforms capture copied implementations and deeply immutable configuration", () => {
    const transformer = {
      name: "demo/wrap",
      apply: (args: PlainValue, config: PlainValue): PlainValue => ({ args, config }),
    };
    const transformers = [transformer];
    const registry = createNamedPolicyRegistry({ transformers, obligations: [] });
    const config = { nested: ["first"] };
    const rows = [
      atGeneration(compaction, 1),
      atGeneration(
        draft(
          "a",
          "tool",
          "pre",
          { type: "transform", ref: transformer.name, config },
          { priority: 20 },
        ),
        1,
      ),
      atGeneration(
        draft("b", "tool", "pre", { type: "transform", ref: transformer.name }, { priority: 10 }),
        1,
      ),
    ];
    const snapshot = compilePolicySnapshot({ generation: 1, registry, rows });
    const reverse = compilePolicySnapshot({ generation: 1, registry, rows: [...rows].reverse() });
    transformer.apply = () => "wrong";
    transformers.length = 0;
    config.nested[0] = "changed";
    const evaluation = snapshot.evaluate(input);
    expect(evaluation.value).toEqual({
      args: { args: input.value, config: { nested: ["first"] } },
      config: null,
    });
    expect(evaluation.transforms).toEqual([
      { ruleId: "a", ref: "demo/wrap" },
      { ruleId: "b", ref: "demo/wrap" },
    ]);
    expect(evaluation).not.toHaveProperty("ref");
    expect(reverse.contentHash).toBe(snapshot.contentHash);
    expect(reverse.evaluate(input)).toEqual(evaluation);
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.transformers)).toBe(true);
    expect(Object.isFrozen(registry.transformers[0])).toBe(true);
  });

  test("historic bytes hash unchanged and reopen executes the sole kernel redactor", () => {
    const rows = [
      atGeneration(compaction, 1),
      atGeneration(
        draft("redact", "tool", "pre", { type: "transform", name: "redact", paths: ["secret"] }),
        1,
      ),
    ];
    const bytes = JSON.stringify(rows);
    const snapshot = compilePolicySnapshot({
      generation: 1,
      registry: KERNEL_POLICY_REGISTRY,
      rows,
    });
    const identity = rows
      .map(({ generation: _generation, ...row }) => row)
      .sort((a, b) => a.name.localeCompare(b.name));
    expect(snapshot.contentHash).toBe(canonicalDigest(identity));
    expect(snapshot.evaluate(input)).toMatchObject({
      ref: "kernel/redact",
      transforms: [{ ruleId: "redact", ref: "kernel/redact" }],
      value: { keep: true },
    });
    expect(
      compilePolicySnapshot({
        generation: 1,
        registry: KERNEL_POLICY_REGISTRY,
        rows: PolicyRow.Row.array().parse(JSON.parse(bytes)),
      }).evaluate(input),
    ).toEqual(snapshot.evaluate(input));
    expect(JSON.stringify(rows)).toBe(bytes);
    expect(input.value.secret).toBe("original");
  });

  test("registry rejects duplicate and invalid names without freezing caller data", () => {
    const transformer = { name: "demo/id", apply: (args: PlainValue) => args };
    expect(() =>
      createNamedPolicyRegistry({ transformers: [transformer, transformer], obligations: [] }),
    ).toThrow(NamedPolicyRegistryError);
    expect(() =>
      createNamedPolicyRegistry({
        transformers: [{ ...transformer, name: "invalid" }],
        obligations: [],
      }),
    ).toThrow(NamedPolicyRegistryError);
    expect(() =>
      createNamedPolicyRegistry({
        transformers: [],
        obligations: [{ name: "demo/cap" }, { name: "demo/cap" }],
      }),
    ).toThrow(NamedPolicyRegistryError);
    expect(Object.isFrozen(transformer)).toBe(false);
  });

  test("transform implementations receive frozen captured config rather than caller-owned objects", () => {
    const frozen: boolean[] = [];
    const registry = createNamedPolicyRegistry({
      transformers: [
        {
          name: "demo/observe",
          apply: (args, config) => {
            frozen.push(Object.isFrozen(config));
            if (config !== null && typeof config === "object" && !Array.isArray(config))
              frozen.push(Object.isFrozen(config.nested));
            return args;
          },
        },
      ],
      obligations: [],
    });
    const config = { nested: [1] };
    const snapshot = compilePolicySnapshot({
      generation: 1,
      registry,
      rows: [
        atGeneration(compaction, 1),
        atGeneration(
          draft("freeze", "tool", "pre", { type: "transform", ref: "demo/observe", config }),
          1,
        ),
      ],
    });
    snapshot.evaluate(input);
    expect(frozen).toEqual([true, true]);
    expect(Object.isFrozen(config)).toBe(false);
    expect(Object.isFrozen(config.nested)).toBe(false);
  });

  test("historical seeded budgets reopen with identical named obligations", () => {
    const historical = SEEDED_POLICY_ROWS.map((row) => {
      const verdict = RowVerdict.parse(row.verdict.value);
      if (verdict.type !== "obligation") return atGeneration(row, 1);
      return atGeneration(
        {
          ...row,
          verdict: {
            encodingVersion: 1,
            value: {
              type: "obligation",
              name: "budget_clamp",
              metric: verdict.metric,
              limit: verdict.limit,
            },
          },
        },
        1,
      );
    });
    const bytes = JSON.stringify(historical);
    const snapshot = compilePolicySnapshot({
      generation: 1,
      registry: KERNEL_POLICY_REGISTRY,
      rows: PolicyRow.Row.array().parse(JSON.parse(bytes)),
    });
    expect(
      snapshot.evaluate({ ...input, kind: "turn", phase: "post", op: "continue" }).obligations,
    ).toEqual([{ ref: "kernel/budget-clamp", metric: "continuation", limit: 8 }]);
    expect(snapshot.evaluate({ ...input, op: "send_message" }).obligations).toEqual([
      { ref: "kernel/budget-clamp", metric: "fanout", limit: 8 },
    ]);
    expect(JSON.stringify(historical)).toBe(bytes);
  });
});
