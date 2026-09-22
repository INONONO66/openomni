import { Effect, Fiber, Queue } from "effect";
import type { AlarmWriteAdapter, LedgerError } from "@openomni/ledger";
import type { ExecutionError, SessionError } from "@openomni/agent";
import { canonicalDigest, L0Observation, Alarm, type ObservationSink } from "@openomni/protocol";
import {
  AlarmRuntimeError,
  AlarmSourceError,
  assertAlarmRuntime,
  commandSource,
  pathSource,
  type AlarmSource,
} from "./alarm-sources";

type Failure = LedgerError | SessionError | AlarmSourceError;
interface Running {
  readonly row: Alarm.Row;
  readonly source: AlarmSource;
}

/** Native source ownership. Foreign callbacks only enqueue work in the app-owned scope. */
export function createAlarmWorker(options: {
  readonly alarms: AlarmWriteAdapter;
  readonly observations: Required<Pick<ObservationSink, "subscribe">>;
  readonly wake: (sessionId: string) => Effect.Effect<void, SessionError>;
  readonly requestTimeout: (requestId: string, at: number) => Effect.Effect<void, ExecutionError>;
  readonly failure: (error: Error) => void;
  readonly clock?: () => number;
  readonly schedule?: (tick: () => void) => () => void;
}) {
  return Effect.gen(function* () {
    yield* Effect.try({ try: assertAlarmRuntime, catch: () => new AlarmRuntimeError() });
    const scope = yield* Effect.scope;
    const queue = yield* Queue.unbounded<Effect.Effect<void, Failure>>();
    const now = options.clock ?? Date.now;
    const running = new Map<string, Running>();
    let stopped = false;
    let recovering = true;
    let cancelTick: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    const report = (work: Effect.Effect<void, Failure>) =>
      work.pipe(Effect.catchAll((error) => Effect.sync(() => options.failure(error))));
    const offer = (work: Effect.Effect<void, Failure>) => {
      if (!stopped) queue.unsafeOffer(work);
    };
    const consumer = yield* Effect.forkIn(
      Effect.forever(Queue.take(queue).pipe(Effect.flatMap(report))),
      scope,
    );

    function release(row: Alarm.Row): Effect.Effect<void, AlarmSourceError> {
      return Effect.suspend(() => {
        const current = running.get(row.id);
        if (current === undefined || current.row.fence !== row.fence) return Effect.void;
        running.delete(row.id);
        return Effect.tryPromise({
          try: () => current.source.close(),
          catch: () => new AlarmSourceError("source.close"),
        });
      });
    }
    function wake(id: string) {
      return Effect.forkIn(report(options.wake(id)), scope).pipe(Effect.asVoid);
    }
    function deliver(
      row: Alarm.Row,
      sourceKey: string,
      content: string,
      terminal: boolean,
      batchHash?: string,
    ): Effect.Effect<void, Failure> {
      return Effect.gen(function* () {
        if (stopped) return;
        const fired = yield* options.alarms
          .fire({
            id: row.id,
            epoch: row.epoch,
            fence: row.fence,
            sourceKey,
            at: now(),
            content,
            terminal,
            ...(batchHash === undefined ? {} : { batchHash }),
          })
          .pipe(
            Effect.catchTag("AlarmRefused", (error) =>
              error.reason === "prompt" ? Effect.fail(error) : Effect.succeed(undefined),
            ),
          );
        if (fired === undefined) return;
        if (fired.row.status !== "armed") yield* release(row);
        yield* wake(row.sessionId);
      });
    }
    function summary(
      row: Alarm.Row,
      reason: "exit" | "timeout" | "restart" | "source_error",
      exitCode: number | null,
    ) {
      return deliver(
        row,
        `${reason}:${row.fence}`,
        JSON.stringify({ alarmId: row.id, epoch: row.epoch, reason, exitCode }),
        true,
      );
    }
    function sourceFailure(row: Alarm.Row, error: Error) {
      offer(
        summary(row, "source_error", null).pipe(
          Effect.ensuring(release(row).pipe(Effect.orDie)),
          Effect.ensuring(Effect.sync(() => options.failure(error))),
        ),
      );
    }
    function startCommandWatch(
      owned: Alarm.Row,
      watch: Extract<Alarm.Watch, { command: string }>,
    ): AlarmSource {
      const filter = watch.filter === undefined ? undefined : new RegExp(watch.filter);
      let lines = 0;
      return commandSource(
        watch.command,
        (content) => {
          lines += 1;
          if (filter === undefined || filter.test(content))
            offer(
              deliver(
                owned,
                `line:${owned.fence}:${lines}`,
                content,
                false,
                canonicalDigest(content),
              ),
            );
        },
        (code) => offer(summary(owned, "exit", code)),
        (error) => sourceFailure(owned, error),
      );
    }
    function startWatch(owned: Alarm.Row, preAcquireFence: number): Effect.Effect<void, Failure> {
      return Effect.gen(function* () {
        const { watch } = Alarm.WatchSpec.parse(owned.spec?.value);
        if (watch.timeout_ms !== undefined && now() >= owned.fireAt + watch.timeout_ms)
          return yield* summary(owned, "timeout", null);
        if (recovering && preAcquireFence > 0 && watch.persistent !== true)
          return yield* summary(owned, "restart", null);
        const source = yield* Effect.try({
          try: () =>
            "command" in watch
              ? startCommandWatch(owned, watch)
              : pathSource(
                  watch,
                  (content, identity) => offer(deliver(owned, `path:${identity}`, content, false)),
                  (error) => sourceFailure(owned, error),
                ),
          catch: () => new AlarmSourceError("source.start"),
        }).pipe(
          Effect.tapError((error) =>
            summary(owned, "source_error", null).pipe(
              Effect.ensuring(Effect.sync(() => options.failure(error))),
            ),
          ),
        );
        running.set(owned.id, { row: owned, source });
      });
    }
    function consumeRetry(row: Alarm.Row) {
      return options.alarms.cancel(row.id, row.sessionId, now()).pipe(
        Effect.catchTag("AlarmRefused", () => Effect.succeed(undefined)),
        Effect.flatMap((consumed) => (consumed === undefined ? Effect.void : wake(row.sessionId))),
      );
    }
    function timerContent(row: Alarm.Row): string {
      if (row.spec === undefined) return "Alarm due";
      return typeof row.spec.value === "string" ? row.spec.value : JSON.stringify(row.spec.value);
    }
    function start(row: Alarm.Row): Effect.Effect<void, Failure> {
      return Effect.gen(function* () {
        const deadline = Alarm.RequestDeadline.safeParse(row.spec?.value);
        if (row.kind === "at" && deadline.success)
          return yield* options.requestTimeout(deadline.data.requestId, now());
        if (row.kind === "at" && Alarm.RetrySchedule.safeParse(row.spec?.value).success)
          return yield* consumeRetry(row);
        const owned = yield* options.alarms
          .acquire(row.id, row.fence)
          .pipe(Effect.catchTag("AlarmRefused", () => Effect.succeed(undefined)));
        if (owned === undefined) return;
        if (owned.kind === "at")
          return yield* deliver(owned, `timer:${owned.fireAt}`, timerContent(owned), true);
        yield* startWatch(owned, row.fence);
      });
    }
    function observe(entry: Running): Effect.Effect<void, Failure> {
      return Effect.gen(function* () {
        const current = options.alarms.get(entry.row.id);
        if (current?.status !== "armed" || current.fence !== entry.row.fence)
          return yield* release(entry.row);
        const { watch } = Alarm.WatchSpec.parse(current.spec?.value);
        if (watch.timeout_ms !== undefined && now() >= current.fireAt + watch.timeout_ms)
          yield* summary(current, "timeout", null);
        else entry.source.observe?.();
      });
    }
    const serial = yield* Effect.makeSemaphore(1);
    const tick = () =>
      serial.withPermits(1)(
        Effect.gen(function* () {
          if (stopped) return;
          yield* Effect.forEach(running.values(), observe, { discard: true });
          for (const row of options.alarms.due(now())) if (!running.has(row.id)) yield* start(row);
          recovering = false;
        }),
      );
    const close = () =>
      Effect.gen(function* () {
        stopped = true;
        cancelTick?.();
        unsubscribe?.();
        yield* Fiber.interrupt(consumer);
        for (const [id, entry] of running) {
          yield* options.alarms
            .acquire(id, entry.row.fence)
            .pipe(Effect.catchTag("AlarmRefused", () => Effect.void));
          yield* release(entry.row);
        }
        yield* Queue.shutdown(queue);
      });
    yield* Effect.addFinalizer(() => close().pipe(Effect.orDie));
    return {
      tick,
      close,
      start: () =>
        Effect.gen(function* () {
          if (cancelTick !== undefined) throw new Error("alarm worker already started");
          unsubscribe = options.observations.subscribe(
            L0Observation.ActionCommittedEvent,
            (payload) => {
              if (payload.kind === "alarm.arm")
                offer(
                  tick().pipe(
                    Effect.catchAllDefect(() => Effect.fail(new AlarmSourceError("bus.scan"))),
                  ),
                );
            },
          );
          yield* tick();
          cancelTick = (
            options.schedule ??
            ((callback) => {
              const timer = setInterval(callback, 1000);
              return () => clearInterval(timer);
            })
          )(() =>
            offer(
              tick().pipe(
                Effect.catchAllDefect(() => Effect.fail(new AlarmSourceError("timer.scan"))),
              ),
            ),
          );
        }),
    };
  });
}
