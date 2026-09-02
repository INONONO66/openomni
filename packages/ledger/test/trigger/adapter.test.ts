import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { Storage as ProtocolStorage } from "@openomni/protocol";
import { createSqliteTriggerAdapter } from "../../src/storage/sqlite-trigger-adapter";
import { createSqliteTriggerFireAdapter } from "../../src/storage/sqlite-trigger-fire-adapter";
import { initializeSqliteDatabase } from "../../src/storage/sqlite-schema-lifecycle";
import { buildTriggerFire, buildTriggerRecord } from "../helpers/trigger";
import { createMemoryTriggerAdapters } from "./memory-trigger-adapters";

type Harness = Readonly<{
  trigger: ProtocolStorage.TriggerSubAdapter;
  triggerFire: ProtocolStorage.TriggerFireSubAdapter;
  close(): void;
}>;

const harnesses = [
  {
    name: "memory",
    open(): Harness {
      const adapters = createMemoryTriggerAdapters();
      return {
        ...adapters,
        close() {
          // Map-backed adapters own no external resource.
        },
      };
    },
  },
  {
    name: "sqlite",
    open(): Harness {
      const db = new Database(":memory:");
      initializeSqliteDatabase(db);
      return {
        trigger: createSqliteTriggerAdapter(db),
        triggerFire: createSqliteTriggerFireAdapter(db),
        close: () => db.close(),
      };
    },
  },
] as const;

for (const fixture of harnesses) {
  describe(`Trigger adapters (${fixture.name})`, () => {
    test("match insert, clone, filter, order, and active-scan semantics", () => {
      const harness = fixture.open();
      try {
        const second = buildTriggerRecord({ id: "trigger-2", createdAt: 2_000, updatedAt: 2_000 });
        const tied = buildTriggerRecord({ id: "trigger-0" });
        const ended = buildTriggerRecord({
          id: "trigger-ended",
          lifecycle: { state: "ended", endReason: "cancelled", endedAt: 3_000 },
          lastObservedAt: 3_000,
          createdAt: 3_000,
          updatedAt: 3_000,
        });
        expect(harness.trigger.create(buildTriggerRecord())).toBe(true);
        expect(harness.trigger.create(tied)).toBe(true);
        expect(harness.trigger.create(second)).toBe(true);
        expect(harness.trigger.create(ended)).toBe(true);
        expect(harness.trigger.create(buildTriggerRecord())).toBe(false);

        const returned = harness.trigger.get("trigger-1");
        expect(returned).toBeDefined();
        (returned as { prompt: string }).prompt = "mutated outside storage";
        expect(harness.trigger.get("trigger-1")?.prompt).toBe("Check the requested condition.");

        expect(harness.trigger.list().map((record) => record.id)).toEqual([
          "trigger-0",
          "trigger-1",
          "trigger-2",
          "trigger-ended",
        ]);
        expect(
          harness.trigger.list({ order: "newest", limit: 2 }).map((record) => record.id),
        ).toEqual(["trigger-ended", "trigger-2"]);
        expect(
          harness.trigger.list({ states: ["armed"], kinds: ["time.once"] }).map(({ id }) => id),
        ).toEqual(["trigger-0", "trigger-1", "trigger-2"]);
        expect(harness.trigger.listIds({ limit: 2 })).toEqual(["trigger-0", "trigger-1"]);
        expect(harness.trigger.listActiveIds()).toEqual(["trigger-0", "trigger-1", "trigger-2"]);
        expect(harness.trigger.countActiveByOwner("session-owner")).toBe(3);
        expect(() => harness.trigger.list({ limit: 0 })).toThrow(/limit/);
      } finally {
        harness.close();
      }
    });

    test("match revision CAS and fire recovery ordering", () => {
      const harness = fixture.open();
      try {
        expect(harness.trigger.create(buildTriggerRecord())).toBe(true);
        const paused = buildTriggerRecord({
          lifecycle: { state: "paused", pauseReason: "wake_budget", pausedAt: 2_500 },
          lastObservedAt: 2_500,
          revision: 2,
          updatedAt: 2_500,
        });
        expect(harness.trigger.compareAndSet("trigger-1", 1, paused)).toBe(true);
        expect(harness.trigger.compareAndSet("trigger-1", 1, paused)).toBe(false);
        expect(harness.trigger.get("trigger-1")).toEqual(paused);

        const delivered = buildTriggerFire({
          id: "fire-delivered",
          status: "delivered",
          deliveredAt: 3_000,
          revision: 2,
          updatedAt: 3_000,
        });
        const older = buildTriggerFire({ id: "fire-a" });
        const tied = buildTriggerFire({ id: "fire-0" });
        const acked = buildTriggerFire({
          id: "fire-acked",
          status: "acked",
          deliveredAt: 3_000,
          ackedAt: 3_100,
          admission: {
            fireId: "fire-acked",
            sessionId: "session-owner",
            messageId: "message-fire-acked",
            payloadDigest: buildTriggerFire().payloadDigest,
            admittedAt: 3_050,
          },
          revision: 3,
          updatedAt: 3_100,
        });
        expect(harness.triggerFire.create(older)).toBe(true);
        expect(harness.triggerFire.create(tied)).toBe(true);
        expect(harness.triggerFire.create(delivered)).toBe(true);
        expect(harness.triggerFire.create(acked)).toBe(true);
        expect(harness.triggerFire.create(older)).toBe(false);

        const loaded = harness.triggerFire.get("fire-a");
        expect(loaded).toBeDefined();
        (loaded as { payload: string }).payload = "mutated outside storage";
        expect(harness.triggerFire.get("fire-a")?.payload).toBe("Trigger trigger-1 fired.");
        expect(harness.triggerFire.listUnackedIds()).toEqual([
          "fire-0",
          "fire-a",
          "fire-delivered",
        ]);
        expect(
          harness.triggerFire.list({ statuses: ["delivered"] }).map((fire) => fire.id),
        ).toEqual(["fire-delivered"]);
      } finally {
        harness.close();
      }
    });
  });
}
