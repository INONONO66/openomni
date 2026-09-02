import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Trigger, type Storage as ProtocolStorage } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { Storage, TriggerFireStore, TriggerStore } from "../../src/index";
import { buildAlarmFireMaterial, buildTriggerCreate, buildTriggerFire } from "../helpers/trigger";
import { bareStorageAdapter } from "../helpers/wait";
import { createMemoryTriggerAdapters } from "./memory-trigger-adapters";

const OWNER = "session-owner";

function captureStoreError(operation: () => unknown): InstanceType<typeof Trigger.StoreError> {
  try {
    operation();
  } catch (error) {
    if (Trigger.StoreError.isInstance(error)) return error;
    throw error;
  }
  throw new Error("expected TriggerStoreError, but nothing was thrown");
}

/**
 * Installs memory adapters, optionally wrapping the Trigger or Fire projection
 * so a specific read or write can be made to misbehave the way a damaged
 * database row would.
 */
function configure(
  patch: {
    trigger?: (base: ProtocolStorage.TriggerSubAdapter) => ProtocolStorage.TriggerSubAdapter;
    triggerFire?: (
      base: ProtocolStorage.TriggerFireSubAdapter,
    ) => ProtocolStorage.TriggerFireSubAdapter;
  } = {},
) {
  const adapters = createMemoryTriggerAdapters();
  Storage.configure({
    ...bareStorageAdapter(),
    transaction: adapters.transaction,
    trigger: patch.trigger ? patch.trigger(adapters.trigger) : adapters.trigger,
    triggerFire: patch.triggerFire ? patch.triggerFire(adapters.triggerFire) : adapters.triggerFire,
    ledger: adapters.ledger,
  });
  return adapters;
}

/** Drives one Trigger to a delivered Fire so acknowledgement paths are reachable. */
function deliverOnce() {
  const created = TriggerStore.create(buildTriggerCreate(), "trace-create");
  const reserved = TriggerStore.transition({
    triggerId: created.id,
    expectedRevision: created.revision,
    input: { type: "timer_due", at: 2_000, fireMaterial: buildAlarmFireMaterial() },
    traceId: "trace-fire",
  });
  const delivered = TriggerFireStore.markDelivered({
    fireId: "fire-1",
    expectedFireRevision: 1,
    traceId: "trace-delivered",
    at: 2_200,
  });
  return { trigger: reserved.trigger, fire: delivered };
}

function admissionFor(
  fire: Trigger.Fire,
  overrides: Partial<Trigger.FireAdmission> = {},
): Trigger.FireAdmission {
  return Trigger.FireAdmission.parse({
    fireId: fire.id,
    sessionId: fire.ownerSessionId,
    messageId: "message-fire-1",
    payloadDigest: fire.payloadDigest,
    admittedAt: 2_300,
    ...overrides,
  });
}

describe("Trigger store — creation refusals and derived deadlines", () => {
  beforeEach(() => {
    Bus.reset();
    Storage.reset();
    configure();
  });
  afterEach(() => {
    Storage.reset();
    Bus.reset();
  });

  test("a recurring Trigger derives its expiry, its floor, and its first deadline", () => {
    const created = TriggerStore.create(
      buildTriggerCreate({
        id: "trigger-every",
        source: { kind: "time.every", intervalMs: 1 },
      }),
      "trace-every",
    );

    // The requested interval is preserved for disclosure while the effective
    // interval is floored, and the derived deadline lands inside the lifetime.
    expect(created.requestedIntervalMs).toBe(1);
    expect(created.effectiveIntervalMs).toBe(Trigger.Constants.MIN_RECURRING_INTERVAL_MS);
    expect(created.nextFireAt).toBe(1_000 + Trigger.Constants.MIN_RECURRING_INTERVAL_MS);
    expect(created.expiresAt).toBe(1_000 + Trigger.Constants.RECURRING_LIFETIME_MS);
  });

  test("a recurring interval that cannot fire before expiry is refused", () => {
    const error = captureStoreError(() =>
      TriggerStore.create(
        buildTriggerCreate({
          id: "trigger-too-slow",
          source: { kind: "time.every", intervalMs: Trigger.Constants.RECURRING_LIFETIME_MS },
        }),
        "trace-slow",
      ),
    );
    expect(error.data.code).toBe("invalid_transition");
    expect(error.data.triggerId).toBe("trigger-too-slow");
    expect(TriggerStore.get("trigger-too-slow")).toBeUndefined();
  });

  test("a deadline past the safe-integer range is refused rather than wrapped", () => {
    const error = captureStoreError(() =>
      TriggerStore.create(
        buildTriggerCreate({
          id: "trigger-overflow",
          source: { kind: "event.file", path: "/tmp/watched.log", on: "modify" },
          at: Trigger.Constants.MAX_COUNTER,
        }),
        "trace-overflow",
      ),
    );
    expect(error.data.code).toBe("invalid_transition");
    expect(error.data.triggerId).toBe("trigger-overflow");
  });

  test("a non-persistent command source gets the source timeout; a persistent one does not", () => {
    const ephemeral = TriggerStore.create(
      buildTriggerCreate({
        id: "trigger-cmd",
        source: { kind: "event.command", command: "tail -f log", persistent: false },
      }),
      "trace-cmd",
    );
    expect(ephemeral.expiresAt).toBe(1_000 + Trigger.Constants.SOURCE_TIMEOUT_MS);

    const persistent = TriggerStore.create(
      buildTriggerCreate({
        id: "trigger-cmd-persistent",
        source: { kind: "event.command", command: "tail -f log", persistent: true },
      }),
      "trace-cmd-persistent",
    );
    expect(persistent.expiresAt).toBeUndefined();
  });

  test("a file source always gets the source timeout", () => {
    const created = TriggerStore.create(
      buildTriggerCreate({
        id: "trigger-file",
        source: { kind: "event.file", path: "/tmp/watched.log", on: "modify" },
      }),
      "trace-file",
    );
    expect(created.expiresAt).toBe(1_000 + Trigger.Constants.SOURCE_TIMEOUT_MS);
  });

  test("a duplicate id is refused before any second fact is written", () => {
    TriggerStore.create(buildTriggerCreate(), "trace-create");
    const error = captureStoreError(() =>
      TriggerStore.create(buildTriggerCreate(), "trace-create-again"),
    );
    expect(error.data.code).toBe("duplicate");

    const ledger = Storage.get().ledger;
    if (!ledger) throw new Error("ledger adapter missing");
    expect(ledger.factsByType("trigger.created")).toHaveLength(1);
  });
});

describe("Trigger store — corrupt projection isolation", () => {
  beforeEach(() => {
    Bus.reset();
    Storage.reset();
  });
  afterEach(() => {
    Storage.reset();
    Bus.reset();
  });

  test("a corrupt single-row read surfaces as a typed corrupt error", () => {
    configure({
      trigger: (base) => ({
        ...base,
        get() {
          throw new SyntaxError("Unexpected token } in JSON at position 12");
        },
      }),
    });
    const error = captureStoreError(() => TriggerStore.get("trigger-1"));
    expect(error.data.code).toBe("corrupt");
    expect(error.data.triggerId).toBe("trigger-1");
  });

  test("an indexed projection mismatch is treated as corruption, not a crash", () => {
    configure({
      trigger: (base) => ({
        ...base,
        get() {
          throw new Error("indexed projection mismatch for trigger-1");
        },
      }),
    });
    expect(captureStoreError(() => TriggerStore.get("trigger-1")).data.code).toBe("corrupt");
  });

  test("a non-corruption read failure propagates unchanged", () => {
    const boom = new Error("disk is on fire");
    configure({
      trigger: (base) => ({
        ...base,
        get() {
          throw boom;
        },
      }),
    });
    expect(() => TriggerStore.get("trigger-1")).toThrow(boom);
  });

  test("a corrupt Trigger list read surfaces as a typed corrupt error", () => {
    configure({
      trigger: (base) => ({
        ...base,
        list() {
          throw new SyntaxError("bad row");
        },
      }),
    });
    expect(captureStoreError(() => TriggerStore.list()).data.code).toBe("corrupt");
  });

  test("a non-corruption Trigger list failure propagates unchanged", () => {
    const boom = new Error("query planner exploded");
    configure({
      trigger: (base) => ({
        ...base,
        list() {
          throw boom;
        },
      }),
    });
    expect(() => TriggerStore.list()).toThrow(boom);
  });

  test("a corrupt Fire read and a corrupt Fire list both surface as typed errors", () => {
    configure({
      triggerFire: (base) => ({
        ...base,
        get() {
          throw new SyntaxError("bad fire row");
        },
        list() {
          throw new SyntaxError("bad fire row");
        },
      }),
    });
    const single = captureStoreError(() => TriggerFireStore.get("fire-1"));
    expect(single.data.code).toBe("corrupt");
    expect(single.data.fireId).toBe("fire-1");
    expect(captureStoreError(() => TriggerFireStore.list()).data.code).toBe("corrupt");
  });

  test("a non-corruption Fire list failure propagates unchanged", () => {
    const boom = new Error("fire index unavailable");
    configure({
      triggerFire: (base) => ({
        ...base,
        list() {
          throw boom;
        },
      }),
    });
    expect(() => TriggerFireStore.list()).toThrow(boom);
  });

  test("an orphaned Fire is refused rather than returned parentless", () => {
    const orphan = buildTriggerFire({ id: "fire-orphan", triggerId: "trigger-missing" });
    configure({
      triggerFire: (base) => ({
        ...base,
        get(id) {
          return id === orphan.id ? orphan : base.get(id);
        },
        list() {
          return [orphan];
        },
      }),
    });

    const single = captureStoreError(() => TriggerFireStore.get(orphan.id));
    expect(single.data.code).toBe("corrupt");
    expect(single.data.triggerId).toBe("trigger-missing");
    expect(captureStoreError(() => TriggerFireStore.list()).data.code).toBe("corrupt");
  });

  test("a Fire whose parent belongs to another session is refused", () => {
    const adapters = configure({
      triggerFire: (base) => ({
        ...base,
        get(id) {
          const fire = base.get(id);
          return fire === undefined ? undefined : { ...fire, ownerSessionId: "session-intruder" };
        },
      }),
    });
    expect(adapters).toBeDefined();
    TriggerStore.create(buildTriggerCreate(), "trace-create");
    TriggerStore.transition({
      triggerId: "trigger-1",
      expectedRevision: 1,
      input: { type: "timer_due", at: 2_000, fireMaterial: buildAlarmFireMaterial() },
      traceId: "trace-fire",
    });

    const error = captureStoreError(() => TriggerFireStore.get("fire-1"));
    expect(error.data.code).toBe("corrupt");
  });
});

describe("Trigger store — Fire write refusals", () => {
  beforeEach(() => {
    Bus.reset();
    Storage.reset();
    configure();
  });
  afterEach(() => {
    Storage.reset();
    Bus.reset();
  });

  test("writes against a missing Fire are refused as not_found", () => {
    for (const operation of [
      () =>
        TriggerFireStore.claimDeliveryAttempt({
          fireId: "fire-ghost",
          expectedFireRevision: 1,
          traceId: "t",
          at: 1,
        }),
      () =>
        TriggerFireStore.markDelivered({
          fireId: "fire-ghost",
          expectedFireRevision: 1,
          traceId: "t",
          at: 1,
        }),
    ]) {
      const error = captureStoreError(operation);
      expect(error.data.code).toBe("not_found");
      expect(error.data.fireId).toBe("fire-ghost");
    }
  });

  test("acknowledging a missing Fire is refused as not_found", () => {
    const error = captureStoreError(() =>
      TriggerFireStore.ack({
        fireId: "fire-ghost",
        expectedFireRevision: 1,
        expectedTriggerRevision: 1,
        admission: Trigger.FireAdmission.parse({
          fireId: "fire-ghost",
          sessionId: OWNER,
          messageId: "m-1",
          payloadDigest: Trigger.canonicalDigest("x"),
          admittedAt: 1,
        }),
        traceId: "t",
        at: 1,
      }),
    );
    expect(error.data.code).toBe("not_found");
  });

  test("a delivered Fire cannot claim another attempt", () => {
    const { fire } = deliverOnce();
    const error = captureStoreError(() =>
      TriggerFireStore.claimDeliveryAttempt({
        fireId: fire.id,
        expectedFireRevision: fire.revision,
        traceId: "trace-attempt",
        at: 2_400,
      }),
    );
    expect(error.data.code).toBe("invalid_transition");
    expect(error.data.fireId).toBe(fire.id);
  });

  test("an exhausted attempt counter is corruption, not a silent wrap", () => {
    const exhausted = buildTriggerFire({ deliveryAttempts: Trigger.Constants.MAX_COUNTER });
    Storage.reset();
    const adapters = createMemoryTriggerAdapters();
    Storage.configure({
      ...bareStorageAdapter(),
      transaction: adapters.transaction,
      trigger: adapters.trigger,
      triggerFire: {
        ...adapters.triggerFire,
        get(id) {
          return id === exhausted.id ? exhausted : adapters.triggerFire.get(id);
        },
      },
      ledger: adapters.ledger,
    });
    TriggerStore.create(buildTriggerCreate(), "trace-create");

    const error = captureStoreError(() =>
      TriggerFireStore.claimDeliveryAttempt({
        fireId: exhausted.id,
        expectedFireRevision: exhausted.revision,
        traceId: "trace-attempt",
        at: 2_400,
      }),
    );
    expect(error.data.code).toBe("corrupt");
    expect(error.data.fireId).toBe(exhausted.id);
  });

  test("marking an already-delivered Fire is idempotent and publishes no second signal", async () => {
    const { fire } = deliverOnce();
    const seen: string[] = [];
    Bus.observe((event) => {
      if (event.name === Trigger.Events.FireDelivered.name) seen.push(event.name);
    });

    const again = TriggerFireStore.markDelivered({
      fireId: fire.id,
      expectedFireRevision: fire.revision,
      traceId: "trace-delivered-again",
      at: 2_400,
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(again.revision).toBe(fire.revision);
    expect(again.deliveredAt).toBe(fire.deliveredAt);
    expect(seen).toEqual([]);
  });
});

describe("Trigger store — acknowledgement refusals", () => {
  beforeEach(() => {
    Bus.reset();
    Storage.reset();
    configure();
  });
  afterEach(() => {
    Storage.reset();
    Bus.reset();
  });

  test("a Fire that was never delivered cannot be acknowledged", () => {
    const created = TriggerStore.create(buildTriggerCreate(), "trace-create");
    const reserved = TriggerStore.transition({
      triggerId: created.id,
      expectedRevision: created.revision,
      input: { type: "timer_due", at: 2_000, fireMaterial: buildAlarmFireMaterial() },
      traceId: "trace-fire",
    });
    const fire = reserved.fire;
    if (!fire) throw new Error("expected a reserved Fire");

    const error = captureStoreError(() =>
      TriggerFireStore.ack({
        fireId: fire.id,
        expectedFireRevision: fire.revision,
        expectedTriggerRevision: reserved.trigger.revision,
        admission: admissionFor(fire),
        traceId: "trace-ack",
        at: 2_300,
      }),
    );
    expect(error.data.code).toBe("invalid_transition");
    expect(TriggerFireStore.get(fire.id)?.status).toBe("recorded");
  });

  test("an admission naming another session, Fire, or payload is refused", () => {
    const { trigger, fire } = deliverOnce();
    for (const override of [
      { sessionId: "session-intruder" },
      { payloadDigest: Trigger.canonicalDigest("different payload") },
    ]) {
      const error = captureStoreError(() =>
        TriggerFireStore.ack({
          fireId: fire.id,
          expectedFireRevision: fire.revision,
          expectedTriggerRevision: trigger.revision,
          admission: admissionFor(fire, override),
          traceId: "trace-ack",
          at: 2_300,
        }),
      );
      expect(error.data.code).toBe("admission_conflict");
    }
    expect(TriggerFireStore.get(fire.id)?.status).toBe("delivered");
  });

  test("a stale Fire or Trigger revision is a revision conflict", () => {
    const { trigger, fire } = deliverOnce();
    const staleFire = captureStoreError(() =>
      TriggerFireStore.ack({
        fireId: fire.id,
        expectedFireRevision: fire.revision - 1,
        expectedTriggerRevision: trigger.revision,
        admission: admissionFor(fire),
        traceId: "trace-ack",
        at: 2_300,
      }),
    );
    expect(staleFire.data.code).toBe("revision_conflict");

    const staleTrigger = captureStoreError(() =>
      TriggerFireStore.ack({
        fireId: fire.id,
        expectedFireRevision: fire.revision,
        expectedTriggerRevision: trigger.revision + 5,
        admission: admissionFor(fire),
        traceId: "trace-ack",
        at: 2_300,
      }),
    );
    expect(staleTrigger.data.code).toBe("revision_conflict");
  });

  test("re-acknowledging with the same admission is idempotent; a divergent one conflicts", () => {
    const { trigger, fire } = deliverOnce();
    const admission = admissionFor(fire);
    const first = TriggerFireStore.ack({
      fireId: fire.id,
      expectedFireRevision: fire.revision,
      expectedTriggerRevision: trigger.revision,
      admission,
      traceId: "trace-ack",
      at: 2_300,
    });

    const replay = TriggerFireStore.ack({
      fireId: fire.id,
      expectedFireRevision: fire.revision,
      expectedTriggerRevision: trigger.revision,
      admission,
      traceId: "trace-ack-replay",
      at: 2_400,
    });
    expect(replay.fire.revision).toBe(first.fire.revision);

    const divergent = captureStoreError(() =>
      TriggerFireStore.ack({
        fireId: fire.id,
        expectedFireRevision: fire.revision,
        expectedTriggerRevision: trigger.revision,
        admission: admissionFor(fire, { messageId: "message-other" }),
        traceId: "trace-ack-divergent",
        at: 2_500,
      }),
    );
    expect(divergent.data.code).toBe("admission_conflict");
  });

  test("supplying a next reservation with nothing pending is refused", () => {
    const { trigger, fire } = deliverOnce();
    const material = buildAlarmFireMaterial({ reservation: { id: "fire-2" } });
    const error = captureStoreError(() =>
      TriggerFireStore.ack({
        fireId: fire.id,
        expectedFireRevision: fire.revision,
        expectedTriggerRevision: trigger.revision,
        admission: admissionFor(fire),
        nextReservation: {
          pendingFingerprint: material.pendingBatch.fingerprint,
          reservation: material.reservation,
        },
        traceId: "trace-ack",
        at: 2_300,
      }),
    );
    expect(error.data.code).toBe("invalid_transition");
  });
});

describe("Trigger store — batch bounds", () => {
  beforeEach(() => {
    Bus.reset();
    Storage.reset();
    configure();
  });
  afterEach(() => {
    Storage.reset();
    Bus.reset();
  });

  test("an empty or oversized transition batch is refused before any write", () => {
    const empty = captureStoreError(() => TriggerStore.transitionBatch([]));
    expect(empty.data.code).toBe("invalid_transition");

    const oversized = captureStoreError(() =>
      TriggerStore.transitionBatch(
        Array.from({ length: Trigger.Constants.TRANSITION_BATCH_CAP + 1 }, (_, index) => ({
          triggerId: `trigger-${index}`,
          expectedRevision: 1,
          input: { type: "pause" as const, at: 2_000, reason: "source_unavailable" as const },
          traceId: "trace-batch",
        })),
      ),
    );
    expect(oversized.data.code).toBe("invalid_transition");
  });
});

describe("Trigger store — lifecycle signals", () => {
  beforeEach(() => {
    Bus.reset();
    Storage.reset();
    configure();
  });
  afterEach(() => {
    Storage.reset();
    Bus.reset();
  });

  test("pause, rearm, and restore each publish their own exact signal", async () => {
    const seen: string[] = [];
    Bus.observe((event) => {
      if (event.name.startsWith("trigger.")) seen.push(event.name);
    });

    const created = TriggerStore.create(
      buildTriggerCreate({
        id: "trigger-every",
        source: { kind: "time.every", intervalMs: Trigger.Constants.MIN_RECURRING_INTERVAL_MS },
      }),
      "trace-every",
    );

    const paused = TriggerStore.transition({
      triggerId: created.id,
      expectedRevision: created.revision,
      input: { type: "pause", at: 1_500, reason: "source_unavailable" },
      traceId: "trace-pause",
    });
    expect(paused.trigger.lifecycle).toMatchObject({
      state: "paused",
      pauseReason: "source_unavailable",
    });

    const rearmed = TriggerStore.transition({
      triggerId: created.id,
      expectedRevision: paused.trigger.revision,
      input: { type: "rearm", at: 1_600 },
      traceId: "trace-rearm",
    });
    expect(rearmed.trigger.lifecycle.state).toBe("armed");

    const restored = TriggerStore.transition({
      triggerId: created.id,
      expectedRevision: rearmed.trigger.revision,
      input: { type: "restore", at: 1_700 },
      traceId: "trace-restore",
    });
    const nextFireAt = restored.trigger.nextFireAt;
    if (nextFireAt === undefined) throw new Error("a restored recurring Trigger keeps a deadline");
    expect(restored.effects).toContainEqual({ type: "arm", dueAt: nextFireAt });

    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(seen).toEqual([
      Trigger.Events.Created.name,
      Trigger.Events.Paused.name,
      Trigger.Events.Rearmed.name,
    ]);

    const ledger = Storage.get().ledger;
    if (!ledger) throw new Error("ledger adapter missing");
    expect(ledger.factsByType("trigger.restored")).toHaveLength(1);
  });

  test("a transition against a missing Trigger is refused as not_found", () => {
    const error = captureStoreError(() =>
      TriggerStore.transition({
        triggerId: "trigger-ghost",
        expectedRevision: 1,
        input: { type: "pause", at: 1_500, reason: "source_unavailable" },
        traceId: "trace-pause",
      }),
    );
    expect(error.data.code).toBe("not_found");
    expect(error.data.triggerId).toBe("trigger-ghost");
  });

  test("a replayed reservation returns the same receipt without a second Fire", () => {
    const created = TriggerStore.create(buildTriggerCreate(), "trace-create");
    const material = buildAlarmFireMaterial();
    const first = TriggerStore.transition({
      triggerId: created.id,
      expectedRevision: created.revision,
      input: { type: "timer_due", at: 2_000, fireMaterial: material },
      traceId: "trace-fire",
    });

    // The caller retries with its now-stale revision: the store recognises the
    // same reservation and replays the receipt instead of reserving twice.
    const replay = TriggerStore.transition({
      triggerId: created.id,
      expectedRevision: created.revision,
      input: { type: "timer_due", at: 2_000, fireMaterial: material },
      traceId: "trace-fire-replay",
    });
    expect(replay.fire?.id).toBe("fire-1");
    expect(replay.trigger.revision).toBe(first.trigger.revision);
    expect(replay.effects).toEqual([]);
    expect(TriggerFireStore.list({ triggerId: created.id })).toHaveLength(1);
  });

  test("a genuinely stale revision without a matching reservation conflicts", () => {
    const created = TriggerStore.create(buildTriggerCreate(), "trace-create");
    TriggerStore.transition({
      triggerId: created.id,
      expectedRevision: created.revision,
      input: { type: "timer_due", at: 2_000, fireMaterial: buildAlarmFireMaterial() },
      traceId: "trace-fire",
    });

    const error = captureStoreError(() =>
      TriggerStore.transition({
        triggerId: created.id,
        expectedRevision: created.revision,
        input: { type: "pause", at: 2_100, reason: "source_unavailable" },
        traceId: "trace-pause",
      }),
    );
    expect(error.data.code).toBe("revision_conflict");
  });
});
