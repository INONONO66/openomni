import { Trigger } from "@openomni/protocol";

export function buildTriggerCreate(overrides: Partial<Trigger.Create> = {}): Trigger.Create {
  return Trigger.Create.parse({
    id: "trigger-1",
    ownerSessionId: "session-owner",
    prompt: "Check the requested condition.",
    source: { kind: "time.once", at: 2_000 },
    at: 1_000,
    ...overrides,
  });
}

export function buildTriggerRecord(overrides: Partial<Trigger.Record> = {}): Trigger.Record {
  const createdAt = overrides.createdAt ?? 1_000;
  return Trigger.Record.parse({
    id: "trigger-1",
    ownerSessionId: "session-owner",
    prompt: "Check the requested condition.",
    source: { kind: "time.once", at: 2_000 },
    lifecycle: { state: "armed" },
    createdAt,
    updatedAt: createdAt,
    revision: 1,
    lastObservedAt: createdAt,
    fireCount: 0,
    coalescedFirePending: false,
    ...overrides,
  });
}

export function buildAlarmFireMaterial(
  overrides: {
    reservation?: Partial<Trigger.FireReservation>;
    pendingBatch?: Partial<Trigger.PendingBatch>;
  } = {},
): Trigger.FireMaterial {
  const payload = overrides.reservation?.payload ?? "Trigger trigger-1 fired.";
  const pendingWithoutFingerprint = {
    items: [],
    overflowCount: 0,
    scheduleMarker: true,
    scheduledForAt: 2_000,
    firstAt: 2_000,
    lastAt: 2_000,
    ...overrides.pendingBatch,
  };
  const pendingBatch = Trigger.PendingBatch.parse({
    ...pendingWithoutFingerprint,
    fingerprint: Trigger.canonicalDigest(pendingWithoutFingerprint),
  });
  return Trigger.FireMaterial.parse({
    reservation: {
      id: "fire-1",
      traceId: "trace-fire-1",
      payload,
      payloadDigest: Trigger.canonicalDigest(payload),
      cause: "alarm",
      terminalReason: "completed",
      sourceItems: [],
      overflowCount: 0,
      scheduledForAt: 2_000,
      firedAt: 2_000,
      ...overrides.reservation,
    },
    pendingBatch,
  });
}

export function buildTriggerFire(overrides: Partial<Trigger.Fire> = {}): Trigger.Fire {
  const payload = overrides.payload ?? "Trigger trigger-1 fired.";
  return Trigger.Fire.parse({
    id: "fire-1",
    triggerId: "trigger-1",
    ownerSessionId: "session-owner",
    traceId: "trace-fire-1",
    payload,
    payloadDigest: Trigger.canonicalDigest(payload),
    cause: "alarm",
    sourceItems: [],
    overflowCount: 0,
    scheduledForAt: 2_000,
    firedAt: 2_000,
    recordedAt: 2_000,
    status: "recorded",
    deliveryAttempts: 0,
    revision: 1,
    updatedAt: 2_000,
    ...overrides,
  });
}
