import { Bus } from "@openomni/agent";
import { initialize, LedgerLive, LedgerWrites, type LedgerError, Storage } from "@openomni/ledger";
import { Context, Data, Effect, Layer, ManagedRuntime, Scope, flow } from "effect";

export class AppLifecycleFailure extends Data.TaggedError("AppLifecycleFailure")<{
  readonly operation: string;
  readonly cause: string;
}> {}

export const lifecycleFailure = (operation: string) =>
  flow(String, (cause) => new AppLifecycleFailure({ operation, cause }));

export class AppClock extends Context.Tag("openomni/AppClock")<
  AppClock,
  { readonly now: () => number }
>() {}

export class AppEntropy extends Context.Tag("openomni/AppEntropy")<
  AppEntropy,
  { readonly next: () => string }
>() {}

export class AppObservations extends Context.Tag("openomni/AppObservations")<
  AppObservations,
  typeof Bus
>() {}

export class AppScope extends Context.Tag("openomni/AppScope")<AppScope, Scope.Scope>() {}

export interface AppRuntimeOptions {
  readonly dbPath: string;
  readonly clock?: () => number;
  readonly entropy?: () => string;
  readonly observations?: typeof Bus;
}

export function AppLive(options: AppRuntimeOptions) {
  const observations = options.observations ?? Bus;
  const ledger = Layer.unwrapScoped(
    Effect.gen(function* () {
      const storage = yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            initialize({ dbPath: options.dbPath, observationSink: observations });
            return Storage.get();
          },
          catch: lifecycleFailure("ledger.open"),
        }),
        () =>
          Effect.try({ try: () => Storage.reset(), catch: lifecycleFailure("ledger.close") }).pipe(
            Effect.orDie,
          ),
      );
      return LedgerLive(storage);
    }),
  );
  return Layer.mergeAll(
    Layer.scoped(AppScope, Effect.scope).pipe(Layer.provideMerge(ledger)),
    Layer.succeed(AppClock, { now: options.clock ?? Date.now }),
    Layer.succeed(AppEntropy, { next: options.entropy ?? (() => crypto.randomUUID()) }),
    Layer.succeed(AppObservations, observations),
  );
}

export type AppServices = AppClock | AppEntropy | AppObservations | LedgerWrites | AppScope;
export type AppRuntimeError = AppLifecycleFailure | LedgerError;
export type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, AppRuntimeError>;

export function createAppRuntime(live: Layer.Layer<AppServices, AppRuntimeError>): AppRuntime {
  const runtime = ManagedRuntime.make(live);
  const dispose = runtime.dispose.bind(runtime);
  let disposal: Promise<void> | undefined;
  return Object.assign(runtime, { dispose: () => (disposal ??= dispose()) });
}
