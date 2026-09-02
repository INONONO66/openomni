import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Trigger } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { Storage, TriggerFireStore, TriggerStore } from "../../src/index";
import { bareStorageAdapter } from "../helpers/wait";
import { buildAlarmFireMaterial, buildTriggerCreate } from "../helpers/trigger";
import { createMemoryTriggerAdapters } from "./memory-trigger-adapters";

const backends = [
  {
    name: "memory",
    setup() {
      const adapters = createMemoryTriggerAdapters();
      Storage.configure({
        ...bareStorageAdapter(),
        transaction: adapters.transaction,
        trigger: adapters.trigger,
        triggerFire: adapters.triggerFire,
        ledger: adapters.ledger,
      });
    },
  },
  {
    name: "sqlite",
    setup() {
      Storage.initialize({ dbPath: ":memory:" });
    },
  },
] as const;

const flushBus = () => new Promise<void>((resolve) => queueMicrotask(resolve));

function captureStoreError(operation: () => unknown): InstanceType<typeof Trigger.StoreError> {
  try {
    operation();
  } catch (error) {
    if (Trigger.StoreError.isInstance(error)) return error;
    throw error;
  }
  throw new Error("expected TriggerStoreError, but nothing was thrown");
}

for (const backend of backends) {
  describe(`Trigger stores (${backend.name})`, () => {
    beforeEach(() => {
      Bus.reset();
      Storage.reset();
      backend.setup();
    });

    afterEach(() => {
      Storage.reset();
      Bus.reset();
    });

    test("records create, reserve, delivery, and acknowledgement facts before exact Bus signals", async () => {
      const events: string[] = [];
      Bus.observe((event) => {
        if (event.name.startsWith("trigger.")) events.push(event.name);
      });

      const created = TriggerStore.create(buildTriggerCreate(), "trace-create");
      const reserved = TriggerStore.transition({
        triggerId: created.id,
        expectedRevision: created.revision,
        input: { type: "timer_due", at: 2_000, fireMaterial: buildAlarmFireMaterial() },
        traceId: "trace-fire-1",
      });
      expect(reserved.trigger.lifecycle).toEqual({
        state: "ended",
        endReason: "completed",
        endedAt: 2_000,
      });
      expect(reserved.fire?.status).toBe("recorded");

      const attempted = TriggerFireStore.claimDeliveryAttempt({
        fireId: "fire-1",
        expectedFireRevision: 1,
        traceId: "trace-attempt",
        at: 2_100,
      });
      expect(attempted.deliveryAttempts).toBe(1);
      const delivered = TriggerFireStore.markDelivered({
        fireId: "fire-1",
        expectedFireRevision: attempted.revision,
        traceId: "trace-delivered",
        at: 2_200,
      });
      const admission = Trigger.FireAdmission.parse({
        fireId: delivered.id,
        sessionId: delivered.ownerSessionId,
        messageId: "message-fire-1",
        payloadDigest: delivered.payloadDigest,
        admittedAt: 2_300,
      });
      const acked = TriggerFireStore.ack({
        fireId: delivered.id,
        expectedFireRevision: delivered.revision,
        expectedTriggerRevision: reserved.trigger.revision,
        admission,
        traceId: "trace-acked",
        at: 2_300,
      });

      expect(acked.fire.status).toBe("acked");
      expect(acked.trigger.inFlightFireId).toBeUndefined();
      expect(acked.trigger.revision).toBe(4);
      const ledger = Storage.get().ledger;
      if (!ledger) throw new Error("ledger adapter missing");
      expect(
        [
          ...ledger.factsByType("trigger.created"),
          ...ledger.factsByType("trigger.fire.reserved"),
          ...ledger.factsByType("trigger.ended"),
          ...ledger.factsByType("trigger.fire.released"),
        ]
          .filter((fact) => fact.streamId === "trigger:trigger-1")
          .sort((left, right) => left.seq - right.seq)
          .map(({ seq, type }) => [seq, type]),
      ).toEqual([
        [1, "trigger.created"],
        [2, "trigger.fire.reserved"],
        [3, "trigger.ended"],
        [4, "trigger.fire.released"],
      ]);
      expect(
        [
          ...ledger.factsByType("trigger.fire.recorded"),
          ...ledger.factsByType("trigger.fire.delivery_attempted"),
          ...ledger.factsByType("trigger.fire.delivered"),
          ...ledger.factsByType("trigger.fire.acked"),
        ]
          .filter((fact) => fact.streamId === "trigger_fire:fire-1")
          .sort((left, right) => left.seq - right.seq)
          .map(({ seq, type }) => [seq, type]),
      ).toEqual([
        [1, "trigger.fire.recorded"],
        [2, "trigger.fire.delivery_attempted"],
        [3, "trigger.fire.delivered"],
        [4, "trigger.fire.acked"],
      ]);
      expect(ledger.headFact("trigger:trigger-1")?.seq).toBe(acked.trigger.revision);
      expect(ledger.headFact("trigger_fire:fire-1")?.seq).toBe(acked.fire.revision);

      await flushBus();
      expect(events).toEqual([
        "trigger.created",
        "trigger.fire.recorded",
        "trigger.ended",
        "trigger.fire.delivered",
        "trigger.fire.acked",
      ]);
    });

    test("enforces the active cap atomically and exposes deterministic boot scans", () => {
      for (let index = 0; index < Trigger.Constants.ACTIVE_TRIGGER_CAP; index += 1) {
        TriggerStore.create(
          buildTriggerCreate({
            id: `trigger-${index}`,
            source: { kind: "time.once", at: 2_000 + index },
          }),
          `trace-${index}`,
        );
      }
      const refusal = captureStoreError(() =>
        TriggerStore.create(buildTriggerCreate({ id: "trigger-over-cap" }), "trace-over-cap"),
      );
      expect(refusal.data.code).toBe("active_cap");
      expect(TriggerStore.get("trigger-over-cap")).toBeUndefined();
      expect(TriggerStore.listActiveIds()).toEqual([
        "trigger-0",
        "trigger-1",
        "trigger-2",
        "trigger-3",
        "trigger-4",
      ]);
      expect(TriggerFireStore.listUnackedIds()).toEqual([]);
    });

    test("returns exact mark/ack receipts idempotently and rejects a divergent admission", () => {
      const trigger = TriggerStore.create(buildTriggerCreate(), "trace-create");
      const reserved = TriggerStore.transition({
        triggerId: trigger.id,
        expectedRevision: trigger.revision,
        input: { type: "timer_due", at: 2_000, fireMaterial: buildAlarmFireMaterial() },
        traceId: "trace-fire-1",
      });
      const attempted = TriggerFireStore.claimDeliveryAttempt({
        fireId: "fire-1",
        expectedFireRevision: 1,
        traceId: "trace-attempt",
        at: 2_100,
      });
      const delivered = TriggerFireStore.markDelivered({
        fireId: "fire-1",
        expectedFireRevision: attempted.revision,
        traceId: "trace-delivered",
        at: 2_200,
      });
      expect(
        TriggerFireStore.markDelivered({
          fireId: "fire-1",
          expectedFireRevision: 1,
          traceId: "trace-redelivery",
          at: 2_250,
        }),
      ).toEqual(delivered);
      const admission = Trigger.FireAdmission.parse({
        fireId: delivered.id,
        sessionId: delivered.ownerSessionId,
        messageId: "message-fire-1",
        payloadDigest: delivered.payloadDigest,
        admittedAt: 2_300,
      });
      const acked = TriggerFireStore.ack({
        fireId: delivered.id,
        expectedFireRevision: delivered.revision,
        expectedTriggerRevision: reserved.trigger.revision,
        admission,
        traceId: "trace-ack",
        at: 2_300,
      });
      expect(
        TriggerFireStore.ack({
          fireId: delivered.id,
          expectedFireRevision: 1,
          expectedTriggerRevision: 1,
          admission: { ...admission, admittedAt: 9_999 },
          traceId: "trace-ack-retry",
          at: 9_999,
        }),
      ).toEqual(acked);

      const conflict = captureStoreError(() =>
        TriggerFireStore.ack({
          fireId: delivered.id,
          expectedFireRevision: acked.fire.revision,
          expectedTriggerRevision: acked.trigger.revision,
          admission: { ...admission, messageId: "message-divergent" },
          traceId: "trace-ack-conflict",
          at: 10_000,
        }),
      );
      expect(conflict.data.code).toBe("admission_conflict");
    });

    test("acknowledges and drains a fingerprint-pinned pending Fire atomically", () => {
      const created = TriggerStore.create(
        buildTriggerCreate({
          source: { kind: "time.every", intervalMs: 60_000 },
        }),
        "trace-create",
      );
      const firstMaterial = buildAlarmFireMaterial({
        reservation: {
          id: "fire-first",
          terminalReason: undefined,
          scheduledForAt: 61_000,
          firedAt: 61_000,
        },
        pendingBatch: {
          scheduledForAt: 61_000,
          firstAt: 61_000,
          lastAt: 61_000,
        },
      });
      const first = TriggerStore.transition({
        triggerId: created.id,
        expectedRevision: created.revision,
        input: { type: "timer_due", at: 61_000, fireMaterial: firstMaterial },
        traceId: "trace-first",
      });
      const pendingMaterial = buildAlarmFireMaterial({
        reservation: {
          id: "fire-unused-observation",
          terminalReason: undefined,
          scheduledForAt: 121_000,
          firedAt: 121_000,
        },
        pendingBatch: {
          scheduledForAt: 121_000,
          firstAt: 121_000,
          lastAt: 121_000,
        },
      });
      const coalesced = TriggerStore.transition({
        triggerId: created.id,
        expectedRevision: first.trigger.revision,
        input: { type: "timer_due", at: 121_000, fireMaterial: pendingMaterial },
        traceId: "trace-pending",
      });
      expect(coalesced.fire).toBeUndefined();
      expect(coalesced.trigger.pendingBatch).toBeDefined();

      const attempted = TriggerFireStore.claimDeliveryAttempt({
        fireId: "fire-first",
        expectedFireRevision: 1,
        traceId: "trace-attempt",
        at: 121_100,
      });
      const delivered = TriggerFireStore.markDelivered({
        fireId: attempted.id,
        expectedFireRevision: attempted.revision,
        traceId: "trace-delivered",
        at: 121_200,
      });
      const admission = Trigger.FireAdmission.parse({
        fireId: delivered.id,
        sessionId: delivered.ownerSessionId,
        messageId: "message-fire-first",
        payloadDigest: delivered.payloadDigest,
        admittedAt: 121_300,
      });
      const nextMaterial = buildAlarmFireMaterial({
        reservation: {
          id: "fire-next",
          cause: "coalesced",
          terminalReason: undefined,
          scheduledForAt: 121_000,
          firedAt: 121_000,
        },
        pendingBatch: {
          scheduledForAt: 121_000,
          firstAt: 121_000,
          lastAt: 121_000,
        },
      });
      const staleFingerprint = captureStoreError(() =>
        TriggerFireStore.ack({
          fireId: delivered.id,
          expectedFireRevision: delivered.revision,
          expectedTriggerRevision: coalesced.trigger.revision,
          admission,
          nextReservation: {
            pendingFingerprint: Trigger.canonicalDigest("not-the-pending-batch"),
            reservation: nextMaterial.reservation,
          },
          traceId: "trace-stale-fingerprint",
          at: 121_300,
        }),
      );
      expect(staleFingerprint.data.code).toBe("revision_conflict");
      expect(TriggerFireStore.get(delivered.id)?.status).toBe("delivered");

      const pendingFingerprint = coalesced.trigger.pendingBatch?.fingerprint;
      if (!pendingFingerprint) throw new Error("pending fingerprint missing");
      const acked = TriggerFireStore.ack({
        fireId: delivered.id,
        expectedFireRevision: delivered.revision,
        expectedTriggerRevision: coalesced.trigger.revision,
        admission,
        nextReservation: {
          pendingFingerprint,
          reservation: nextMaterial.reservation,
        },
        traceId: "trace-ack",
        at: 121_300,
      });

      expect(acked.fire.status).toBe("acked");
      expect(acked.nextFire?.id).toBe("fire-next");
      expect(acked.trigger.inFlightFireId).toBe("fire-next");
      expect(acked.trigger.pendingBatch).toBeUndefined();
      expect(acked.trigger.revision).toBe(coalesced.trigger.revision + 2);
      expect(TriggerFireStore.listUnackedIds()).toEqual(["fire-next"]);
      const ledger = Storage.get().ledger;
      if (!ledger) throw new Error("ledger adapter missing");
      expect(ledger.headFact("trigger:trigger-1")?.seq).toBe(acked.trigger.revision);
      expect(ledger.headFact("trigger_fire:fire-first")?.seq).toBe(acked.fire.revision);
      expect(ledger.headFact("trigger_fire:fire-next")?.seq).toBe(1);
    });

    test("rolls back every transitionBatch member when one revision is stale", async () => {
      const first = TriggerStore.create(
        buildTriggerCreate({ id: "trigger-batch-a" }),
        "trace-create-a",
      );
      const second = TriggerStore.create(
        buildTriggerCreate({ id: "trigger-batch-b" }),
        "trace-create-b",
      );
      await flushBus();
      const events: string[] = [];
      Bus.observe((event) => {
        if (event.name.startsWith("trigger.")) events.push(event.name);
      });

      const refusal = captureStoreError(() =>
        TriggerStore.transitionBatch([
          {
            triggerId: first.id,
            expectedRevision: first.revision,
            input: { type: "pause", reason: "wake_budget", at: 1_500 },
            traceId: "trace-pause-a",
          },
          {
            triggerId: second.id,
            expectedRevision: 99,
            input: { type: "pause", reason: "wake_budget", at: 1_500 },
            traceId: "trace-pause-b",
          },
        ]),
      );

      expect(refusal.data.code).toBe("revision_conflict");
      expect(TriggerStore.get(first.id)).toEqual(first);
      expect(TriggerStore.get(second.id)).toEqual(second);
      const ledger = Storage.get().ledger;
      if (!ledger) throw new Error("ledger adapter missing");
      expect(ledger.factsByType("trigger.paused")).toEqual([]);
      await flushBus();
      expect(events).toEqual([]);
    });

    test("fails closed with typed adapter_absent errors", () => {
      Storage.reset();
      Storage.configure(bareStorageAdapter());

      expect(captureStoreError(() => TriggerStore.get("trigger-1")).data.code).toBe(
        "adapter_absent",
      );
      expect(captureStoreError(() => TriggerFireStore.get("fire-1")).data.code).toBe(
        "adapter_absent",
      );
    });
  });
}
