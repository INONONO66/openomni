import { Effect } from "effect";
import { Storage, StorageUnavailable } from "@openomni/ledger";
import { CommitFailed } from "./errors";

export interface RetryAlarmPort {
  arm(input: {
    readonly id: string;
    readonly attempt: number;
    readonly reason: string;
    readonly fireAt: number;
  }): Effect.Effect<void, CommitFailed>;
  wait(fireAt: number, signal?: AbortSignal): Effect.Effect<void>;
  settle(id: string): Effect.Effect<void, CommitFailed>;
}

export function createRetryAlarmPort(sessionId: string, clock: () => number): RetryAlarmPort {
  const alarms = Effect.suspend(() => {
    const adapter = Storage.get().alarms;
    return adapter === undefined
      ? Effect.fail(new StorageUnavailable({ capability: "alarms" }))
      : Effect.succeed(adapter);
  });
  return {
    arm: (input) => alarms.pipe(
      Effect.flatMap((adapter) => adapter.arm({
        id: input.id, sessionId, kind: "at", fireAt: input.fireAt,
        spec: { encodingVersion: 1, value: {
          kind: "retry.scheduled", attempt: input.attempt, reason: input.reason, notBefore: input.fireAt,
        } },
      })),
      Effect.mapError((error) => new CommitFailed({ error })), Effect.asVoid,
    ),
    wait: (fireAt, signal) => Effect.suspend(() => {
      const sleep = Effect.sleep(Math.max(0, fireAt - clock()));
      if (signal === undefined) return sleep;
      const aborted = Effect.async<never>((resume) => {
        const abort = () => resume(Effect.interrupt);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        return Effect.sync(() => signal.removeEventListener("abort", abort));
      });
      return sleep.pipe(Effect.raceFirst(aborted));
    }),
    settle: (id) => alarms.pipe(
      Effect.flatMap((adapter) => adapter.cancel(id, sessionId, clock())),
      Effect.catchTag("AlarmRefused", (error) =>
        error.reason === "state" || error.reason === "missing" ? Effect.void : Effect.fail(error)),
      Effect.mapError((error) => new CommitFailed({ error })), Effect.asVoid,
    ),
  };
}
