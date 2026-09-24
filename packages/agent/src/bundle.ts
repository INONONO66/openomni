import { createNamedPolicyRegistry, KERNEL_POLICY_REGISTRY, type NamedPolicyRegistry as PolicyRegistry } from "@openomni/policy";
import { type AnyToolDefinition, type PlainValue, PlainValueSchema, PolicyRow } from "@openomni/protocol";
import { Context, Effect, Layer, Option, type Scope } from "effect";
import { BundleError } from "./errors";
import { Clock, Entropy, ObservationSink, ToolCatalog } from "./services";

type TagIdentity = Pick<Context.Tag<never, never>, "key" | "_op">;
type Identifier<T> = T extends { readonly Identifier: infer I } ? I : never;
type Identifiers<T extends readonly TagIdentity[]> = Identifier<T[number]>;
type Genuine<T> = T extends Context.Tag<infer I, infer S> ? T extends Context.Tag<I, S> ? T extends { readonly key: PolicyId<string> } ? S extends PolicyRegistry ? true : false : true : false : false;
type GenuineTuple<T extends readonly TagIdentity[]> = { [K in keyof T]: Genuine<T[K]> };
type Equal<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
type Exact<P extends readonly TagIdentity[], R extends readonly TagIdentity[], O, I> =
  false extends GenuineTuple<P>[number] | GenuineTuple<R>[number] ? false :
  Equal<Identifiers<P>, O> extends true ? Equal<Identifiers<R>, I> : false;
type Check<T> = T extends true ? [] : [invalidContract: never];
type SeedServices = Clock | Entropy | ObservationSink | ToolCatalog;

export class NamedPolicyRegistry extends Context.Tag("@openomni/agent/NamedPolicyRegistry")<NamedPolicyRegistry, PolicyRegistry>() {}

type PolicyId<N extends string> = `@openomni/bundle/${N}/Policy`;
export function bundlePolicyTag<const N extends string>(name: N) {
  namespace(name);
  const key: PolicyId<N> = `@openomni/bundle/${name}/Policy`;
  return Object.assign(Context.GenericTag<PolicyId<N>, PolicyRegistry>(key), { key });
}

export interface BundleEvent { readonly ns: string; readonly version: number }
export type BundleRow = Omit<PolicyRow.Row, "generation">;
interface Metadata {
  readonly name: string;
  readonly provides: readonly TagIdentity[];
  readonly requires: readonly TagIdentity[];
  readonly tools: readonly AnyToolDefinition[];
  readonly rows: readonly BundleRow[];
  readonly events: readonly BundleEvent[];
}
const recipe = Symbol("bundle.recipe");
interface Acquired { readonly context: Context.Context<never>; readonly policy: PolicyRegistry }
export interface BundleDefinition extends Metadata {
  readonly [recipe]: {
    readonly check: (definition: BundleDefinition) => void;
    readonly acquire: (context: Context.Context<never>) => Effect.Effect<Acquired, BundleError, Scope.Scope>;
  };
}
interface DefinitionInput<P extends readonly TagIdentity[], R extends readonly TagIdentity[], O, E, I> {
  readonly name: string;
  readonly provides: P;
  readonly requires: R;
  readonly layer: Layer.Layer<O, E, I>;
  readonly tools?: readonly AnyToolDefinition[];
  readonly rows?: readonly BundleRow[];
  readonly events?: readonly BundleEvent[];
}

function refuse(code: BundleError["code"], name: string, detail: string): never {
  throw new BundleError({ code, bundle: name, detail });
}
function namespace(name: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) refuse("namespace", name, name);
}
function unique(values: readonly string[], name: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) refuse("duplicate", name, value);
    seen.add(value);
  }
}
function tags(tags: readonly TagIdentity[], name: string): void {
  unique(tags.map((tag) => tag.key), name);
  for (const tag of tags) if (!Context.isTag(tag)) refuse("metadata", name, tag.key);
}
function validate(metadata: Metadata): void {
  namespace(metadata.name);
  tags(metadata.provides, metadata.name);
  tags(metadata.requires, metadata.name);
  for (const tag of metadata.provides) {
    if (!new RegExp(`^@openomni/bundle/${metadata.name}/[A-Za-z][A-Za-z0-9-]*$`).test(tag.key)) refuse("namespace", metadata.name, tag.key);
  }
  for (const tag of metadata.requires) {
    if (metadata.provides.some((output) => output.key === tag.key)) refuse("requirement", metadata.name, tag.key);
    if (!kernelTags.some((kernel) => kernel.key === tag.key) && !/^@openomni\/bundle\/[a-z][a-z0-9-]*\/[A-Za-z][A-Za-z0-9-]*$/.test(tag.key)) refuse("requirement", metadata.name, tag.key);
  }
  unique(metadata.tools.map((tool) => tool.name), metadata.name);
  for (const tool of metadata.tools) if (!new RegExp(`^${metadata.name}__[a-zA-Z][a-zA-Z0-9_-]*$`).test(tool.name)) refuse("namespace", metadata.name, tool.name);
  validateRows(metadata);
  unique(metadata.events.map((event) => `${event.ns}@${event.version}`), metadata.name);
  for (const event of metadata.events) {
    if (!new RegExp(`^${metadata.name}\\.[a-z][a-z0-9.-]*$`).test(event.ns) || !Number.isSafeInteger(event.version) || event.version <= 0) refuse("namespace", metadata.name, event.ns);
  }
}
const RowTemplate = PolicyRow.Row.omit({ generation: true });
function validateRows(metadata: Metadata): void {
  unique(metadata.rows.map((row) => row.name), metadata.name);
  for (const row of metadata.rows) {
    if (!row.name.startsWith(`${metadata.name}/`) || row.name.length === metadata.name.length + 1) refuse("namespace", metadata.name, row.name);
    if (!PlainValueSchema.safeParse(row).success || !RowTemplate.safeParse(row).success) refuse("metadata", metadata.name, row.name);
  }
}
function freezePlain(value: PlainValue): void {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezePlain(child);
    Object.freeze(value);
  }
}
function copyTags<const T extends readonly TagIdentity[]>(input: T): T {
  const copy: T = Object.assign([...input], input);
  Object.freeze(copy);
  return copy;
}
function copyRows(rows: readonly BundleRow[]): readonly BundleRow[] {
  return Object.freeze(rows.map((row) => { const copy = structuredClone(row); freezePlain(copy); return copy; }));
}
function copyTools(tools: readonly AnyToolDefinition[]): readonly AnyToolDefinition[] {
  return Object.freeze(tools.map((tool) => Object.freeze({ ...tool, visibility: Object.freeze({ model: Object.freeze([...tool.visibility.model]), cell: Object.freeze([...tool.visibility.cell]) }) })));
}

// Private membership proof: callers bind R only to their statically exact Tag tuple.
// Key probes never read a service through an erased Tag or cast its value.
function contains<R>(context: Context.Context<never>, tags: readonly TagIdentity[]): context is Context.Context<R> {
  return tags.every((tag) => Option.isSome(Context.getOption(context, Context.GenericTag<never, never>(tag.key))));
}
const emptyPolicy: PolicyRegistry = Object.freeze({ transformers: Object.freeze([]), obligations: Object.freeze([]) });
function policyFrom(name: string, provided: readonly TagIdentity[], context: Context.Context<never>): PolicyRegistry {
  const tag = bundlePolicyTag(name);
  if (!provided.some((output) => output.key === tag.key)) return emptyPolicy;
  if (!contains<PolicyId<string>>(context, [tag])) return refuse("missing_output", name, tag.key);
  const policy = Context.get(context, tag);
  for (const entry of [...policy.transformers, ...policy.obligations]) {
    if (!entry.name.startsWith(`${name}/`)) refuse("policy", name, entry.name);
  }
  return createNamedPolicyRegistry(policy);
}

export function bundle<const P extends readonly TagIdentity[], const R extends readonly TagIdentity[], O, E, I>(
  input: DefinitionInput<P, R, O, E, I>, ..._check: Check<Exact<P, R, O, I>>
) {
  const metadata = { ...input, tools: input.tools ?? [], rows: input.rows ?? [], events: input.events ?? [] };
  validate(metadata);
  const provides = copyTags(input.provides);
  const requires = copyTags(input.requires);
  const outputKeys = provides.map((tag) => tag.key);
  const inputKeys = requires.map((tag) => tag.key);
  const layer = input.layer;
  const name = input.name;
  const definition = {
    name, provides, requires, layer,
    tools: copyTools(metadata.tools), rows: copyRows(metadata.rows),
    events: Object.freeze(metadata.events.map((event) => Object.freeze({ ...event }))),
    [recipe]: Object.freeze({
      check: (candidate: BundleDefinition) => {
        if (candidate !== definition || provides.some((tag, index) => tag.key !== outputKeys[index]) || requires.some((tag, index) => tag.key !== inputKeys[index])) refuse("metadata", name, "definition changed");
      },
      acquire: (context: Context.Context<never>): Effect.Effect<Acquired, BundleError, Scope.Scope> => Effect.gen(function* () {
        if (!contains<I>(context, requires)) return yield* new BundleError({ code: "requirement", bundle: name, detail: "missing input" });
        const built = yield* Layer.build(layer).pipe(Effect.provide(context), Effect.mapError((error) => new BundleError({ code: "acquisition", bundle: name, detail: String(error) })));
        if (!contains<O>(built, provides)) return yield* new BundleError({ code: "missing_output", bundle: name, detail: outputKeys.join(",") });
        const policy = yield* Effect.try({ try: () => policyFrom(name, provides, built), catch: (error) => new BundleError({ code: "policy", bundle: name, detail: String(error) }) });
        return { context: built, policy };
      }),
    }),
  };
  return Object.freeze(definition);
}

type Outputs<B extends readonly BundleDefinition[]> = Identifiers<B[number]["provides"]>;
type Ordered<B extends readonly BundleDefinition[], Available> = B extends readonly [infer Head extends BundleDefinition, ...infer Tail extends readonly BundleDefinition[]]
  ? [Exclude<Identifiers<Head["requires"]>, Available>] extends [never] ? Ordered<Tail, Available | Identifiers<Head["provides"]>> : false
  : number extends B["length"] ? false : true;
function validateOrder(seed: readonly TagIdentity[], definitions: readonly BundleDefinition[]): void {
  tags(seed, "kernel");
  unique(definitions.map((definition) => definition.name), "bundles");
  const available = new Set(seed.map((tag) => tag.key));
  for (const definition of definitions) {
    validate(definition);
    definition[recipe].check(definition);
    for (const tag of definition.requires) if (!available.has(tag.key)) refuse("requirement", definition.name, tag.key);
    for (const tag of definition.provides) {
      if (available.has(tag.key)) refuse("duplicate", definition.name, tag.key);
      available.add(tag.key);
    }
  }
  unique(definitions.flatMap((definition) => definition.tools.map((tool) => tool.name)), "tools");
  unique(definitions.flatMap((definition) => definition.rows.map((row) => row.name)), "rows");
  unique(definitions.flatMap((definition) => definition.events.map((event) => `${event.ns}@${event.version}`)), "events");
}
function acquire(definitions: readonly BundleDefinition[], initial: Context.Context<never>) {
  return Effect.gen(function* () {
    let context = initial;
    const policies: PolicyRegistry[] = [KERNEL_POLICY_REGISTRY];
    for (const definition of definitions) {
      const acquired = yield* definition[recipe].acquire(context);
      context = Context.merge(context, acquired.context);
      policies.push(acquired.policy);
    }
    const policy = yield* Effect.try({ try: () => createNamedPolicyRegistry({ transformers: policies.flatMap((entry) => entry.transformers), obligations: policies.flatMap((entry) => entry.obligations) }), catch: (error) => new BundleError({ code: "policy", bundle: "bundles", detail: String(error) }) });
    return { context, policy };
  });
}

function recheck(seed: readonly TagIdentity[], definitions: readonly BundleDefinition[]) {
  return Effect.try({ try: () => validateOrder(seed, definitions), catch: (error) => error instanceof BundleError ? error : new BundleError({ code: "metadata", bundle: "bundles", detail: String(error) }) });
}

export function compose<const P extends readonly TagIdentity[], const R extends readonly TagIdentity[], O, E, I, const B extends readonly BundleDefinition[]>(
  seed: { readonly provides: P; readonly requires: R; readonly layer: Layer.Layer<O, E, I> }, definitions: B,
  ..._check: Check<Exact<P, R, O, I> extends true ? Ordered<B, O> : false>
): Layer.Layer<O | Outputs<B>, E | BundleError, I> {
  tags(seed.requires, "kernel");
  validateOrder(seed.provides, definitions);
  const seedProvides = copyTags(seed.provides);
  const seedLayer = seed.layer;
  const selected = Object.freeze([...definitions]);
  const outputs = [...seedProvides, ...selected.flatMap((definition) => definition.provides)];
  return Layer.scopedContext(Effect.gen(function* () {
    yield* recheck(seedProvides, selected);
    const context = yield* Layer.build(seedLayer);
    if (!contains<O>(context, seedProvides)) return yield* new BundleError({ code: "missing_output", bundle: "kernel", detail: "seed output" });
    const built = yield* acquire(selected, context);
    if (!contains<O | Outputs<B>>(built.context, outputs)) return yield* new BundleError({ code: "missing_output", bundle: "bundles", detail: "composed output" });
    return built.context;
  }));
}

export interface SelectedBundles {
  readonly names: readonly string[];
  readonly tools: readonly AnyToolDefinition[];
  readonly rows: readonly BundleRow[];
  readonly events: readonly BundleEvent[];
  readonly layer: Layer.Layer<NamedPolicyRegistry, BundleError, SeedServices>;
}
export class BundleDefinitions extends Context.Tag("@openomni/agent/BundleDefinitions")<BundleDefinitions, {
  readonly names: readonly string[];
  readonly select: (names: readonly string[]) => SelectedBundles;
}>() {}
const kernelTags = [Clock, Entropy, ObservationSink, ToolCatalog] as const;
export function BundlesLive<const B extends readonly BundleDefinition[]>(definitions: B, ..._check: Check<Ordered<B, SeedServices>>): Layer.Layer<BundleDefinitions> {
  validateOrder(kernelTags, definitions);
  const installed = Object.freeze([...definitions]);
  const names = Object.freeze(installed.map((definition) => definition.name).sort());
  return Layer.succeed(BundleDefinitions, Object.freeze({ names, select: (selection: readonly string[]): SelectedBundles => {
    unique(selection, "selection");
    for (const name of selection) if (!names.includes(name)) refuse("selection", name, "not installed");
    const selected = installed.filter((definition) => selection.includes(definition.name));
    validateOrder(kernelTags, selected);
    return Object.freeze({
      names: Object.freeze([...selection].sort()),
      tools: Object.freeze(selected.flatMap((definition) => definition.tools)),
      rows: Object.freeze(selected.flatMap((definition) => definition.rows)),
      events: Object.freeze(selected.flatMap((definition) => definition.events)),
      layer: Layer.scoped(NamedPolicyRegistry, Effect.gen(function* () {
        yield* recheck(kernelTags, selected);
        const context = yield* Effect.context<SeedServices>();
        const built = yield* acquire(selected, context);
        return built.policy;
      })),
    });
  } }));
}
