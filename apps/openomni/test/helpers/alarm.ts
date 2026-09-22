import { Effect, Either, Exit, Scope } from "effect";
import { createObservationBus, createSessionRequests } from "@openomni/agent";
import { SessionHandleStore, SqliteStorageAdapter, Storage } from "@openomni/ledger";
import { type Alarm, L0Observation, type Inbox } from "@openomni/protocol";
import { createAlarmWorker } from "../../src/composition/alarm-worker";
import { runEffect } from "./effect";

type AlarmWorker = Effect.Effect.Success<ReturnType<typeof createAlarmWorker>>;

export function alarmWorkerFixture(
  options: Parameters<typeof createAlarmWorker>[0],
): { readonly worker: AlarmWorker; readonly close: () => Promise<void> } {
  const scope = Effect.runSync(Scope.make());
  const worker = Effect.runSync(
    Effect.provideService(createAlarmWorker(options), Scope.Scope, scope),
  );
  return {
    worker,
    async close() {
      await runEffect(worker.close());
      await runEffect(Scope.close(scope, Exit.succeed(undefined)));
    },
  };
}

export function alarmFixture(
  path = ":memory:",
  onFailure?: (error: Error) => void,
  onWake?: (id: string) => void,
) {
  const events = createObservationBus();
  const storage = new SqliteStorageAdapter(path, events);
  Storage.configure(storage);
  Either.getOrThrowWith(
    Effect.runSync(
      Effect.either(
        storage.sessions.create({
          id: "monitor-session",
          parentId: null,
          role: "resident",
          state: "idle",
          revision: 0,
          leaseOwner: null,
          leaseFence: 0,
          leaseExpiresAt: null,
          toolsGeneration: 0,
          systemHash: "",
          policyGeneration: 1,
        }),
      ),
    ),
    (error) => error,
  );
  let at = 1000;
  const errors: Error[] = [];
  const wakes: string[] = [];
  const workerFixture = alarmWorkerFixture({
    alarms: storage.alarms,
    observations: events,
    clock: () => at,
    schedule: () => () => undefined,
    requestTimeout: createSessionRequests({ observations: events, clock: () => at }).timeout,
    failure: (error) => {
      errors.push(error);
      onFailure?.(error);
    },
    wake: (id) => {
      wakes.push(id);
      onWake?.(id);
      return Effect.void;
    },
  });
  const worker = workerFixture.worker;
  /** A committed one-shot retry.scheduled alarm, due at the fixture clock. */
  function armRetry(id: string) {
    const row = Either.getOrThrowWith(
      Effect.runSync(
        Effect.either(
          storage.alarms.arm({
            id,
            sessionId: "monitor-session",
            kind: "at",
            fireAt: at,
            spec: {
              encodingVersion: 1,
              value: {
                kind: "retry.scheduled",
                attempt: 1,
                reason: "transient_error",
                notBefore: at,
              },
            },
          }),
        ),
      ),
      (error) => error,
    );
    if (row === undefined) throw new Error("fixture retry arm refused");
    return row;
  }
  function arm(id: string, watch: Alarm.Watch, limit = 8) {
    const row = Either.getOrThrowWith(
      Effect.runSync(
        Effect.either(
          storage.alarms.arm({
            id,
            sessionId: "monitor-session",
            kind: "watch",
            fireAt: at,
            spec: {
              encodingVersion: 1,
              value: { watch, notificationLimit: limit, policyGeneration: 1 },
            },
          }),
        ),
      ),
      (error) => error,
    );
    if (row === undefined) throw new Error("fixture arm refused");
    return row;
  }
  function next(
    id: string,
    predicate: (row: Inbox.Row) => boolean = () => true,
  ): Promise<Inbox.Row> {
    const signal = AbortSignal.timeout(5000);
    return new Promise((resolve, reject) => {
      const abort = () => {
        unsubscribe();
        reject(
          new Error(
            `no alarm inbox for ${id}: ${JSON.stringify({ alarm: storage.alarms.get(id), inbox: storage.inbox.list("monitor-session"), errors: errors.map((error) => error.message) })}`,
          ),
        );
      };
      const unsubscribe = events.subscribe(L0Observation.ActionCommittedEvent, (event) => {
        if (event.kind !== "prompt") return;
        const row = storage.inbox.list("monitor-session").find((entry) => entry.id === event.id);
        if (row === undefined || row.origin.value !== id || !predicate(row)) return;
        unsubscribe();
        signal.removeEventListener("abort", abort);
        resolve(row);
      });
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  return {
    storage,
    events,
    worker,
    run: <A, E>(effect: Effect.Effect<A, E, never>): A => Effect.runSync(effect),
    arm,
    armRetry,
    next,
    errors,
    wakes,
    advance(value: number) {
      at = value;
    },
    rows: () => SessionHandleStore.inboxRows("monitor-session"),
    async close() {
      await workerFixture.close();
      Storage.reset();
    },
  };
}
