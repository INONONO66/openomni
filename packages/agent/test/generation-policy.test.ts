import { expect, test } from "bun:test";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import { createNamedPolicyRegistry, createPolicyCompiler, SEEDED_POLICY_ROWS } from "@openomni/policy";
import type { LedgerAction, PlainValue } from "@openomni/protocol";
import { Effect, Layer } from "effect";
import { z } from "zod";
import { bundle, BundleDefinitions, bundlePolicyTag, BundlesLive, NamedPolicyRegistry, type BundleRow } from "../src/bundle";
import { makeSessionGenerations } from "../src/session-generations";
import { Clock, Entropy, ObservationSink, SessionLayer, ToolCatalog } from "../src/services";
import { createTurnDispatcher, defineTool, sessionTool } from "../src/tool-dispatcher";
import { createObservationBus } from "../src/observation/bus";
import { isolated } from "./helpers/isolated";
import { effectValue, fiberSessionId, nativeExecutorOptions } from "./helpers/native-executor";
import { sessionTree } from "../../ledger/test/helpers/session-tree";

function policyRow(name: string, verdict: PlainValue, priority = 100): BundleRow {
  return { name, kind: "tool", phase: "pre", priority,
    match: { encodingVersion: 1, value: { op: "demo__echo" } },
    verdict: { encodingVersion: 1, value: verdict } };
}

function generationFixture(rows: readonly BundleRow[], bodies: PlainValue[]) {
  return Effect.gen(function* () {
    const Policy = bundlePolicyTag("demo");
    const Input = z.object({ value: z.string(), secret: z.string().optional() });
    const tool = defineTool({
      name: "demo__echo", description: "echo", category: "query", input: Input, output: z.string(),
      visibility: { model: ["resident"], cell: ["resident"] },
      execute: async (input: z.infer<typeof Input>) => { bodies.push(input); return input.value; },
      render: (_input: z.infer<typeof Input>, value: string) => value,
    });
    const PolicyLive = Layer.succeed(Policy, createNamedPolicyRegistry({
      transformers: [{ name: "demo/replace", apply: (_input: PlainValue, config: PlainValue) => config }],
      obligations: [{ name: "demo/cap" }],
    }));
    const demo = bundle({ name: "demo", provides: [Policy], requires: [], tools: [tool], rows, layer: PolicyLive });
    const definitions = yield* BundleDefinitions.pipe(Effect.provide(BundlesLive([demo])));
    const selected = definitions.select(["demo"]);
    const source = Storage.get().policies;
    if (source === undefined) return yield* Effect.die("missing policies");
    const policyGeneration = source.appendGeneration(() => [...SEEDED_POLICY_ROWS, ...selected.rows]);
    const snapshot = SessionHandleStore.generationSnapshot({
      generation: 1, revertTo: 0, policyGeneration, bundles: selected.names,
      tools: selected.tools.map(sessionTool), system: { preset: "", blocks: [] },
    });
    const seed = Layer.mergeAll(
      Layer.succeed(Clock, yield* Clock), Layer.succeed(Entropy, yield* Entropy),
      Layer.succeed(ToolCatalog, { definitions: selected.tools }),
      Layer.succeed(ObservationSink, createObservationBus()),
    );
    const layer = Layer.effect(SessionLayer, Effect.gen(function* () {
      const registry = yield* NamedPolicyRegistry;
      return { snapshot, policy: createPolicyCompiler({ registry, source }).pin(policyGeneration) };
    })).pipe(Layer.provideMerge(selected.layer.pipe(Layer.provideMerge(seed))));
    const owner = yield* makeSessionGenerations({ id: { sessionId: fiberSessionId, generation: 1 }, snapshot, layer, activate: Effect.void });
    return yield* owner.capture();
  });
}

function dispatch(rows: readonly BundleRow[], bodies: PlainValue[]) {
  return Effect.gen(function* () {
    const options = yield* nativeExecutorOptions();
    const captured = yield* generationFixture(rows, bodies);
    return yield* captured.provide(Effect.gen(function* () {
      const { policy } = yield* SessionLayer;
      const dispatcher = yield* createTurnDispatcher({
        ...options.identity, actionId: options.identity.turnId, ledger: options.ledger,
        tools: captured.snapshot.tools, toolsGeneration: captured.snapshot.generation,
        toolsHash: captured.snapshot.toolsHash,
      }, {});
      const result = yield* dispatcher.execute({ id: "call", tool: "demo__echo", input: { value: "original", secret: "secret" } },
        { sessionId: fiberSessionId, turnId: options.identity.turnId });
      return { result, policy };
    }));
  });
}

test("captured bundle data resolves custom transforms and obligations alongside kernel refs", () => isolated(Effect.scoped(Effect.gen(function* () {
  const bodies: PlainValue[] = [];
  const { result, policy } = yield* dispatch([
    policyRow("demo/replace-row", { type: "transform", ref: "demo/replace", config: { value: "bundle", secret: "hidden" } }, 300),
    policyRow("demo/redact-row", { type: "transform", ref: "kernel/redact", config: { paths: ["secret"] } }, 200),
    policyRow("demo/cap-row", { type: "obligation", ref: "demo/cap", metric: "fanout", limit: 2 }),
  ], bodies);
  expect(result).toMatchObject({ toolCallId: "call", output: "bundle" });
  expect(bodies).toEqual([{ value: "bundle" }]);
  expect(policy.evaluate({ kind: "tool", phase: "pre", op: "demo__echo", value: {} }).obligations)
    .toEqual([{ ref: "demo/cap", metric: "fanout", limit: 2 }]);
  expect(policy.evaluate({ kind: "turn", phase: "post", op: "continue", value: {} }).obligations)
    .toEqual([{ ref: "kernel/budget-clamp", metric: "continuation", limit: 8 }]);
}))));

for (const type of ["transform", "obligation"] as const) {
  test(`unresolved bundle ${type} ref denies at pinned pre before a tool body runs`, () => isolated(Effect.scoped(Effect.gen(function* () {
    const bodies: PlainValue[] = [];
    const verdict: PlainValue = type === "transform" ? { type, ref: "demo/missing" }
      : { type, ref: "demo/missing", metric: "fanout", limit: 2 };
    const { result, policy } = yield* dispatch([policyRow("demo/missing-row", verdict)], bodies);
    expect(result).toMatchObject({ toolCallId: "call", id: "call", isError: true, errorKind: "precondition_failed" });
    expect(bodies).toEqual([]);
    expect(policy.evaluate({ kind: "tool", phase: "pre", value: {} })).toMatchObject({
      verdict: "deny", reason: "unknown_ref", error: { code: "unknown_ref", ref: "demo/missing" },
    });
    const tree = sessionTree(fiberSessionId);
    const decisions = tree.filter((action: LedgerAction.Node) => action.kind === "policy.decision");
    expect(decisions.map(effectValue)).toMatchObject([{ terminal: "blocked_pre", reason: "unknown_ref" }]);
    expect(tree.filter((action: LedgerAction.Node) => action.kind === "tool")).toEqual([]);
  }))));
}
