import { Effect, Either } from "effect";
import { expect, test } from "bun:test";
import { Alarm, LedgerSession, type LedgerAction } from "@openomni/protocol";
import type { createSqliteL0Adapters } from "../../src/storage/sqlite-l0-adapter";
import { observedL0Adapters, openLedgerDatabase } from "../helpers/ledger";

function sqlite() {
  const db = openLedgerDatabase();
  return { db, ...observedL0Adapters(db) };
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

function exercise(adapter: ReturnType<typeof createSqliteL0Adapters>) {
  Either.getOrThrowWith(
    Effect.runSync(Effect.either(adapter.sessions.create(row()))),
    (error) => error,
  );
  const armed = Either.getOrThrowWith(
    Effect.runSync(
      Effect.either(
        adapter.alarms.arm({
          id: "watch",
          sessionId: "alarm-session",
          kind: "watch",
          fireAt: 1000,
          spec: {
            encodingVersion: 1,
            value: {
              watch: { command: "true", description: "parity", persistent: true },
              notificationLimit: 1,
              policyGeneration: 1,
            },
          },
        }),
      ),
    ),
    (error) => error,
  );
  expect(armed).toMatchObject({ status: "armed", epoch: 1, fence: 0 });
  const owned = Either.getOrThrowWith(
    Effect.runSync(Effect.either(adapter.alarms.acquire("watch", 0))),
    (error) => error,
  );
  if (owned === undefined) throw new Error("acquisition refused");
  expect(() =>
    Either.getOrThrowWith(
      Effect.runSync(Effect.either(adapter.alarms.acquire("watch", 0))),
      (error) => error,
    ),
  ).toThrow(expect.objectContaining({ _tag: "AlarmRefused" }));
  const fire = (sourceKey: string, content: string, fence = owned.fence) =>
    Either.getOrThrowWith(
      Effect.runSync(
        Effect.either(
          adapter.alarms.fire({
            id: "watch",
            epoch: 1,
            fence,
            sourceKey,
            at: 1000,
            content,
            batchHash: content,
            terminal: false,
          }),
        ),
      ),
      (error) => error,
    );
  const first = fire("first", "A");
  expect(first?.receipts.map((receipt) => receipt.action.kind)).toEqual(["alarm.fired", "prompt"]);
  expect(first?.receipts[0]?.action.id).toBe(Alarm.occurrenceId("watch", 1, "first"));
  expect(() => fire("first", "A")).toThrow(expect.objectContaining({ _tag: "AlarmRefused" }));
  expect(() => fire("duplicate", "A")).toThrow(expect.objectContaining({ _tag: "AlarmRefused" }));
  expect(fire("budget", "B")?.row.status).toBe("paused");
  expect(() => fire("stale", "C")).toThrow(expect.objectContaining({ _tag: "AlarmRefused" }));
  const rearmed = Either.getOrThrowWith(
    Effect.runSync(Effect.either(adapter.alarms.rearm("watch", "alarm-session", 1100))),
    (error) => error,
  );
  expect(rearmed).toMatchObject({
    id: "watch",
    epoch: 2,
    notifications: 0,
    lastBatch: null,
    status: "armed",
  });
  expect(
    Either.getOrThrowWith(
      Effect.runSync(Effect.either(adapter.alarms.cancel("watch", "alarm-session", 1101))),
      (error) => error,
    )?.status,
  ).toBe("cancelled");
  expect(() =>
    Either.getOrThrowWith(
      Effect.runSync(Effect.either(adapter.alarms.rearm("watch", "alarm-session", 1102))),
      (error) => error,
    ),
  ).toThrow(expect.objectContaining({ _tag: "AlarmRefused" }));
  return {
    tree: adapter.actions.tree("alarm-session"),
    inbox: adapter.inbox.list("alarm-session"),
    row: adapter.alarms.get("watch"),
  };
}

test("alarm adapter parity: arm/cancel/rearm/due and fenced budget delivery", () => {
  const fixture = sqlite();
  try {
    exercise(fixture.adapter);
  } finally {
    fixture.db.close();
  }
});

test("alarm rollback: fired action and inbox share one transaction, bus follows commit", () => {
  const fixture = sqlite();
  try {
    Either.getOrThrowWith(
      Effect.runSync(Effect.either(fixture.adapter.sessions.create(row()))),
      (error) => error,
    );
    Either.getOrThrowWith(
      Effect.runSync(
        Effect.either(
          fixture.adapter.alarms.arm({
            id: "at",
            sessionId: "alarm-session",
            kind: "at",
            fireAt: 1000,
          }),
        ),
      ),
      (error) => error,
    );
    const input = Alarm.Fire.parse({
      id: "at",
      epoch: 1,
      fence: 0,
      sourceKey: "timer:1000",
      at: 1000,
      content: "due",
      terminal: true,
    });
    fixture.db.run(
      "CREATE TRIGGER refuse_alarm_prompt BEFORE INSERT ON inbox BEGIN SELECT RAISE(ABORT, 'alarm inbox fault'); END",
    );
    expect(() =>
      Either.getOrThrowWith(
        Effect.runSync(Effect.either(fixture.adapter.alarms.fire(input))),
        (error) => error,
      ),
    ).toThrow(expect.objectContaining({ _tag: "ForeignFailure" }));
    expect(
      fixture.adapter.actions.tree("alarm-session").map((action: LedgerAction.Node) => action.kind),
    ).toEqual(["alarm.arm"]);
    expect(fixture.adapter.sessions.get("alarm-session")?.revision).toBe(1);
    expect(fixture.adapter.inbox.list("alarm-session")).toEqual([]);
    expect(fixture.observations).toHaveLength(1);
    expect(fixture.adapter.alarms.get("at")?.status).toBe("armed");
    fixture.db.run("DROP TRIGGER refuse_alarm_prompt");
    expect(() =>
      Either.getOrThrowWith(
        Effect.runSync(Effect.either(fixture.adapter.alarms.fire({ ...input, at: 999 }))),
        (error) => error,
      ),
    ).toThrow(expect.objectContaining({ _tag: "AlarmRefused" }));
    expect(
      Either.getOrThrowWith(
        Effect.runSync(Effect.either(fixture.adapter.alarms.fire(input))),
        (error) => error,
      )?.inbox.origin.value,
    ).toBe("at");
    expect(() =>
      Either.getOrThrowWith(
        Effect.runSync(Effect.either(fixture.adapter.alarms.fire(input))),
        (error) => error,
      ),
    ).toThrow(expect.objectContaining({ _tag: "AlarmRefused" }));
    expect(fixture.observations.map((event) => event.kind)).toEqual([
      "alarm.arm",
      "alarm.fired",
      "prompt",
    ]);
  } finally {
    fixture.db.close();
  }
});
