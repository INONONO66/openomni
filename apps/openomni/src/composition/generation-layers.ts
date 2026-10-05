import { Core, Bundle } from "@openomni/agent";
const Entropy = Core.Entropy;
type Entropy = Core.Entropy;
const AgentFailure = Core.AgentFailure;
const GenerationLayers = Core.GenerationLayers;
const GenerationUnavailable = Core.GenerationUnavailable;
const GenerationHandlers = Bundle.GenerationHandlers;
const ObservationSink = Core.ObservationSink;
type ObservationSink = Core.ObservationSink;
const SessionLayer = Core.SessionLayer;
const ToolCatalog = Core.ToolCatalog;
type ToolCatalog = Core.ToolCatalog;
const makeObservationBus = Core.makeObservationBus;
const makeSessionGenerations = Core.makeSessionGenerations;
const scopeObservation = Core.scopeObservation;
type GenerationBundle = Core.GenerationBundle;
type SessionError = Core.SessionError;
type SessionRuntime = Core.SessionRuntime;
const compilePolicySnapshot = Core.compilePolicySnapshot;
import { LedgerAction, type AnyToolDefinition, type LedgerSession, type SessionGeneration } from "@openomni/protocol";
import { Context, Effect, Layer, Scope, Semaphore } from "effect";

import { catalogDelegationReads, delegationGuardHandlers } from "../bundles/delegation-policy";
import { catalogDefinitions, type ToolPorts } from "../tools/core/catalog";
import { AppLedger, type SessionKernel } from "./cluster-runtime";
import { ComposedGeneration, type ComposedContext } from "./composed";
import { AppPointTable } from "./point-table";
import { captureNow } from "./platform";

/**
 * The live `GenerationHandlers` for one composed generation (#1255 P3): the
 * kernel's built-in handlers plus every handler the generation's capabilities
 * and bundles registered. A handler with an `apply` function is a transformer;
 * anything else is an obligation marker. Kernel names win a collision — the
 * generation's `kernel/*` registrations are declarations of intent to use
 * them, not replacements.
 */
function composedPolicyRegistry(
  generation: Bundle.Generation,
  live: Readonly<Record<string, { decide: Core.NamedGuard["decide"] }>> = {},
): Core.HandlerTable {
  const transformers = [...Core.KERNEL_POLICY_REGISTRY.transformers];
  const obligations = [...Core.KERNEL_POLICY_REGISTRY.obligations];
  const known = new Set([...transformers, ...obligations].map((entry) => entry.name));
  const guards = [...(Core.KERNEL_POLICY_REGISTRY.guards ?? [])];
  // #1258: a bundle contract's guard face is a declaration; the composition
  // binds the live doors here (catalog reads), like catalog tool ports. They
  // register unconditionally so a persisted guard row always compiles — the
  // row itself only exists while its bundle is composed on.
  for (const [name, guard] of Object.entries(live)) {
    if (known.has(name)) continue;
    known.add(name);
    guards.push({ name, decide: guard.decide });
  }
  for (const [name, handler] of generation.handlers) {
    if (known.has(name)) continue;
    known.add(name);
    if ("apply" in handler && typeof handler.apply === "function")
      transformers.push({ name, apply: handler.apply as Core.NamedTransformer["apply"] });
    else if ("decide" in handler && typeof handler.decide === "function")
      // A consulted gate guard (#1258): the handler decides per input.
      guards.push({ name, decide: handler.decide as Core.NamedGuard["decide"] });
    else obligations.push({ name });
  }
  return { transformers, obligations, guards };
}

export type CatalogSelection = (definitions: readonly AnyToolDefinition[]) => readonly AnyToolDefinition[];

/** App sessions carry a Layer recipe alongside the schema-only materialization surface. */
export interface GenerationDefinitions extends Readonly<Record<LedgerSession.Role, readonly AnyToolDefinition[]>> {
  readonly catalogLayer?: (select: CatalogSelection) => Layer.Layer<ToolCatalog>;
}

/** The generation manager builds this Layer once per generation and retains its acquired service. */
export function toolCatalogLayer(ports: ToolPorts, select: CatalogSelection = (definitions) => definitions) {
  return Layer.sync(ToolCatalog, () => ({ definitions: Object.freeze([...select(catalogDefinitions(ports))]) }));
}

/**
 * The composed ON bundles' Layers over the seed, in composition order, each
 * provided the seed plus every earlier bundle's outputs. A bundle Layer fails
 * only with the typed `SessionError` its contract declares (`Bundle.BundleLayer`);
 * a defect stays a defect.
 */
function bundleLayerStack<E>(
  context: ComposedContext,
  seed: Layer.Layer<Core.BundleLayerServices, E>,
): Layer.Layer<Core.BundleLayerServices, E | Core.SessionError> {
  let stack: Layer.Layer<Core.BundleLayerServices, E | Core.SessionError> = seed;
  for (const name of context.generation.bundles) {
    const layer = context.manifest.bundles.find((bundle) => bundle.name === name)?.layer;
    if (layer === undefined) continue;
    stack = layer.pipe(Layer.provideMerge(stack));
  }
  return stack;
}

/** The app owns construction; the package manager alone owns acquired contexts. */
export const GenerationLayersLive = Layer.effect(GenerationLayers, Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const plane = yield* AppLedger;
  const pointTable = yield* AppPointTable;
  const composed = yield* ComposedGeneration;
  const process = yield* Effect.context<Entropy | ObservationSink>();
  const root = Context.get(process, ObservationSink);
  const entropy = Context.get(process, Entropy);
  const now = yield* captureNow;
  const lock = yield* Semaphore.make(1);
  const managers = new Map<string, Effect.Success<ReturnType<typeof makeSessionGenerations>>>();
  let definitions: GenerationDefinitions | undefined;
  let stopping = false;

  function bundle(sessionId: string, snapshot: SessionGeneration.Snapshot): Effect.Effect<GenerationBundle, SessionError> {
    return Effect.gen(function* () {
      if (definitions === undefined) return yield* new AgentFailure({ operation: "generation.initialize", cause: "not_initialized" });
      const generation = composed.current().generation;
      const role = plane.openKernel(sessionId).row(sessionId).role;
      const offered = new Set(snapshot.tools.map((tool) => tool.name));
      // Bundle tools join the pool AFTER the composition-wired catalog: a
      // bundle face sharing a catalog tool's name (the monitor tool) defers to
      // the ported catalog definition; bundle-only tools ride in as declared.
      const select = (tools: readonly AnyToolDefinition[]) => {
        const pool = [...tools];
        for (const tool of generation.tools) if (!pool.some((existing) => existing.name === tool.name)) pool.push(tool);
        return pool.filter(
          (tool) => offered.has(tool.name) && (tool.visibility.model.includes(role) || tool.visibility.cell.includes(role)),
        );
      };
      const source = definitions;
      const catalog = Layer.suspend(() => source.catalogLayer === undefined
        ? Layer.sync(ToolCatalog, () => ({ definitions: Object.freeze(select(source[role])) }))
        : source.catalogLayer(select));
      let active = false;
      // One PubSub bus per generation (#1249): built in the generation Layer's
      // Scope, whose closure shuts the PubSub down and interrupts every
      // subscriber drain; the finalizer gates publishes off first.
      const observations = Layer.effect(ObservationSink, Effect.gen(function* () {
        const bus = yield* makeObservationBus({ id: entropy.id, now });
        yield* Effect.addFinalizer(() => Effect.sync(() => { active = false; }));
        const sink: Context.Service.Shape<typeof ObservationSink> = {
          publish: (event, data) => { if (active) { bus.sink.publish(event, data); root.publish(event, data); } },
          subscribe: bus.sink.subscribe,
          scope: (identity) => scopeObservation(sink, identity, { id: entropy.id, now }),
        };
        return sink;
      }));
      const seed = Layer.mergeAll(Layer.succeedContext(process), catalog, observations);
      const seeded = Layer.succeed(
        GenerationHandlers,
        composedPolicyRegistry(generation, delegationGuardHandlers(catalogDelegationReads(
          plane.listSessions,
          // #1258 M-4: a child is active while work is in flight — an open
          // turn or an undelivered inbox message, both durable journal facts.
          (childId) => {
            const kernel = plane.openKernel(childId);
            return kernel.latestOpenTurn(childId) !== undefined ||
              kernel.pendingMessages(childId).length > 0;
          },
        ))),
      ).pipe(Layer.provideMerge(seed));
      // #1255 P3: the composed ON bundles' Layers acquire INSIDE this
      // generation's Scope in composition order, each provided the seed plus
      // every earlier bundle's outputs — the per-generation resource semantics
      // the deleted runtime bundle plane carried. Acquisition failure is the
      // typed candidate failure `configure`/`capture` unwinds on.
      const registry = bundleLayerStack(composed.current(), seeded);
      const layer = Layer.unwrap(Effect.gen(function* () {
        const registry = yield* GenerationHandlers;
        const policy = yield* Effect.try({
          try: () => compilePolicySnapshot({ rows: plane.openKernel(sessionId).policyRows(snapshot.policyGeneration), generation: snapshot.policyGeneration, kinds: LedgerAction.Kind.options, registry, table: pointTable }),
          catch: String,
        }).pipe(Effect.mapError((cause) => new AgentFailure({ operation: "generation.policy", cause })));
        return Layer.succeed(SessionLayer, { snapshot, policy });
      })).pipe(Layer.provideMerge(registry));
      return { id: { sessionId, generation: snapshot.generation }, snapshot, layer, activate: Effect.sync(() => { active = true; }) };
    });
  }

  function manager(sessionId: string) {
    return lock.withPermits(1)(Effect.gen(function* () {
      if (stopping) return yield* new AgentFailure({ operation: "generation.capture", cause: "draining" });
      let owner = managers.get(sessionId);
      if (owner === undefined) {
        const initial = yield* bundle(sessionId, plane.openKernel(sessionId).latestGenerationFor(sessionId));
        owner = yield* makeSessionGenerations(initial).pipe(Scope.provide(scope));
        managers.set(sessionId, owner);
      }
      return owner;
    }));
  }

  return {
    initialize: (input: GenerationDefinitions) => Effect.suspend(() => {
      if (definitions !== undefined) return Effect.fail(new AgentFailure({ operation: "generation.initialize", cause: "already_initialized" }));
      definitions = Object.freeze({ resident: Object.freeze([...input.resident]), worker: Object.freeze([...input.worker]), catalogLayer: input.catalogLayer });
      return Effect.void;
    }),
    capture: (id: SessionGeneration.Id) => Effect.gen(function* () {
      const owner = yield* manager(id.sessionId);
      const snapshot = plane.openKernel(id.sessionId).generationFor(id.sessionId, id.generation);
      if (snapshot === undefined) return yield* new GenerationUnavailable({ generation: id.generation });
      return yield* owner.capture(yield* bundle(id.sessionId, snapshot));
    }),
    configure: <A>(id: SessionGeneration.Id, snapshot: SessionGeneration.Snapshot, commit: Effect.Effect<A, SessionError>) => Effect.gen(function* () {
      if (id.generation !== snapshot.generation) return yield* new AgentFailure({ operation: "generation.configure", cause: "snapshot_identity_mismatch" });
      const owner = yield* manager(id.sessionId);
      return yield* owner.configure(yield* bundle(id.sessionId, snapshot), commit);
    }),
    settle: Effect.suspend(() =>
      Effect.forEach([...managers.values()], (owner) => owner.settle, { discard: true }),
    ),
    drain: lock.withPermits(1)(Effect.gen(function* () {
      stopping = true;
      yield* Effect.forEach(managers.values(), (owner) => owner.drain, { discard: true });
    })),
  };
}));

/**
 * The app's `session.configure` authority: evaluate the session's captured
 * generation Layer's pinned pre-policy. Deny (or any non-allow verdict) fails
 * closed; there is no callback fallback.
 */
export function configureAuthority(
  generations: Context.Service.Shape<typeof GenerationLayers>,
  openKernel: (sessionId: string) => SessionKernel,
): SessionRuntime["authorizeConfigure"] {
  return (input) => Effect.scoped(Effect.gen(function* () {
    const captured = yield* generations.capture({
      sessionId: input.sessionId,
      generation: openKernel(input.sessionId).latestGenerationFor(input.sessionId).generation,
    });
    const { policy } = yield* captured.provide(SessionLayer);
    return policy.evaluate({
      kind: "session.configure", phase: "pre", op: input.operation,
      role: input.role, sessionId: input.sessionId,
      value: { op: input.operation, generation: input.generation },
    }).verdict === "allow";
  }));
}
