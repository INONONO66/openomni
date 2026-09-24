import { isolated } from "./helpers/isolated";
import { expect, test } from "bun:test";
import type { PlainValue, PolicyRow } from "@openomni/protocol";
import { Context, Effect, Exit, Layer } from "effect";
import { z } from "zod";
import { bundle, BundleDefinitions, bundlePolicyTag, BundlesLive, compose, NamedPolicyRegistry } from "../src/bundle";
import { BundleError } from "../src/errors";
import { createObservationBus } from "../src/observation/bus";
import { Clock, Entropy, ObservationSink, ToolCatalog } from "../src/services";

class NumberService extends Context.Tag("@openomni/bundle/number/Value")<NumberService, number>() {}
class TextService extends Context.Tag("@openomni/bundle/text/Value")<TextService, string>() {}
const NumberLive = Layer.succeed(NumberService, 7);
const numberBundle = () => bundle({ name: "number", requires: [], provides: [NumberService], layer: NumberLive });
const seed = { provides: [], requires: [], layer: Layer.empty } as const;
// Deliberately corrupt a genuine provider at the runtime boundary, without lying
// to TypeScript about Layer.empty's output or casting an erased Context.
function missingNumberContext() {
  const context = Context.make(NumberService, 7);
  context.unsafeMap.delete(NumberService.key);
  return context;
}
const row: Omit<PolicyRow.Row, "generation"> = { name: "number/allow", kind: "tool", phase: "pre", priority: 1, match: { encodingVersion: 1, value: {} }, verdict: { encodingVersion: 1, value: { type: "allow" } } };
const tool = { name: "number__echo", description: "echo", category: "query", input: z.string(), output: z.string(), visibility: { model: ["resident"], cell: [] }, execute: async (value: string) => value, render: (value: string) => value } as const;

test("ordered acquisition supplies earlier outputs and releases observers before providers", async () => {
  const events: string[] = [];
  const FirstLive = Layer.scoped(NumberService, Effect.acquireRelease(Effect.sync(() => { events.push("number+"); return 7; }), () => Effect.sync(() => { events.push("number-"); })));
  const first = bundle({ name: "number", provides: [NumberService], requires: [], layer: FirstLive });
  const TextLive = Layer.scoped(TextService, Effect.gen(function* () { const value = yield* NumberService; return yield* Effect.acquireRelease(Effect.sync(() => { events.push("text+"); return `${value}x`; }), () => Effect.sync(() => { events.push("text-"); })); }));
  const second = bundle({ name: "text", provides: [TextService], requires: [NumberService], layer: TextLive });
  const ObserverLive = Layer.scopedDiscard(Effect.gen(function* () { const value = yield* TextService; yield* Effect.acquireRelease(Effect.sync(() => { events.push(value); }), () => Effect.sync(() => { events.push("observer-"); })); }));
  const observer = bundle({ name: "observer", provides: [], requires: [TextService], layer: ObserverLive });
  const result = await isolated(Effect.gen(function* () { return [yield* NumberService, yield* TextService]; }).pipe(Effect.provide(compose(seed, [first, second, observer]))));
  expect(result).toEqual([7, "7x"]);
  expect(events).toEqual(["number+", "text+", "7x", "observer-", "text-", "number-"]);
});

test.each(["Bad", "a_b", "a/evil", "", "0name"])("rejects invalid namespace %s", (name) => {
  expect(() => bundle({ name, requires: [], provides: [], layer: Layer.empty })).toThrow(BundleError);
});

test("rejects duplicate Tag keys, wrong namespaces and kernel collisions", () => {
  const alias = Context.GenericTag<NumberService, number>(NumberService.key);
  expect(() => bundle({ name: "number", requires: [], provides: [NumberService, alias], layer: NumberLive })).toThrow(BundleError);
  expect(() => bundle({ name: "wrong", requires: [], provides: [NumberService], layer: NumberLive })).toThrow(BundleError);
  const ClockLive = Layer.succeed(Clock, { now: () => 1 });
  expect(() => bundle({ name: "clock", requires: [], provides: [Clock], layer: ClockLive })).toThrow(BundleError);
});

test("rejects repeated and self requirements", () => {
  const TextLive = Layer.effect(TextService, Effect.map(NumberService, String));
  expect(() => bundle({ name: "text", requires: [NumberService, NumberService], provides: [TextService], layer: TextLive })).toThrow(BundleError);
  const SelfLive = Layer.effect(NumberService, NumberService);
  expect(() => bundle({ name: "number", requires: [NumberService], provides: [NumberService], layer: SelfLive })).toThrow(BundleError);
});

test("rejects nested service paths and requirements outside the four-service seed", () => {
  const Nested = Context.GenericTag<{ readonly nested: true }, number>("@openomni/bundle/nested/extra/Value");
  const NestedLive = Layer.succeed(Nested, 1);
  expect(() => bundle({ name: "nested", requires: [], provides: [Nested], layer: NestedLive })).toThrow(BundleError);
  const Control = Context.GenericTag<{ readonly control: true }, number>("@openomni/ledger/Control");
  const ObserverLive = Layer.scopedDiscard(Effect.asVoid(Control));
  expect(() => bundle({ name: "observer", requires: [Control], provides: [], layer: ObserverLive })).toThrow(BundleError);
});

test("runtime forged Tag identities fail definition validation", () => {
  expect(() => Reflect.apply(bundle, undefined, [{ name: "number", requires: [], provides: [{ key: NumberService.key, _op: "Tag" }], layer: NumberLive }])).toThrow(BundleError);
});

test("seed missing output fails without starting a dependent observer", async () => {
  const observed: number[] = [];
  const MissingSeed = Layer.effectContext(Effect.sync(missingNumberContext));
  const ObserverLive = Layer.scopedDiscard(Effect.flatMap(NumberService, (value) => Effect.sync(() => { observed.push(value); })));
  const observer = bundle({ name: "observer", requires: [NumberService], provides: [], layer: ObserverLive });
  const exit = await isolated(Effect.exit(Effect.scoped(Layer.build(compose({ requires: [], provides: [NumberService], layer: MissingSeed }, [observer])))));
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("missing_output");
  expect(observed).toEqual([]);
});

test("defects and interruption remain causes rather than acquisition failures", async () => {
  const DefectLive = Layer.scopedDiscard(Effect.die("bundle-defect"));
  const InterruptLive = Layer.scopedDiscard(Effect.interrupt);
  for (const layer of [DefectLive, InterruptLive]) {
    const definition = bundle({ name: "broken", requires: [], provides: [], layer });
    const exit = await isolated(Effect.exit(Effect.scoped(Layer.build(compose(seed, [definition])))));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(String(exit.cause)).not.toContain("acquisition");
  }
});

test("policy contributions reject wrong namespaces duplicates and malformed services", async () => {
  const Policy = bundlePolicyTag("policy");
  for (const policy of [
    { transformers: [{ name: "foreign/identity", apply: (value: PlainValue) => value }], obligations: [] },
    { transformers: [], obligations: [{ name: "policy/budget" }, { name: "policy/budget" }] },
  ]) {
    const PolicyLive = Layer.succeed(Policy, policy);
    const definition = bundle({ name: "policy", requires: [], provides: [Policy], layer: PolicyLive });
    const exit = await isolated(Effect.exit(Effect.scoped(Layer.build(compose(seed, [definition])))));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("policy");
  }
});

test("selection preserves installed order and rejects omitted dependencies", async () => {
  const TextLive = Layer.effect(TextService, Effect.map(NumberService, String));
  const second = bundle({ name: "text", provides: [TextService], requires: [NumberService], layer: TextLive });
  const first = bundle({ name: "number", provides: [NumberService], requires: [], layer: NumberLive, tools: [tool], rows: [row], events: [{ ns: "number.changed", version: 1 }] });
  const definitions = await isolated(BundleDefinitions.pipe(Effect.provide(BundlesLive([first, second]))));
  expect(() => definitions.select(["text"])).toThrow(BundleError);
  const selection = definitions.select(["text", "number"]);
  expect(selection.names).toEqual(["number", "text"]);
  expect(selection.tools.map((entry) => entry.name)).toEqual(["number__echo"]);
  expect(selection.rows.map((entry) => entry.name)).toEqual(["number/allow"]);
  expect(selection.events).toEqual([{ ns: "number.changed", version: 1 }]);
  expect(definitions.select([]).names).toEqual([]);
});

test("copies and freezes metadata without freezing callers", () => {
  const event = { ns: "number.changed", version: 1 };
  const originalRow = structuredClone(row);
  const events = [event];
  const rows = [originalRow];
  const tools = [{ ...tool, visibility: { model: ["resident" as const], cell: [] } }];
  const definition = bundle({ name: "number", requires: [], provides: [NumberService], layer: NumberLive, rows, tools, events });
  Object.assign(event, { ns: "foreign.changed" });
  Object.assign(originalRow.verdict, { value: { type: "deny" } });
  tools[0]?.visibility.model.push("resident");
  expect(definition.events).toEqual([{ ns: "number.changed", version: 1 }]);
  expect(definition.rows[0]?.verdict.value).toEqual({ type: "allow" });
  expect(definition.tools[0]?.visibility.model).toEqual(["resident"]);
  expect(Object.isFrozen(definition)).toBe(true);
  expect(Object.isFrozen(definition.rows[0]?.verdict.value)).toBe(true);
  expect(Object.isFrozen(events)).toBe(false);
  expect(Reflect.set(definition, "name", "evil")).toBe(false);
});

test("validates tools rows events and duplicate identities", () => {
  const base = { name: "number", requires: [], provides: [NumberService], layer: NumberLive } as const;
  for (const tools of [[{ ...tool, name: "other__echo" }], [tool, tool]]) expect(() => bundle({ ...base, tools })).toThrow(BundleError);
  for (const rows of [[{ ...row, name: "other/allow" }], [row, row]]) expect(() => bundle({ ...base, rows })).toThrow(BundleError);
  for (const events of [[{ ns: "other.changed", version: 1 }], [{ ns: "number.changed", version: 0 }], [{ ns: "number.changed", version: 1.5 }], [{ ns: "number.changed", version: 1 }, { ns: "number.changed", version: 1 }]]) expect(() => bundle({ ...base, events })).toThrow(BundleError);
  const malformed = structuredClone(row);
  Object.assign(malformed.verdict, { value: { type: "allow", callback: () => true } });
  expect(() => bundle({ ...base, rows: [malformed] })).toThrow(BundleError);
  Object.assign(malformed.verdict, { value: new Date(0) });
  expect(() => bundle({ ...base, rows: [malformed] })).toThrow(BundleError);
});

test("compose rechecks forged metadata and mutable Tag keys", () => {
  const definition = numberBundle();
  expect(() => compose(seed, [{ ...definition, name: "other" }])).toThrow(BundleError);
  expect(() => compose(seed, [definition, definition])).toThrow(BundleError);
  const tag = Context.GenericTag<{ readonly mutable: true }, number>("@openomni/bundle/mutable/Value");
  const live = Layer.succeed(tag, 1);
  const mutable = bundle({ name: "mutable", requires: [], provides: [tag], layer: live });
  Object.assign(tag, { key: "@openomni/bundle/mutable/Other" });
  expect(() => compose(seed, [mutable])).toThrow(BundleError);
});

test("compose snapshots the seed before caller mutation", async () => {
  const input = { provides: [NumberService], requires: [], layer: NumberLive };
  const TextLive = Layer.effect(TextService, Effect.map(NumberService, String));
  const text = bundle({ name: "text", requires: [NumberService], provides: [TextService], layer: TextLive });
  const live = compose(input, [text]);
  input.provides.length = 0;
  Object.assign(input, { layer: Layer.empty });
  expect(await isolated(TextService.pipe(Effect.provide(live)))).toBe("7");
});

test("acquisition rejects Tag mutation after composition before any resources open", async () => {
  const events: string[] = [];
  const tag = Context.GenericTag<{ readonly changed: true }, number>("@openomni/bundle/changed/Value");
  const live = Layer.scoped(tag, Effect.acquireRelease(Effect.sync(() => { events.push("open"); return 1; }), () => Effect.sync(() => { events.push("close"); })));
  const definition = bundle({ name: "changed", requires: [], provides: [tag], layer: live });
  const composed = compose(seed, [definition]);
  Object.assign(tag, { key: "@openomni/bundle/changed/Other" });
  const exit = await isolated(Effect.exit(Effect.scoped(Layer.build(composed))));
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("metadata");
  expect(events).toEqual([]);
});

test("runtime compose refuses missing later-only and seed-colliding providers", () => {
  const TextLive = Layer.effect(TextService, Effect.map(NumberService, String));
  const second = bundle({ name: "text", provides: [TextService], requires: [NumberService], layer: TextLive });
  expect(() => Reflect.apply(compose, undefined, [seed, [second]])).toThrow(BundleError);
  expect(() => Reflect.apply(compose, undefined, [seed, [second, numberBundle()]])).toThrow(BundleError);
  expect(() => compose({ provides: [NumberService], requires: [], layer: NumberLive }, [numberBundle()])).toThrow(BundleError);
});

test("missing runtime outputs fail typed and release resources", async () => {
  const released: string[] = [];
  const MissingLive = Layer.scopedContext(Effect.acquireRelease(Effect.sync(missingNumberContext), () => Effect.sync(() => { released.push("closed"); })));
  const missing = bundle({ name: "number", provides: [NumberService], requires: [], layer: MissingLive });
  const exit = await isolated(Effect.exit(Effect.scoped(Layer.build(compose(seed, [missing])))));
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("missing_output");
  expect(released).toEqual(["closed"]);
});

test("failed later acquisition unwinds once", async () => {
  const released: string[] = [];
  const FirstLive = Layer.scoped(NumberService, Effect.acquireRelease(Effect.succeed(7), () => Effect.sync(() => { released.push("number"); })));
  const first = bundle({ name: "number", requires: [], provides: [NumberService], layer: FirstLive });
  const FailureLive = Layer.scopedDiscard(Effect.zipRight(NumberService, Effect.fail("refused")));
  const failed = bundle({ name: "failed", requires: [NumberService], provides: [], layer: FailureLive });
  const exit = await isolated(Effect.exit(Effect.scoped(Layer.build(compose(seed, [first, failed])))));
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("acquisition");
  expect(released).toEqual(["number"]);
});

test("BundlesLive acquires only selected generation recipes and captures policy services", async () => {
  const events: string[] = [];
  const Policy = bundlePolicyTag("demo");
  const PolicyLive = Layer.scoped(Policy, Effect.acquireRelease(Effect.sync(() => { events.push("open"); return { transformers: [{ name: "demo/identity", apply: (value: PlainValue) => value }], obligations: [{ name: "demo/budget" }] }; }), () => Effect.sync(() => { events.push("close"); })));
  const demo = bundle({ name: "demo", provides: [Policy], requires: [], layer: PolicyLive });
  const UnselectedLive = Layer.scopedDiscard(Effect.sync(() => { events.push("unselected"); }));
  const unselected = bundle({ name: "unselected", provides: [], requires: [], layer: UnselectedLive });
  const definitions = await isolated(BundleDefinitions.pipe(Effect.provide(BundlesLive([demo, unselected]))));
  expect(events).toEqual([]);
  expect(definitions.names).toEqual(["demo", "unselected"]);
  const selected = definitions.select(["demo"]);
  const SeedLive = Layer.mergeAll(Layer.succeed(Clock, { now: () => 1 }), Layer.succeed(Entropy, { next: () => "id" }), Layer.succeed(ObservationSink, createObservationBus()), Layer.succeed(ToolCatalog, { definitions: [] }));
  const registry = await isolated(NamedPolicyRegistry.pipe(Effect.provide(selected.layer), Effect.provide(SeedLive)));
  expect(registry.transformers.map((entry) => entry.name)).toEqual(["kernel/redact", "demo/identity"]);
  expect(registry.obligations.map((entry) => entry.name)).toEqual(["kernel/budget-clamp", "demo/budget"]);
  expect(events).toEqual(["open", "close"]);
  const empty = await isolated(NamedPolicyRegistry.pipe(Effect.provide(definitions.select([]).layer), Effect.provide(SeedLive)));
  expect(empty.transformers.map((entry) => entry.name)).toEqual(["kernel/redact"]);
  expect(events).toEqual(["open", "close"]);
  expect(() => definitions.select(["absent"])).toThrow(BundleError);
  expect(() => definitions.select(["demo", "demo"])).toThrow(BundleError);
});
