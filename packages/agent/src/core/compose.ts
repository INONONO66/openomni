/*
 * ──────────────────────────────────────────────────────────────────────────
 * The former runtime bundle plane (the imperative bundle loader and its
 * definitions service) is deleted (#1255 P3): the one loader path is
 * `Manifest.define` -> `compose(manifest) -> Generation`
 * below. Only the `GenerationHandlers` Context tag survives — it is part of
 * the live `GenerationServices` contract the app's generation Layers provide.
 * ──────────────────────────────────────────────────────────────────────────
 */
import type { HandlerTable as PolicyRegistry, NamedConsultant } from "./gate/compile";
import { canonicalDigest, CORE_POINT_RECORDS, type PlainValue } from "@openomni/protocol";
import { Context, Effect, Schema, type Scope } from "effect";
import type {
  BundleContract,
  BundleGateRow,
  BundleTool,
  CapabilityDefinition,
  CapabilityKindDeclaration,
  ManifestDefinition,
} from "./capability";

export class GenerationHandlers extends Context.Service<GenerationHandlers, PolicyRegistry>()(
  "@openomni/agent/GenerationHandlers",
) {}

/** What a consultant factory receives at generation acquisition (#1256). */
export interface ConsultantSeed {
  /** The registered `how.ref` name the factory serves. */
  readonly name: string;
  /** The composed generation's rows naming this consultant, in order. */
  readonly rows: readonly BundleGateRow[];
  /**
   * Fire-and-forget late-result port: a payload that settles AFTER its call
   * timed out re-enters the session through the composition's `deliver` door
   * as an `action` row — never through this turn's decision.
   */
  readonly late?: (payload: PlainValue) => void;
  /**
   * The session's journal head ordinal at call time (#1256 H-3): a late
   * result delivers with this `after` cursor, and one older than the
   * compaction head folds to `turn.consumed.stale` instead of a prompt.
   */
  readonly cursor?: () => number;
  /**
   * How many timed-out calls stay correlatable for a late result (#1256 r3);
   * older entries evict first. Default 256.
   */
  readonly lateWindow?: number;
}

/**
 * A capability `handlers` registration carrying an ASYNC consulted service
 * (#1256): the composition acquires `consult` INSIDE the generation Layer's
 * Scope (the hook PID's lifetime), and a factory failure is the typed
 * candidate failure that refuses the generation — never a partial activation.
 */
export interface ConsultantHandler {
  readonly consultant: (
    seed: ConsultantSeed,
  ) => Effect.Effect<NamedConsultant["consult"], Error, Scope.Scope>;
}

export function isConsultantHandler(handler: object): handler is ConsultantHandler {
  return "consultant" in handler && typeof handler.consultant === "function";
}

/*
 * ──────────────────────────────────────────────────────────────────────────
 * #1255 S2: `compose(manifest) -> Generation` — the one loader path.
 * ──────────────────────────────────────────────────────────────────────────
 */

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
    manifest.bundles.flatMap((bundle) =>
      bundle.provides.map((tag) => [tag.key, bundle.name] as const),
    ),
  );
  for (;;) {
    const capabilitiesChanged = sweepOffCapabilities(manifest, disabled);
    const bundlesChanged = sweepOffBundles(manifest, disabled, seamOwner, provideOwner);
    if (!(capabilitiesChanged || bundlesChanged)) return disabled;
  }
}

/** One cascade sweep over capabilities: a disabled requirement disables the dependent. */
function sweepOffCapabilities(
  manifest: ManifestDefinition,
  disabled: Map<string, string>,
): boolean {
  let changed = false;
  for (const capability of manifest.capabilities) {
    if (disabled.has(capability.name)) continue;
    const hit = capability.requires.find((required) => disabled.has(required));
    if (hit !== undefined) {
      disabled.set(capability.name, disabled.get(hit) ?? hit);
      changed = true;
    }
  }
  return changed;
}

/** One cascade sweep over bundles: a disabled seam owner disables the requiring bundle. */
function sweepOffBundles(
  manifest: ManifestDefinition,
  disabled: Map<string, string>,
  seamOwner: ReadonlyMap<string, string>,
  provideOwner: ReadonlyMap<string, string>,
): boolean {
  let changed = false;
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
  return changed;
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

/** Collision-guarded merge of a named handler/purpose table into the composed registry. */
function mergeInto(
  target: Map<string, object>,
  entries: Readonly<Record<string, object>>,
  owner: string,
  label: string,
): void {
  for (const [key, value] of Object.entries(entries)) {
    if (target.has(key)) reject("duplicate", owner, `${label} ${key}`);
    target.set(key, value);
  }
}

/** The merged capability-owned tables in topological order; any collision rejects. */
function mergeCapabilityTables(orderedCapabilities: readonly CapabilityDefinition[]): {
  kinds: Record<string, CapabilityKindDeclaration>;
  points: Set<string>;
  handlers: Map<string, object>;
  purposes: Map<string, object>;
  inputs: string[];
} {
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
    mergeInto(purposes, capability.purposes, capability.name, "purpose");
    mergeInto(handlers, capability.handlers, capability.name, "handler");
    for (const input of capability.inputs) {
      if (inputs.includes(input)) reject("duplicate", capability.name, `input ${input}`);
      inputs.push(input);
    }
  }
  return { kinds, points, handlers, purposes, inputs };
}

/** The merged bundle-owned tables in composition order; collisions (including against capability tables) reject. */
function mergeBundleTables(
  orderedBundles: readonly BundleContract[],
  purposes: Map<string, object>,
  handlers: Map<string, object>,
): { tools: BundleTool[]; rows: BundleGateRow[] } {
  const tools: BundleTool[] = [];
  const rows: BundleGateRow[] = [];
  for (const bundle of orderedBundles) {
    for (const tool of bundle.tools) {
      if (tools.some((existing) => existing.name === tool.name))
        reject("duplicate", bundle.name, `tool ${tool.name}`);
      tools.push(tool);
    }
    mergeInto(purposes, bundle.purposes, bundle.name, "purpose");
    mergeInto(handlers, bundle.handlers, bundle.name, "handler");
    for (const row of bundle.rows) {
      if (rows.some((existing) => existing.id === row.id))
        reject("duplicate", bundle.name, `row ${row.id}`);
      rows.push(row);
    }
  }
  return { tools, rows };
}

/**
 * `composeSync(manifest) -> Generation` (#1255): the Effect-free form of
 * `compose` for Promise-side composition roots (boot, fixtures); a refusal
 * throws the typed `ComposeRefused`. Same single implementation.
 */
export function composeSync(manifest: ManifestDefinition): Generation {
  uniqueNames(manifest);
  const disabledMap = cascadeOff(manifest);
  const onCapabilities = manifest.capabilities.filter(
    (capability) => !disabledMap.has(capability.name),
  );
  const orderedCapabilities = orderCapabilities(onCapabilities);
  const { kinds, points, handlers, purposes, inputs } = mergeCapabilityTables(orderedCapabilities);
  const onBundles = manifest.bundles.filter((bundle) => !disabledMap.has(bundle.name));
  for (const bundle of onBundles) {
    for (const owned of ["kinds", "points", "step"] as const) {
      if (owned in bundle) reject("product_declares_kind", bundle.name, owned);
    }
  }
  const seams = new Set(orderedCapabilities.map((capability) => capability.seam.key));
  const orderedBundles = orderBundles(onBundles, seams);
  const { tools, rows } = mergeBundleTables(orderedBundles, purposes, handlers);
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
      return Effect.succeed(composeSync(manifest));
    } catch (failure) {
      if (failure instanceof ComposeRefused) return Effect.fail(failure);
      throw failure;
    }
  });
}
