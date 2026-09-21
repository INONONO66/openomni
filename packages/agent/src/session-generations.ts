import type { SessionGeneration } from "@openomni/protocol";
import { Context, Effect, Exit, Layer, Scope, SynchronizedRef } from "effect";
import { GenerationUnavailable, type SessionError } from "./errors";
import { createRawSlots } from "./executor-raw";
import { SessionLayer, ToolCatalog } from "./services";

export type GenerationServices = SessionLayer | ToolCatalog;
export interface GenerationBundle {
  readonly snapshot: SessionGeneration.Snapshot;
  readonly layer: Layer.Layer<GenerationServices, SessionError>;
}

export class GenerationRawSlots extends Context.Tag("@openomni/agent/GenerationRawSlots")<
  GenerationRawSlots,
  ReturnType<typeof createRawSlots>
>() {}

interface Entry {
  readonly bundle: GenerationBundle;
  readonly context: Context.Context<GenerationServices>;
  readonly scope: Scope.CloseableScope;
  readonly owners: number;
  readonly retired: boolean;
}
interface Generations {
  readonly current: number;
  readonly entries: ReadonlyMap<number, Entry>;
}

/** The session Scope owns retirement; a turn captures one immutable Layer context. */
export function makeSessionGenerations(initial: GenerationBundle) {
  return Effect.gen(function* () {
    const sessionScope = yield* Effect.scope;
    const entry = yield* acquire(initial);
    const state = yield* SynchronizedRef.make<Generations>({
      current: initial.snapshot.generation,
      entries: new Map([[initial.snapshot.generation, entry]]),
    });
    yield* Effect.addFinalizer(() => SynchronizedRef.get(state).pipe(
      Effect.flatMap((value) => Effect.forEach(value.entries.values(),
        (item) => Scope.close(item.scope, Exit.void), { discard: true })),
    ));

    function release(generation: number) {
      return SynchronizedRef.modify(state, (value) => {
        const old = value.entries.get(generation);
        if (old === undefined) return [undefined, value] as const;
        const next = { ...old, owners: old.owners - 1 };
        const entries = new Map(value.entries);
        if (next.retired && next.owners === 0) entries.delete(generation);
        else entries.set(generation, next);
        return [next.retired && next.owners === 0 ? next.scope : undefined, { ...value, entries }] as const;
      }).pipe(Effect.flatMap((scope) => scope === undefined ? Effect.void : Scope.close(scope, Exit.void)));
    }

    function capture(generation?: number) {
      return SynchronizedRef.modifyEffect(state, (value) => {
        const id = generation ?? value.current;
        const captured = value.entries.get(id);
        if (captured === undefined || captured.retired)
          return Effect.fail(new GenerationUnavailable({ generation: id }));
        const entries = new Map(value.entries).set(id, { ...captured, owners: captured.owners + 1 });
        return Effect.succeed([captured, { ...value, entries }] as const);
      }).pipe(Effect.flatMap((captured) => Effect.gen(function* () {
        const slots = createRawSlots();
        yield* Effect.addFinalizer(() => {
          const done = release(captured.bundle.snapshot.generation);
          if (slots.pending() === 0) return done;
          return Effect.forkIn(
            Effect.interruptible(slots.awaitSettled).pipe(Effect.ensuring(done)), sessionScope,
          ).pipe(Effect.asVoid);
        });
        return {
          snapshot: captured.bundle.snapshot,
          layer: captured.bundle.layer,
          provide: <A, E, R>(work: Effect.Effect<A, E, R>) => work.pipe(
            Effect.provide(captured.context), Effect.provideService(GenerationRawSlots, slots),
          ),
        };
      })));
    }

    function configure<A>(bundle: GenerationBundle, commit: Effect.Effect<A, SessionError>) {
      return Effect.uninterruptible(SynchronizedRef.modifyEffect(state, (value) => Effect.gen(function* () {
        const next = yield* acquire(bundle);
        const receipt = yield* commit.pipe(Effect.onError(() => Scope.close(next.scope, Exit.void)));
        const entries = new Map(value.entries);
        const old = entries.get(value.current);
        if (old !== undefined) {
          if (old.owners === 0) entries.delete(value.current);
          else entries.set(value.current, { ...old, retired: true });
        }
        entries.set(bundle.snapshot.generation, next);
        return [{ receipt, closing: old?.owners === 0 ? old.scope : undefined }, {
          current: bundle.snapshot.generation, entries,
        }] as const;
      })).pipe(Effect.flatMap(({ receipt, closing }) =>
        (closing === undefined ? Effect.void : Scope.close(closing, Exit.void)).pipe(Effect.as(receipt)))));
    }
    return { capture, configure };
  });
}

function acquire(bundle: GenerationBundle): Effect.Effect<Entry, SessionError> {
  return Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(bundle.layer, scope).pipe(
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );
    return { bundle, context, scope, owners: 0, retired: false };
  });
}
