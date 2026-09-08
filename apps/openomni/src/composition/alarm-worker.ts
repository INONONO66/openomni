import { AsyncResource } from "node:async_hooks";
import {
  canonicalDigest,
  L0Observation,
  Alarm,
  type ObservationSink,
  type Storage,
} from "@openomni/protocol";
import {
  AlarmSourceError,
  assertAlarmRuntime,
  commandSource,
  pathSource,
  type AlarmSource,
} from "./alarm-sources";

interface Running {
  readonly row: Alarm.Row;
  readonly source: AlarmSource;
}

/** One app-owned band; session release has no connection to source lifetime. */
export function createAlarmWorker(options: {
  readonly alarms: Storage.AlarmSubAdapter;
  readonly observations: Required<Pick<ObservationSink, "subscribe">>;
  readonly wake: (sessionId: string) => Promise<void>;
  readonly requestTimeout: (requestId: string, at: number) => void;
  readonly failure: (error: Error) => void;
  readonly clock?: () => number;
  readonly schedule?: (tick: () => void) => () => void;
}) {
  assertAlarmRuntime();
  const now = options.clock ?? Date.now;
  const running = new Map<string, Running>();
  const settling = new Set<Promise<void>>();
  let stopped = false;
  let scanning = false;
  let recovering = true;
  let cancelTick: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;

  function track(operation: Promise<void>) {
    settling.add(operation);
    void operation.then(
      () => settling.delete(operation),
      (error: Error) => {
        settling.delete(operation);
        options.failure(error);
      },
    );
  }

  function release(row: Alarm.Row) {
    const current = running.get(row.id);
    if (current === undefined || current.row.fence !== row.fence) return;
    running.delete(row.id);
    track(current.source.close());
  }

  // The ledger owns admission: identity, fence, dedupe, deadline and budget are
  // decided from the committed row. This band only reports what a source saw.
  function deliver(
    row: Alarm.Row,
    sourceKey: string,
    content: string,
    terminal: boolean,
    batchHash?: string,
  ) {
    if (stopped) return;
    const fired = options.alarms.fire({
      id: row.id,
      epoch: row.epoch,
      fence: row.fence,
      sourceKey,
      at: now(),
      content,
      terminal,
      ...(batchHash === undefined ? {} : { batchHash }),
    });
    if (fired === undefined) return;
    if (fired.row.status !== "armed") release(row);
    // Session shutdown owns runner settlement; this band owns only its sources.
    void options.wake(row.sessionId).catch((error: Error) => options.failure(error));
  }

  function summary(
    row: Alarm.Row,
    reason: "exit" | "timeout" | "restart" | "source_error",
    exitCode: number | null,
  ) {
    deliver(
      row,
      `${reason}:${row.fence}`,
      JSON.stringify({ alarmId: row.id, epoch: row.epoch, reason, exitCode }),
      true,
    );
  }

  function sourceFailure(row: Alarm.Row, error: Error) {
    try {
      summary(row, "source_error", null);
    } finally {
      release(row);
      options.failure(error);
    }
  }

  function start(row: Alarm.Row) {
    const deadline = Alarm.RequestDeadline.safeParse(row.spec?.value);
    if (row.kind === "at" && deadline.success) {
      options.requestTimeout(deadline.data.requestId, now());
      return;
    }
    const owned = options.alarms.acquire(row.id, row.fence);
    if (owned === undefined) return;
    if (owned.kind === "at") {
      deliver(
        owned,
        `timer:${owned.fireAt}`,
        owned.spec === undefined
          ? "Alarm due"
          : typeof owned.spec.value === "string"
            ? owned.spec.value
            : JSON.stringify(owned.spec.value),
        true,
      );
      return;
    }
    const { watch } = Alarm.WatchSpec.parse(owned.spec?.value);
    if (watch.timeout_ms !== undefined && now() >= owned.fireAt + watch.timeout_ms) {
      summary(owned, "timeout", null);
      return;
    }
    if (recovering && row.fence > 0 && watch.persistent !== true) {
      summary(owned, "restart", null);
      return;
    }
    try {
      let source: AlarmSource;
      if ("command" in watch) {
        const filter = watch.filter === undefined ? undefined : new RegExp(watch.filter);
        let lines = 0;
        source = commandSource(
          watch.command,
          (content) => {
            lines += 1;
            if (filter === undefined || filter.test(content))
              deliver(
                owned,
                `line:${owned.fence}:${lines}`,
                content,
                false,
                canonicalDigest(content),
              );
          },
          (code) => summary(owned, "exit", code),
          (error) => sourceFailure(owned, error),
        );
      } else {
        source = pathSource(
          watch,
          (content, identity) => deliver(owned, `path:${identity}`, content, false),
          (error) => sourceFailure(owned, error),
        );
      }
      running.set(row.id, { row: owned, source });
    } catch {
      sourceFailure(owned, new AlarmSourceError("source.start"));
    }
  }

  function tick() {
    if (stopped || scanning) return;
    scanning = true;
    try {
      for (const [id, entry] of running) {
        const current = options.alarms.get(id);
        if (current?.status !== "armed" || current.fence !== entry.row.fence) {
          release(entry.row);
          continue;
        }
        const { watch } = Alarm.WatchSpec.parse(current.spec?.value);
        if (watch.timeout_ms !== undefined && now() >= current.fireAt + watch.timeout_ms)
          summary(current, "timeout", null);
        else entry.source.observe?.();
      }
      for (const row of options.alarms.due(now())) if (!running.has(row.id)) start(row);
    } finally {
      scanning = false;
      recovering = false;
    }
  }

  // A bus publication can originate inside an executor wave. Never inherit its
  // abort/authority scope into a long-lived source or a future session wake.
  const evaluate = AsyncResource.bind(tick);
  return {
    tick: evaluate,
    start() {
      if (cancelTick !== undefined) throw new Error("alarm worker already started");
      unsubscribe = options.observations.subscribe(
        L0Observation.ActionCommittedEvent,
        (payload) => {
          if (payload.kind !== "alarm.arm") return;
          try {
            evaluate();
          } catch {
            options.failure(new AlarmSourceError("bus.scan"));
          }
        },
      );
      evaluate();
      cancelTick = (
        options.schedule ??
        ((callback) => {
          const timer = setInterval(() => {
            try {
              callback();
            } catch {
              options.failure(new AlarmSourceError("timer.scan"));
            }
          }, 1000);
          return () => clearInterval(timer);
        })
      )(evaluate);
    },
    async close() {
      stopped = true;
      cancelTick?.();
      unsubscribe?.();
      for (const [id, entry] of running) {
        // Persist invalidation before physical shutdown. This preserves takeover dedupe.
        options.alarms.acquire(id, entry.row.fence);
        release(entry.row);
      }
      await Promise.all([...settling]);
    },
  };
}
