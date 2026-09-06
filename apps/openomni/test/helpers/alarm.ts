import { createObservationBus } from "@openomni/agent";
import { SessionHandleStore, SqliteStorageAdapter, Storage } from "@openomni/ledger";
import { type Alarm, L0Observation, type Inbox } from "@openomni/protocol";
import { createAlarmWorker } from "../../src/composition/alarm-worker";

export function alarmFixture(path = ":memory:") {
  const events = createObservationBus();
  const storage = new SqliteStorageAdapter(path, events);
  Storage.configure(storage);
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
  });
  let at = 1000;
  const errors: Error[] = [];
  const wakes: string[] = [];
  const worker = createAlarmWorker({
    alarms: storage.alarms,
    observations: events,
    clock: () => at,
    schedule: () => () => undefined,
    failure: (error) => errors.push(error),
    wake: (id) => {
      wakes.push(id);
      return Promise.resolve();
    },
  });
  function arm(id: string, watch: Alarm.Watch, limit = 8) {
    const row = storage.alarms.arm({
      id,
      sessionId: "monitor-session",
      kind: "watch",
      fireAt: at,
      spec: { encodingVersion: 1, value: { watch, notificationLimit: limit, policyGeneration: 1 } },
    });
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
        reject(new Error(`no alarm inbox for ${id}`));
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
    arm,
    next,
    errors,
    wakes,
    advance(value: number) {
      at = value;
    },
    rows: () => SessionHandleStore.inboxRows("monitor-session"),
    async close() {
      await worker.close();
      Storage.reset();
    },
  };
}
