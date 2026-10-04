/*
 * ──────────────────────────────────────────────────────────────────────────
 * TRANSITIONAL legacy bundle plane (former core/bundle.ts): `BundlesLive`,
 * `BundleDefinitions`, the `NamedPolicyRegistry` tag and `bundle()` are still
 * consumed by the apps/openomni boot path; Lane 2 (#1255) replaces those uses
 * with `Manifest.define` + `compose` below, then this section is deleted.
 * ──────────────────────────────────────────────────────────────────────────
 */
import { createNamedPolicyRegistry, KERNEL_POLICY_REGISTRY, type NamedPolicyRegistry as PolicyRegistry } from "./gate/compile";
import { canonicalDigest, CORE_POINT_RECORDS, type AnyToolDefinition, type PlainValue, PlainValueSchema, PolicyRow } from "@openomni/protocol";
import { Context, Effect, Layer, Option, Schema, type Scope } from "effect";
import { BundleError } from "./failure";
import { Entropy, ObservationSink, ToolCatalog } from "./ports";

type TagIdentity = Pick<Context.Service<never, never>, "key" | typeof Context.ServiceTypeId>;
type Identifier<T> = T extends { readonly Identifier: infer I } ? I : never;
type Identifiers<T extends readonly TagIdentity[]> = Identifier<T[number]>;
type Genuine<T> = T extends Context.Service<infer I, infer S> ? T extends Context.Service<I, S> ? T extends { readonly key: PolicyId<string> } ? S extends PolicyRegistry ? true : false : true : false : false;
type GenuineTuple<T extends readonly TagIdentity[]> = { [K in keyof T]: Genuine<T[K]> };
type Equal<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
type Exact<P extends readonly TagIdentity[], R extends readonly TagIdentity[], O, I> =
  false extends GenuineTuple<P>[number] | GenuineTuple<R>[number] ? false :
  Equal<Identifiers<P>, O> extends true ? Equal<Identifiers<R>, I> : false;
type Check<T> = T extends true ? [] : [invalidContract: never];
type SeedServices = Entropy | ObservationSink | ToolCatalog;

export class NamedPolicyRegistry extends Context.Service<NamedPolicyRegistry, PolicyRegistry>()("@openomni/agent/NamedPolicyRegistry") {}

type PolicyId<N extends string> = `@openomni/bundle/${N}/Policy`;
export function bundlePolicyTag<const N extends string>(name: N) {
  namespace(name);
  const key: PolicyId<N> = `@openomni/bundle/${name}/Policy`;
  return Object.assign(Context.Service<PolicyId<N>, PolicyRegistry>(key), { key });
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
  for (const tag of tags) if (!Context.isKey(tag)) refuse("metadata", name, tag.key);
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
  return tags.every((tag) => Option.isSome(Context.getOption(context, Context.Service<never, never>(tag.key))));
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
        const built = yield* Layer.build(layer).pipe(Effect.provide(context), Effect.mapError((error: E) => new BundleError({ code: "acquisition", bundle: name, detail: String(error) })));
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

export function composeBundleLayers<const P extends readonly TagIdentity[], const R extends readonly TagIdentity[], O, E, I, const B extends readonly BundleDefinition[]>(
  seed: { readonly provides: P; readonly requires: R; readonly layer: Layer.Layer<O, E, I> }, definitions: B,
  ..._check: Check<Exact<P, R, O, I> extends true ? Ordered<B, O> : false>
): Layer.Layer<O | Outputs<B>, E | BundleError, I> {
  tags(seed.requires, "kernel");
  validateOrder(seed.provides, definitions);
  const seedProvides = copyTags(seed.provides);
  const seedLayer = seed.layer;
  const selected = Object.freeze([...definitions]);
  const outputs = [...seedProvides, ...selected.flatMap((definition) => definition.provides)];
  return Layer.effectContext(Effect.gen(function* () {
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
export class BundleDefinitions extends Context.Service<BundleDefinitions, {
  readonly names: readonly string[];
  readonly select: (names: readonly string[]) => SelectedBundles;
}>()("@openomni/agent/BundleDefinitions") {}
const kernelTags = [Entropy, ObservationSink, ToolCatalog] as const;
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
      layer: Layer.effect(NamedPolicyRegistry, Effect.gen(function* () {
        yield* recheck(kernelTags, selected);
        const context = yield* Effect.context<SeedServices>();
        const built = yield* acquire(selected, context);
        return built.policy;
      })),
    });
  } }));
}


/*
 * ──────────────────────────────────────────────────────────────────────────
 * #1255 S2: `compose(manifest) -> Generation` — the one loader path.
 * ──────────────────────────────────────────────────────────────────────────
 */
// eslint-disable-next-line import/order
import type {
  BundleContract,
  BundleGateRow,
  BundleTool,
  CapabilityDefinition,
  CapabilityKindDeclaration,
  ManifestDefinition,
} from "./capability";

/** The CLOSED compose rejection set (#1255): exactly these six, never a seventh. */
export const COMPOSE_REJECTION_CODES = [
  "requires_cycle",
  "duplicate",
  "product_declares_kind",
  "seam_missing",
  "unknown_handler",
  "unknown_point",
] as const;
export type ComposeRejection = (typeof COMPOSE_REJECTION_CODES)[number];

/** Typed compose refusal: a rejection fails the boot — no partial activation. */
export class ComposeRefused extends Schema.TaggedError<ComposeRefused>(
  "@openomni/agent/core/ComposeRefused",
)("ComposeRefused", {
  code: Schema.Literals(COMPOSE_REJECTION_CODES),
  name: Schema.String,
  detail: Schema.String,
}) {}

/** One intended deactivation: `because` is the root `off` name that caused it. */
export interface DisabledEntry {
  readonly name: string;
  readonly because: string;
}

/**
 * The compiled version of the loaded set: one journaled generation. Recomputed
 * from empty state on every manifest change; never patched in place. The
 * in-flight turn finishes on the generation it captured at turn start.
 */
export interface Generation {
  /** Canonical digest over the composed tables. */
  readonly hash: string;
  /** Registered capability journal kinds (an off capability's kind is absent). */
  readonly kinds: Readonly<Record<string, CapabilityKindDeclaration>>;
  /** The merged point table: the core's sealed ids plus on-capability points. */
  readonly points: readonly string[];
  /** `how.ref` targets, capability- and bundle-registered. */
  readonly handlers: ReadonlyMap<string, object>;
  /** Alarm purposes, capability- and bundle-registered. */
  readonly purposes: ReadonlyMap<string, object>;
  /** Bundle tool faces in composition order; `idempotent` preserved. */
  readonly tools: readonly BundleTool[];
  /** Gate rows in composition order (generation number assigned at append). */
  readonly rows: readonly BundleGateRow[];
  /** Kinds `deliver` may accept as input. */
  readonly inputs: readonly string[];
  /** On capabilities in topological order. */
  readonly capabilities: readonly string[];
  /** On bundles in composition order. */
  readonly bundles: readonly string[];
  /** The off cascade, recorded in `session.configure{disabled}`. */
  readonly disabled: readonly DisabledEntry[];
}

function reject(code: ComposeRejection, name: string, detail: string): never {
  throw new ComposeRefused({ code, name, detail });
}

/** Topological order of capabilities over `requires` names; cycle rejects. */
function orderCapabilities(
  capabilities: readonly CapabilityDefinition[],
): readonly CapabilityDefinition[] {
  const byName = new Map(capabilities.map((capability) => [capability.name, capability]));
  const ordered: CapabilityDefinition[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (capability: CapabilityDefinition, path: readonly string[]): void => {
    const seen = state.get(capability.name);
    if (seen === "done") return;
    if (seen === "visiting")
      reject("requires_cycle", capability.name, [...path, capability.name].join(" -> "));
    state.set(capability.name, "visiting");
    for (const required of capability.requires) {
      const provider = byName.get(required);
      if (provider === undefined) reject("seam_missing", capability.name, required);
      visit(provider, [...path, capability.name]);
    }
    state.set(capability.name, "done");
    ordered.push(capability);
  };
  for (const capability of capabilities) visit(capability, []);
  return ordered;
}

/** The transitive off cascade; `because` carries the ROOT off name. */
function cascadeOff(manifest: ManifestDefinition): ReadonlyMap<string, string> {
  const disabled = new Map<string, string>();
  const names = new Set([
    ...manifest.capabilities.map((capability) => capability.name),
    ...manifest.bundles.map((bundle) => bundle.name),
  ]);
  for (const root of manifest.off) if (names.has(root)) disabled.set(root, root);
  const seamOwner = new Map(
    manifest.capabilities.map((capability) => [capability.seam.key, capability.name]),
  );
  const provideOwner = new Map(
    manifest.bundles.flatMap((bundle) => bundle.provides.map((tag) => [tag.key, bundle.name] as const)),
  );
  for (;;) {
    let changed = false;
    for (const capability of manifest.capabilities) {
      if (disabled.has(capability.name)) continue;
      const hit = capability.requires.find((required) => disabled.has(required));
      if (hit !== undefined) {
        disabled.set(capability.name, disabled.get(hit) ?? hit);
        changed = true;
      }
    }
    for (const bundle of manifest.bundles) {
      if (disabled.has(bundle.name)) continue;
      for (const tag of bundle.requires) {
        const owner = seamOwner.get(tag.key) ?? provideOwner.get(tag.key);
        if (owner !== undefined && disabled.has(owner)) {
          disabled.set(bundle.name, disabled.get(owner) ?? owner);
          changed = true;
          break;
        }
      }
    }
    if (!changed) return disabled;
  }
}

/** Composition order of on bundles over seam/provide availability; cycle rejects. */
function orderBundles(
  bundles: readonly BundleContract[],
  available: ReadonlySet<string>,
): readonly BundleContract[] {
  const keys = new Set(available);
  const remaining = [...bundles];
  const ordered: BundleContract[] = [];
  while (remaining.length > 0) {
    const index = remaining.findIndex((bundle) =>
      bundle.requires.every((tag) => keys.has(tag.key)),
    );
    if (index === -1) {
      const providedByRemaining = new Set(
        remaining.flatMap((bundle) => bundle.provides.map((tag) => tag.key)),
      );
      for (const bundle of remaining) {
        const unmet = bundle.requires.find((tag) => !keys.has(tag.key));
        if (unmet !== undefined && !providedByRemaining.has(unmet.key))
          reject("seam_missing", bundle.name, unmet.key);
      }
      const names = remaining.map((bundle) => bundle.name);
      reject("requires_cycle", names[0] ?? "bundles", names.join(" -> "));
    }
    const [next] = remaining.splice(index, 1);
    if (next === undefined) break;
    for (const tag of next.provides) keys.add(tag.key);
    ordered.push(next);
  }
  return ordered;
}

function uniqueNames(manifest: ManifestDefinition): void {
  const seen = new Set<string>();
  for (const name of [
    ...manifest.capabilities.map((capability) => capability.name),
    ...manifest.bundles.map((bundle) => bundle.name),
  ]) {
    if (seen.has(name)) reject("duplicate", name, "declaration name");
    seen.add(name);
  }
}

function hashProjection(
  manifest: ManifestDefinition,
  capabilities: readonly CapabilityDefinition[],
  bundles: readonly BundleContract[],
  disabled: readonly DisabledEntry[],
): PlainValue {
  return {
    capabilities: capabilities.map((capability) => ({
      name: capability.name,
      requires: [...capability.requires],
      seam: capability.seam.key,
      kinds: Object.entries(capability.kinds).map(([kind, declaration]) => ({
        kind,
        version: declaration.version,
      })),
      inputs: [...capability.inputs],
      points: [...capability.points],
      purposes: Object.keys(capability.purposes).sort(),
      handlers: Object.keys(capability.handlers).sort(),
    })),
    bundles: bundles.map((bundle) => ({
      name: bundle.name,
      requires: bundle.requires.map((tag) => tag.key),
      provides: bundle.provides.map((tag) => tag.key),
      tools: bundle.tools.map((tool) => ({
        name: tool.name,
        category: tool.category,
        sequential: tool.sequential === true,
        idempotent: tool.idempotent === true,
      })),
      rows: bundle.rows.map((row) => ({ ...row, when: { ...row.when }, how: { ...row.how } })),
      handlers: Object.keys(bundle.handlers).sort(),
      purposes: Object.keys(bundle.purposes).sort(),
    })),
    off: [...manifest.off],
    disabled: disabled.map((entry) => ({ ...entry })),
  };
}

function composeManifest(manifest: ManifestDefinition): Generation {
  uniqueNames(manifest);
  const disabledMap = cascadeOff(manifest);
  const onCapabilities = manifest.capabilities.filter(
    (capability) => !disabledMap.has(capability.name),
  );
  const orderedCapabilities = orderCapabilities(onCapabilities);
  const kinds: Record<string, CapabilityKindDeclaration> = {};
  const points = new Set<string>(CORE_POINT_RECORDS.map((record) => record.id));
  const handlers = new Map<string, object>();
  const purposes = new Map<string, object>();
  const inputs: string[] = [];
  for (const capability of orderedCapabilities) {
    for (const [kind, declaration] of Object.entries(capability.kinds)) {
      if (kind in kinds) reject("duplicate", capability.name, `kind ${kind}`);
      kinds[kind] = declaration;
    }
    for (const point of capability.points) {
      if (points.has(point)) reject("duplicate", capability.name, `point ${point}`);
      points.add(point);
    }
    for (const [purpose, handler] of Object.entries(capability.purposes)) {
      if (purposes.has(purpose)) reject("duplicate", capability.name, `purpose ${purpose}`);
      purposes.set(purpose, handler);
    }
    for (const [ref, handler] of Object.entries(capability.handlers)) {
      if (handlers.has(ref)) reject("duplicate", capability.name, `handler ${ref}`);
      handlers.set(ref, handler);
    }
    for (const input of capability.inputs) {
      if (inputs.includes(input)) reject("duplicate", capability.name, `input ${input}`);
      inputs.push(input);
    }
  }
  const onBundles = manifest.bundles.filter((bundle) => !disabledMap.has(bundle.name));
  for (const bundle of onBundles) {
    for (const owned of ["kinds", "points", "step"] as const) {
      if (owned in bundle) reject("product_declares_kind", bundle.name, owned);
    }
  }
  const seams = new Set(orderedCapabilities.map((capability) => capability.seam.key));
  const orderedBundles = orderBundles(onBundles, seams);
  const tools: BundleTool[] = [];
  const rows: BundleGateRow[] = [];
  for (const bundle of orderedBundles) {
    for (const tool of bundle.tools) {
      if (tools.some((existing) => existing.name === tool.name))
        reject("duplicate", bundle.name, `tool ${tool.name}`);
      tools.push(tool);
    }
    for (const [purpose, handler] of Object.entries(bundle.purposes)) {
      if (purposes.has(purpose)) reject("duplicate", bundle.name, `purpose ${purpose}`);
      purposes.set(purpose, handler);
    }
    for (const [ref, handler] of Object.entries(bundle.handlers)) {
      if (handlers.has(ref)) reject("duplicate", bundle.name, `handler ${ref}`);
      handlers.set(ref, handler);
    }
    for (const row of bundle.rows) {
      if (rows.some((existing) => existing.id === row.id))
        reject("duplicate", bundle.name, `row ${row.id}`);
      rows.push(row);
    }
  }
  for (const row of rows) {
    if (!points.has(row.on)) reject("unknown_point", row.id, row.on);
    if (row.how.ref !== undefined && !handlers.has(row.how.ref))
      reject("unknown_handler", row.id, row.how.ref);
  }
  const disabled = [...disabledMap.entries()].map(([name, because]) => ({ name, because }));
  return Object.freeze({
    hash: canonicalDigest(hashProjection(manifest, orderedCapabilities, orderedBundles, disabled)),
    kinds: Object.freeze(kinds),
    points: Object.freeze([...points]),
    handlers,
    purposes,
    tools: Object.freeze(tools),
    rows: Object.freeze(rows),
    inputs: Object.freeze(inputs),
    capabilities: Object.freeze(orderedCapabilities.map((capability) => capability.name)),
    bundles: Object.freeze(orderedBundles.map((bundle) => bundle.name)),
    disabled: Object.freeze(disabled),
  });
}

/**
 * `compose(manifest) -> Generation` (#1255): topological `requires` order, one
 * merged kind/point/handler/purpose/tool/row table set, the closed six-code
 * rejection set and the transitive `off` cascade (`off` is intended
 * deactivation, distinct from the `seam_missing` rejection).
 */
export function compose(manifest: ManifestDefinition): Effect.Effect<Generation, ComposeRefused> {
  return Effect.suspend(() => {
    try {
      return Effect.succeed(composeManifest(manifest));
    } catch (failure) {
      if (failure instanceof ComposeRefused) return Effect.fail(failure);
      throw failure;
    }
  });
}
