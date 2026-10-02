import { openCatalogStore } from "../../src/store/catalog";
import { openSessionStore } from "../../src/store/session-file";
import * as SessionHandleStore from "../../src/store/fence";
import type { LedgerSession, ObservationSink as ObservationSinkShape } from "@openomni/protocol";
import { Cause, Context, Effect, Exit, FiberSet, Layer, Scope, Stream } from "effect";
import {
  ObservationSubscriberFailure,
  type ObservationBusOptions,
  type PublishedObservation,
  makeObservationBus,
  scopeObservation,
} from "../../src/session/bus";
import { LlmLive } from "../../src/model";
import { KERNEL_POLICY_REGISTRY, SEEDED_POLICY_ROWS, compilePolicySnapshot } from "../../src/kernel/gate/compile";
import { Entropy, GenerationOwnership, ObservationSink, SessionLayer, ToolCatalog, type GenerationServices, type RunnerServices } from "../../src/kernel/ports";
import { NamedPolicyRegistry } from "../../src/kernel/bundle";
import { makeSessionGenerations, type GenerationRawSlots } from "../../src/session/run";
import { entropySource } from "./time";

type FailureReporter = (error: Error, eventName: string) => void;

type SinkService = ObservationSinkShape & Required<Pick<ObservationSinkShape, "subscribe" | "scope">>;

/** A PubSub-backed bus fixture: the protocol sink shape plus test-only taps. */
export type TestObservationBus = SinkService & {
  /** Interrupts every fixture subscription; isolates shared fixtures between cases. */
  reset(): void;
  /** Taps every published observation; returns the tap's unsubscribe. */
  observe(watcher: (observation: PublishedObservation) => void): () => void;
};

/** Fixture buses outlive any one test; this process-lifetime Scope owns them. */
const fixtureScope = Effect.runSync(Scope.make());

/**
 * Builds one PubSub observation bus fixture (#1249) in the process-lifetime
 * fixture Scope. Callback subscriptions ride a fixture-owned FiberSet so
 * `reset()` can interrupt every leftover tap between test cases.
 */
export function testBusService(options: ObservationBusOptions): TestObservationBus {
  const { bus, taps, fork } = Effect.runSync(
    Effect.gen(function* () {
      const bus = yield* makeObservationBus(options);
      const taps = yield* FiberSet.make<void, never>();
      const fork = yield* FiberSet.runtime(taps)<never>();
      return { bus, taps, fork };
    }).pipe(Scope.provide(fixtureScope)),
  );
  const drain = <T>(
    stream: Effect.Effect<Stream.Stream<T>, never, Scope.Scope>,
    deliver: (item: T) => void,
    eventName: string,
  ): (() => void) => {
    const fiber = fork(
      Effect.scoped(Effect.flatMap(stream, Stream.runForEach((item) =>
        Effect.suspend(() => {
          try {
            deliver(item);
            return Effect.void;
          } catch (cause) {
            const error = cause instanceof Error ? cause : new Error(String(cause));
            if (options.onError !== undefined) {
              const report = options.onError;
              return Effect.sync(() => report(error, eventName));
            }
            return Effect.logError(new ObservationSubscriberFailure({ eventName, cause: String(error) }));
          }
        })))),
    );
    return () => fiber.interruptUnsafe();
  };
  const fixture: TestObservationBus = {
    publish: bus.sink.publish,
    subscribe: (event, handler, subscribeOptions) =>
      drain(bus.stream(event, subscribeOptions), handler, event.name),
    scope: (identity) => scopeObservation(fixture, identity, options),
    observe: (watcher) => drain(bus.observations, watcher, "*"),
    reset: () => {
      for (const fiber of taps) fiber.interruptUnsafe();
    },
  };
  return fixture;
}

/** A bus fixture over deterministic counter sources (#1245: injected, never ambient). */
export function testBus(onError?: FailureReporter): TestObservationBus {
  let id = 0;
  let time = 0;
  return testBusService({
    id: () => `event-${++id}`,
    now: () => ++time,
    ...(onError === undefined ? {} : { onError }),
  });
}

/** The generation-shaped service context every isolated agent program runs under. */
export const runnerTestLayer = Layer.mergeAll(
  LlmLive, Layer.succeed(Entropy, entropySource("runner")),
  Layer.effectContext(Effect.gen(function* () {
    const snapshot = SessionHandleStore.generationSnapshot({ generation: 1, revertTo: 0, tools: [], system: { preset: "", blocks: [] }, policyGeneration: 1 });
    const policy = compilePolicySnapshot({ registry: KERNEL_POLICY_REGISTRY, generation: 1, rows: SEEDED_POLICY_ROWS.map((row) => ({ ...row, generation: 1 })) });
    const sink = (yield* makeObservationBus({ id: entropySource("runner-event").id, now: () => 0 })).sink;
    const owner = yield* makeSessionGenerations({ id: { sessionId: "fixture", generation: 1 }, snapshot, activate: Effect.void,
      layer: Layer.mergeAll(Layer.succeed(SessionLayer, { snapshot, policy }), Layer.succeed(ToolCatalog, { definitions: [] }),
        Layer.succeed(ObservationSink, sink), Layer.succeed(NamedPolicyRegistry, KERNEL_POLICY_REGISTRY)) });
    const captured = yield* owner.capture();
    const context = yield* captured.provide(Effect.context<GenerationServices | GenerationOwnership | GenerationRawSlots>());
    return Context.pick(SessionLayer, ToolCatalog, ObservationSink, NamedPolicyRegistry, GenerationOwnership)(context);
  })),
);

/**
 * One isolation's handle-scoped ledger (W5.2 F1): a fresh in-memory session
 * store shared by every session the test declares plus a fresh catalog, with
 * one observation bus wired as the stores' commit sink so `watch` planes see
 * ActionCommitted events. `openKernel` serves every session from the shared
 * store — the per-session-file split is a production layout, not a kernel
 * contract, and agent tests exercise the kernel contract.
 */
export interface IsolatedLedger {
  readonly kernel: SessionHandleStore.SessionKernel;
  readonly openKernel: (sessionId: string) => SessionHandleStore.SessionKernel;
  readonly listSessions: () => LedgerSession.Row[];
  readonly session: ReturnType<typeof openSessionStore>;
  readonly catalog: ReturnType<typeof openCatalogStore>;
  readonly bus: TestObservationBus;
}

export type IsolatedLedgerHandle = IsolatedLedger & { close: () => void };

function makeIsolatedLedger(): IsolatedLedgerHandle {
  const bus = testBus();
  let now = 0;
  const storeOptions = { now: () => (now += 1), observationSink: bus };
  const session = openSessionStore(":memory:", storeOptions);
  const catalog = openCatalogStore(":memory:", storeOptions);
  const kernel = SessionHandleStore.createSessionKernel(session, catalog);
  const materialize = kernel.materialize;
  // Match the app composition's catalog registration for this shared-file fixture.
  kernel.materialize = (input) => materialize(input).pipe(Effect.tap(() => Effect.sync(() => {
    catalog.indexSession({ id: input.id, parentId: input.parentId, role: input.role, createdAt: input.at });
  })));
  return {
    kernel,
    openKernel: () => kernel,
    listSessions: () => kernel.listRows(),
    session,
    catalog,
    bus,
    close: () => {
      session.close();
      catalog.close();
    },
  };
}

let active: IsolatedLedger | undefined;
let chain: Promise<void> = Promise.resolve();

/** The isolation currently executing; helpers resolve their kernel lazily through this. */
export function isolatedLedger(): IsolatedLedger {
  if (active === undefined) throw new Error("isolatedLedger() is only available inside isolated()");
  return active;
}

type IsolatedProgram<A, E> = Effect.Effect<A, E, import("effect").Scope.Scope | RunnerServices>;

/** Execute a provided synchronous test program without changing its failure channel. */
export function runTestSync<A, E>(program: Effect.Effect<A, E>): A {
  return Effect.runSync(program);
}

function settled<A, E>(exit: Exit.Exit<A, E>): A {
  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
  return exit.value;
}

/** Execute a synchronous test program with a squashed failure cause. */
export function runAgentSync<A, E>(program: Effect.Effect<A, E>): A {
  return settled(Effect.runSyncExit(program));
}

/** Execute an asynchronous test program with a squashed failure cause. */
export async function runAgent<A, E>(program: Effect.Effect<A, E>): Promise<A> {
  return settled(await Effect.runPromiseExit(program));
}

/** Execute an asynchronous test program with its original runner failure semantics. */
export function runTestPromise<A, E>(program: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(program);
}

/** Execute an asynchronous test program and surface its Exit (#1246: model helpers delegate here). */
export function runTestExit<A, E>(program: Effect.Effect<A, E>): Promise<Exit.Exit<A, E>> {
  return Effect.runPromiseExit(program);
}

/**
 * Runs one scoped Effect program against a fresh handle-scoped ledger; the
 * only test-side runner for agent programs. Concurrent calls serialize so the
 * lazy `isolatedLedger()` pointer always names exactly one isolation.
 * NEVER nest isolated() inside a running isolated program: the module-level
 * chain serializes all calls, so the inner call deadlocks the whole process.
 */
export function isolated<A, E>(
  program: IsolatedProgram<A, E> | ((ledger: IsolatedLedger) => IsolatedProgram<A, E>),
  makeLedger: () => IsolatedLedgerHandle = makeIsolatedLedger,
): Promise<A> {
  const run = async () => {
    const ledger = makeLedger();
    active = ledger;
    try {
      const effect = typeof program === "function" ? program(ledger) : program;
      return await Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(runnerTestLayer))));
    } finally {
      active = undefined;
      ledger.close();
    }
  };
  const result = chain.then(run, run);
  chain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** The isolation currently executing, if any; crash mains reuse it instead of nesting. */
export function activeIsolation(): IsolatedLedger | undefined {
  return active;
}

type IsolatedOutcome<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly thrown: Error };

/**
 * Promise-shaped isolation for imperative crash mains and matrix cells: the
 * same fresh-ledger contract as `isolated`, with thrown-error identity
 * preserved (no FiberFailure wrapping).
 */
export function isolatedRun<A>(
  fn: (ledger: IsolatedLedger) => Promise<A> | A,
  makeLedger: () => IsolatedLedgerHandle = makeIsolatedLedger,
): Promise<A> {
  return isolated<IsolatedOutcome<A>, never>(
    (ledger) =>
      Effect.promise(async (): Promise<IsolatedOutcome<A>> => {
        try {
          return { ok: true, value: await fn(ledger) };
        } catch (thrown) {
          return { ok: false, thrown: thrown instanceof Error ? thrown : new Error(String(thrown)) };
        }
      }),
    makeLedger,
  ).then((outcome) => {
    if (outcome.ok) return outcome.value;
    throw outcome.thrown;
  });
}
