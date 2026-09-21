import { Effect, Layer } from "effect";
import { StorageUnavailable } from "./errors";
import { LedgerWrites } from "./services";
import type { Storage } from "./storage/storage";

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
