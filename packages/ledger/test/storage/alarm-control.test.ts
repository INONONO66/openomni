import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Alarm, LedgerSession, L0Observation } from "@openomni/protocol";
import { createSqliteL0Adapters } from "../../src/storage/sqlite-l0-adapter";
import { initializeSqliteDatabase } from "../../src/storage/sqlite-schema-lifecycle";
import { createMemoryL0Adapter } from "./memory-l0-adapter";

for (const backend of ["sqlite", "memory"] as const) {
  for (const op of ["cancel", "rearm"] as const) {
    test(`${backend} alarm ${op} admits only the calling session's armed/paused watches`, () => {
      using db = new Database(":memory:");
      initializeSqliteDatabase(db);
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
      expect(adapter.alarms[op]("missing", "owner", 100)).toBeUndefined();
      for (const kind of Alarm.Kind.options) {
        for (const status of Alarm.Status.options) {
          // Deadline cancellation is not an admitted transition, even during setup.
          if (kind === "at" && status === "cancelled") continue;
          for (const sessionId of ["owner", "foreign"]) {
            const id = `${kind}-${status}-${sessionId}`;
            expect(adapter.alarms.arm({ id, sessionId: "owner", kind, fireAt: 100 })).toBeDefined();
            if (status === "cancelled") {
              expect(adapter.alarms.cancel(id, "owner", 101)?.status).toBe("cancelled");
            } else if (status !== "armed") {
              expect(
                adapter.alarms.fire({
                  id,
                  epoch: 1,
                  fence: 0,
                  actionId: `${id}-fire`,
                  inboxId: `${id}-inbox`,
                  at: 101,
                  content: "event",
                  limit: 0,
                  terminal: status === "fired",
                })?.row.status,
              ).toBe(status);
            }
            const before = adapter.alarms.get(id);
            const session = adapter.sessions.get("owner");
            const tree = adapter.actions.tree("owner");
            const inbox = adapter.inbox.list("owner");
            const published = observations.length;
            const result = adapter.alarms[op](id, sessionId, 102);
            if (
              kind === "watch" &&
              sessionId === "owner" &&
              (status === "armed" || status === "paused")
            ) {
              expect(result).toMatchObject({
                status: op === "rearm" ? "armed" : "cancelled",
                epoch: op === "rearm" ? 2 : 1,
                fence: (before?.fence ?? 0) + 1,
              });
            } else {
              expect(result).toBeUndefined();
              expect(adapter.alarms.get(id)).toEqual(before);
              expect(adapter.sessions.get("owner")).toEqual(session);
              expect(adapter.actions.tree("owner")).toEqual(tree);
              expect(adapter.inbox.list("owner")).toEqual(inbox);
              expect(observations).toHaveLength(published);
            }
          }
        }
      }
    });
  }
}
