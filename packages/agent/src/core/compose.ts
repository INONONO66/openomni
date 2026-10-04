/*
 * ──────────────────────────────────────────────────────────────────────────
 * The former runtime bundle plane (the imperative bundle loader and its
 * definitions service) is deleted (#1255 P3): the one loader path is
 * `Manifest.define` -> `compose(manifest) -> Generation`
 * below. Only the `NamedPolicyRegistry` Context tag survives — it is part of
 * the live `GenerationServices` contract the app's generation Layers provide.
 * ──────────────────────────────────────────────────────────────────────────
 */
import type { NamedPolicyRegistry as PolicyRegistry } from "./gate/compile";
import { canonicalDigest, CORE_POINT_RECORDS, type PlainValue } from "@openomni/protocol";
import { Context, Effect, Schema } from "effect";
import type {
  BundleContract,
  BundleGateRow,
  BundleTool,
  CapabilityDefinition,
  CapabilityKindDeclaration,
  ManifestDefinition,
} from "./capability";

export class NamedPolicyRegistry extends Context.Service<NamedPolicyRegistry, PolicyRegistry>()("@openomni/agent/NamedPolicyRegistry") {}

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
