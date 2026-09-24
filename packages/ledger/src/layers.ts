import type { ObservationSink } from "@openomni/protocol";
import { Effect, Layer } from "effect";
import { ForeignFailure, StorageUnavailable } from "./errors";
import { LedgerWrites } from "./services";
import { initialize } from "./storage/initialize";
import { Storage } from "./storage/storage";

export function LedgerStorageLive(options: {
  readonly dbPath: string;
  readonly observationSink?: ObservationSink;
}): Layer.Layer<LedgerWrites, ForeignFailure | StorageUnavailable> {
  return Layer.unwrapScoped(
    Effect.gen(function* () {
      const storage = yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            initialize(options);
            return Storage.get();
          },
          catch: (cause) => new ForeignFailure({ operation: "ledger.open", cause: String(cause) }),
        }),
        () =>
          Effect.try({
            try: () => Storage.reset(),
            catch: (cause) =>
              new ForeignFailure({ operation: "ledger.close", cause: String(cause) }),
          }).pipe(Effect.orDie),
      );
      return LedgerLive(storage);
    }),
  );
}

export function LedgerLive(
  storage: Storage.Adapter,
): Layer.Layer<LedgerWrites, StorageUnavailable> {
  return Layer.effect(
    LedgerWrites,
    Effect.gen(function* () {
      const { sessions, inbox, alarms } = storage;
      if (sessions === undefined)
        return yield* Effect.fail(new StorageUnavailable({ capability: "sessions" }));
      if (inbox === undefined)
        return yield* Effect.fail(new StorageUnavailable({ capability: "inbox" }));
      if (alarms === undefined)
        return yield* Effect.fail(new StorageUnavailable({ capability: "alarms" }));
      return { sessions, inbox, alarms };
    }),
  );
}
