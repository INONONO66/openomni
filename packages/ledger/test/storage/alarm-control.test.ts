import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Alarm, LedgerSession, L0Observation } from "@openomni/protocol";
import { createSqliteL0Adapters } from "../../src/storage/sqlite-l0-adapter";
import { initializeSqliteDatabase } from "../../src/storage/sqlite-schema-lifecycle";
import { createMemoryL0Adapter } from "./memory-l0-adapter";

const watchSpec = {
  encodingVersion: 1 as const,
  value: {
    watch: { command: "true", description: "control", persistent: true },
    notificationLimit: 1,
    policyGeneration: 1,
  },
};

type Adapter = ReturnType<typeof createSqliteL0Adapters>;
type Backend = "sqlite" | "memory";
type Control = "cancel" | "rearm";
type Kind = Alarm.Kind;
type Status = Alarm.Status;

/** One backend with an owner session and a capture of every committed action. */
function openOwner(db: Database, backend: Backend) {
  const observations: L0Observation.ActionCommitted[] = [];
  const adapter =
    backend === "sqlite"
      ? createSqliteL0Adapters(db, (operation) => db.transaction(operation).immediate(), {
          publish(event, payload) {
            if (event.name === L0Observation.ActionCommittedEvent.name)
              observations.push(L0Observation.ActionCommitted.parse(payload));
          },
        })
      : createMemoryL0Adapter();
  adapter.sessions.create(
    LedgerSession.Row.parse({
      id: "owner",
      parentId: null,
      role: "resident",
      state: "idle",
      revision: 0,
      leaseOwner: null,
      leaseFence: 0,
      leaseExpiresAt: null,
    }),
  );
  return { adapter, observations };
}

/** Deadline cancellation and pause are not admitted transitions, even during setup. */
function setupAdmitted(kind: Kind, status: Status): boolean {
  return !(kind === "at" && (status === "cancelled" || status === "paused"));
}

/** Only the calling session's armed/paused watches admit cancel and rearm. */
function controlAdmitted(kind: Kind, status: Status, sessionId: string): boolean {
  return kind === "watch" && sessionId === "owner" && (status === "armed" || status === "paused");
}

/** The full kind x status x caller matrix, each cell carrying its expected admission. */
const cases = Alarm.Kind.options.flatMap((kind) =>
  Alarm.Status.options
    .filter((status) => setupAdmitted(kind, status))
    .flatMap((status) =>
      ["owner", "foreign"].map((sessionId) => ({
        id: `${kind}-${status}-${sessionId}`,
        kind,
        status,
        sessionId,
        admitted: controlAdmitted(kind, status, sessionId),
      })),
    ),
);

function fireOnce(adapter: Adapter, id: string, sourceKey: string, terminal: boolean) {
  return adapter.alarms.fire({
    id,
    epoch: 1,
    fence: 0,
    sourceKey,
    at: 101,
    content: "event",
    terminal,
  })?.row.status;
}

/** Drives a freshly armed alarm into each persisted status. */
const driveTo: Record<Status, (adapter: Adapter, id: string) => void> = {
  armed: () => undefined,
  cancelled: (adapter, id) => {
    expect(adapter.alarms.cancel(id, "owner", 101)?.status).toBe("cancelled");
  },
  fired: (adapter, id) => {
    expect(fireOnce(adapter, id, "second", true)).toBe("fired");
  },
  // The persisted budget of one admits a single match; the next one pauses.
  paused: (adapter, id) => {
    expect(fireOnce(adapter, id, "first", false)).toBe("armed");
    expect(fireOnce(adapter, id, "second", false)).toBe("paused");
  },
};

function seedAlarm(adapter: Adapter, id: string, kind: Kind, status: Status): void {
  expect(
    adapter.alarms.arm({
      id,
      sessionId: "owner",
      kind,
      fireAt: 100,
      ...(kind === "watch" ? { spec: watchSpec } : {}),
    }),
  ).toBeDefined();
  driveTo[status](adapter, id);
}

/** Everything a refused control must leave exactly as it found it. */
function snapshot(
  adapter: Adapter,
  observations: readonly L0Observation.ActionCommitted[],
  id: string,
) {
  const alarm = adapter.alarms.get(id);
  return {
    alarm,
    fence: alarm?.fence ?? 0,
    session: adapter.sessions.get("owner"),
    tree: adapter.actions.tree("owner"),
    inbox: adapter.inbox.list("owner"),
    published: observations.length,
  };
}

for (const backend of ["sqlite", "memory"] as const) {
  for (const op of ["cancel", "rearm"] as const) {
    test(`${backend} alarm ${op} admits only the calling session's armed/paused watches`, () => {
      using db = new Database(":memory:");
      initializeSqliteDatabase(db);
      const { adapter, observations } = openOwner(db, backend);
      expect(adapter.alarms[op]("missing", "owner", 100)).toBeUndefined();
      for (const { id, kind, status, sessionId, admitted } of cases) {
        seedAlarm(adapter, id, kind, status);
        const before = snapshot(adapter, observations, id);
        const result = adapter.alarms[op](id, sessionId, 102);
        if (admitted) {
          expectTransition(op, before.fence, result);
        } else {
          expect(result).toBeUndefined();
          expect(snapshot(adapter, observations, id)).toEqual(before);
        }
      }
    });
  }
}

function expectTransition(op: Control, fenceBefore: number, result: Alarm.Row | undefined) {
  expect(result).toMatchObject({
    status: op === "rearm" ? "armed" : "cancelled",
    epoch: op === "rearm" ? 2 : 1,
    fence: fenceBefore + 1,
  });
}
