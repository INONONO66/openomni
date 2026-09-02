import { canonicalDigest } from "../../src/json.js";
import { Trigger } from "../../src/trigger/index.js";

/**
 * Parsed Trigger fixture builders. Every builder returns a value that already
 * passed its schema refinement, so a test that mutates one field is asserting
 * that field rather than fighting unrelated invariants.
 */

export const CREATED_AT = 1_000_000;
export const OWNER = "session-owner";

export function buildOnceRecord(overrides: Partial<Trigger.Record> = {}): Trigger.Record {
  return Trigger.Record.parse({
    id: "trigger-once",
    ownerSessionId: OWNER,
    prompt: "check the oven",
    source: { kind: "time.once", at: CREATED_AT + 60_000 },
    lifecycle: { state: "armed" },
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    revision: 1,
    lastObservedAt: CREATED_AT,
    fireCount: 0,
    coalescedFirePending: false,
    ...overrides,
  });
}

export function buildEveryRecord(overrides: Partial<Trigger.Record> = {}): Trigger.Record {
  const interval = Trigger.Constants.MIN_RECURRING_INTERVAL_MS;
  return Trigger.Record.parse({
    id: "trigger-every",
    ownerSessionId: OWNER,
    prompt: "poll the queue",
    source: { kind: "time.every", intervalMs: interval },
    lifecycle: { state: "armed" },
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    revision: 1,
    expiresAt: CREATED_AT + Trigger.Constants.RECURRING_LIFETIME_MS,
    requestedIntervalMs: interval,
    effectiveIntervalMs: interval,
    nextFireAt: CREATED_AT + interval,
    lastObservedAt: CREATED_AT,
    fireCount: 0,
    coalescedFirePending: false,
    ...overrides,
  });
}

export function buildCommandRecord(overrides: Partial<Trigger.Record> = {}): Trigger.Record {
  return Trigger.Record.parse({
    id: "trigger-command",
    ownerSessionId: OWNER,
    prompt: "watch the build",
    source: { kind: "event.command", command: "tail -f build.log", persistent: false },
    lifecycle: { state: "armed" },
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    revision: 1,
    expiresAt: CREATED_AT + Trigger.Constants.SOURCE_TIMEOUT_MS,
    lastObservedAt: CREATED_AT,
    fireCount: 0,
    coalescedFirePending: false,
    ...overrides,
  });
}

export function buildFileRecord(overrides: Partial<Trigger.Record> = {}): Trigger.Record {
  return Trigger.Record.parse({
    id: "trigger-file",
    ownerSessionId: OWNER,
    prompt: "watch the drop",
    source: { kind: "event.file", path: "/tmp/drop.json", on: "create" },
    lifecycle: { state: "armed" },
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    revision: 1,
    expiresAt: CREATED_AT + Trigger.Constants.SOURCE_TIMEOUT_MS,
    lastObservedAt: CREATED_AT,
    fireCount: 0,
    coalescedFirePending: false,
    ...overrides,
  });
}

type BatchFacts = Omit<Trigger.PendingBatch, "fingerprint">;

export function fingerprintOf(facts: BatchFacts): string {
  return canonicalDigest({
    items: facts.items,
    overflowCount: facts.overflowCount,
    scheduleMarker: facts.scheduleMarker,
    ...(facts.scheduledForAt === undefined ? {} : { scheduledForAt: facts.scheduledForAt }),
    firstAt: facts.firstAt,
    lastAt: facts.lastAt,
    ...(facts.terminalReason === undefined ? {} : { terminalReason: facts.terminalReason }),
  });
}

export function buildBatch(facts: Partial<BatchFacts> = {}): Trigger.PendingBatch {
  const resolved: BatchFacts = {
    items: [{ kind: "line", text: "build started", at: CREATED_AT }],
    overflowCount: 0,
    scheduleMarker: false,
    firstAt: CREATED_AT,
    lastAt: CREATED_AT,
    ...facts,
  };
  return Trigger.PendingBatch.parse({ ...resolved, fingerprint: fingerprintOf(resolved) });
}

export function buildScheduleMarker(scheduledForAt: number, at: number): Trigger.PendingBatch {
  return buildBatch({
    items: [],
    scheduleMarker: true,
    scheduledForAt,
    firstAt: at,
    lastAt: at,
  });
}

export function buildTerminalBatch(
  reason: Trigger.TerminalFireReason,
  at: number,
  text = "source finished",
): Trigger.PendingBatch {
  return buildBatch({
    items: [{ kind: "summary", text, at }],
    terminalReason: reason,
    firstAt: at,
    lastAt: at,
  });
}

export function buildReservation(
  overrides: Partial<Trigger.FireReservation> = {},
): Trigger.FireReservation {
  const payload = overrides.payload ?? "trigger payload";
  return Trigger.FireReservation.parse({
    id: "fire-1",
    traceId: "trace-1",
    payload,
    payloadDigest: canonicalDigest(payload),
    cause: "source_line",
    sourceItems: [{ kind: "line", text: "build started", at: CREATED_AT }],
    overflowCount: 0,
    firedAt: CREATED_AT,
    ...overrides,
    ...(overrides.payload === undefined
      ? {}
      : { payload: overrides.payload, payloadDigest: canonicalDigest(overrides.payload) }),
  });
}

/**
 * Fire material whose reservation and pending arm describe the same
 * observation, which is exactly what the fold validates.
 */
export function buildMaterial(
  batch: Trigger.PendingBatch,
  reservation: Partial<Trigger.FireReservation> = {},
): Trigger.FireMaterial {
  const summary = batch.items.find((item) => item.kind === "summary");
  const cause: Trigger.FireCause = batch.scheduleMarker
    ? "alarm"
    : summary === undefined
      ? "source_line"
      : "source_summary";
  return Trigger.FireMaterial.parse({
    reservation: buildReservation({
      cause,
      sourceItems: batch.items,
      overflowCount: batch.overflowCount,
      ...(batch.scheduledForAt === undefined ? {} : { scheduledForAt: batch.scheduledForAt }),
      ...(batch.terminalReason === undefined ? {} : { terminalReason: batch.terminalReason }),
      firedAt: batch.lastAt,
      ...reservation,
    }),
    pendingBatch: batch,
  });
}

export function buildAlarmMaterial(
  scheduledForAt: number,
  at: number,
  reservation: Partial<Trigger.FireReservation> = {},
): Trigger.FireMaterial {
  // A Fire is never recorded before its scheduled instant, so an early-callback
  // fixture still has to describe a legal reservation.
  const firedAt = Math.max(at, scheduledForAt);
  return buildMaterial(buildScheduleMarker(scheduledForAt, firedAt), {
    cause: "alarm",
    sourceItems: [],
    scheduledForAt,
    firedAt,
    ...reservation,
  });
}

/**
 * Reads an optional projection field that the Record refinement already
 * guarantees for the fixture's source kind, so assertions stay free of
 * non-null assertions while still failing loudly on a broken fixture.
 */
export function required(value: number | undefined, field: string): number {
  if (value === undefined) throw new Error(`fixture is missing ${field}`);
  return value;
}

export function buildFire(overrides: Partial<Trigger.Fire> = {}): Trigger.Fire {
  const payload = overrides.payload ?? "trigger payload";
  return Trigger.Fire.parse({
    id: "fire-1",
    triggerId: "trigger-command",
    ownerSessionId: OWNER,
    traceId: "trace-1",
    payload,
    payloadDigest: canonicalDigest(payload),
    cause: "source_line",
    sourceItems: [{ kind: "line", text: "build started", at: CREATED_AT }],
    overflowCount: 0,
    firedAt: CREATED_AT,
    recordedAt: CREATED_AT,
    status: "recorded",
    deliveryAttempts: 0,
    revision: 1,
    updatedAt: CREATED_AT,
    ...overrides,
    ...(overrides.payload === undefined
      ? {}
      : { payload: overrides.payload, payloadDigest: canonicalDigest(overrides.payload) }),
  });
}
