import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Alarm, LedgerSession, L0Observation, type LedgerAction } from "@openomni/protocol";
import { createSqliteL0Adapters } from "../../src/storage/sqlite-l0-adapter";
import { initializeSqliteDatabase } from "../../src/storage/sqlite-schema-lifecycle";
import { createMemoryL0Adapter } from "./memory-l0-adapter";

function sqlite() {
  const db = new Database(":memory:");
  initializeSqliteDatabase(db);
  const observations: L0Observation.ActionCommitted[] = [];
  const adapter = createSqliteL0Adapters(db, (operation) => db.transaction(operation).immediate(), {
    publish(event, payload) {
      if (event.name === L0Observation.ActionCommittedEvent.name)
        observations.push(L0Observation.ActionCommitted.parse(payload));
    },
  });
  return { adapter, db, observations };
}

function row() {
  return LedgerSession.Row.parse({
    id: "alarm-session",
    parentId: null,
    role: "resident",
    state: "idle",
    revision: 0,
    leaseOwner: null,
    leaseFence: 0,
    leaseExpiresAt: null,
  });
}

function exercise(
  adapter: ReturnType<typeof createMemoryL0Adapter> | ReturnType<typeof createSqliteL0Adapters>,
) {
  adapter.sessions.create(row());
  const armed = adapter.alarms.arm({
    id: "watch",
    sessionId: "alarm-session",
    kind: "watch",
    fireAt: 1000,
  });
  expect(armed).toMatchObject({ status: "armed", epoch: 1, fence: 0 });
  const owned = adapter.alarms.acquire("watch", 0);
  if (owned === undefined) throw new Error("acquisition refused");
  expect(adapter.alarms.acquire("watch", 0)).toBeUndefined();
  const fire = (actionId: string, content: string, fence = owned.fence) =>
    adapter.alarms.fire({
      id: "watch",
      epoch: 1,
      fence,
      actionId,
      inboxId: `${actionId}-inbox`,
      at: 1000,
      content,
      batchHash: content,
      limit: 1,
      terminal: false,
    });
  expect(fire("first", "A")?.receipts.map((receipt) => receipt.action.kind)).toEqual([
    "alarm.fired",
    "prompt",
  ]);
  expect(fire("duplicate", "A")).toBeUndefined();
  expect(fire("budget", "B")?.row.status).toBe("paused");
  expect(fire("stale", "C")).toBeUndefined();
  const rearmed = adapter.alarms.rearm("watch", 1100);
  expect(rearmed).toMatchObject({
    id: "watch",
    epoch: 2,
    notifications: 0,
    lastBatch: null,
    status: "armed",
  });
  expect(adapter.alarms.cancel("watch", 1101)?.status).toBe("cancelled");
  expect(adapter.alarms.rearm("watch", 1102)).toBeUndefined();
  return {
    tree: adapter.actions.tree("alarm-session"),
    inbox: adapter.inbox.list("alarm-session"),
    row: adapter.alarms.get("watch"),
  };
}

test("alarm adapter parity: arm/cancel/rearm/due and fenced budget delivery", () => {
  const fixture = sqlite();
  try {
    expect(exercise(fixture.adapter)).toEqual(exercise(createMemoryL0Adapter()));
  } finally {
    fixture.db.close();
  }
});

test("alarm rollback: fired action and inbox share one transaction, bus follows commit", () => {
  const fixture = sqlite();
  try {
    fixture.adapter.sessions.create(row());
    fixture.adapter.alarms.arm({ id: "at", sessionId: "alarm-session", kind: "at", fireAt: 1000 });
    const input = Alarm.Fire.parse({
      id: "at",
      epoch: 1,
      fence: 0,
      actionId: "fire",
      inboxId: "prompt",
      at: 1000,
      content: "due",
      limit: 1,
      terminal: true,
    });
    fixture.db.run(
      "CREATE TRIGGER refuse_alarm_prompt BEFORE INSERT ON inbox BEGIN SELECT RAISE(ABORT, 'alarm inbox fault'); END",
    );
    expect(() => fixture.adapter.alarms.fire(input)).toThrow("alarm inbox fault");
    expect(
      fixture.adapter.actions.tree("alarm-session").map((action: LedgerAction.Node) => action.kind),
    ).toEqual(["alarm.arm"]);
    expect(fixture.adapter.sessions.get("alarm-session")?.revision).toBe(1);
    expect(fixture.adapter.inbox.list("alarm-session")).toEqual([]);
    expect(fixture.observations).toHaveLength(1);
    expect(fixture.adapter.alarms.get("at")?.status).toBe("armed");
    fixture.db.run("DROP TRIGGER refuse_alarm_prompt");
    expect(fixture.adapter.alarms.fire({ ...input, at: 999 })).toBeUndefined();
    expect(fixture.adapter.alarms.fire(input)?.inbox.origin.value).toBe("at");
    expect(fixture.adapter.alarms.fire(input)).toBeUndefined();
    expect(fixture.observations.map((event) => event.kind)).toEqual([
      "alarm.arm",
      "alarm.fired",
      "prompt",
    ]);
  } finally {
    fixture.db.close();
  }
});
