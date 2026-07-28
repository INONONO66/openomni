import { createHash } from "node:crypto";
import { Cron } from "croner";

export type ScheduleTransitionId = "DP-23" | "DP-24" | "RT-17" | "SC-01" | "SC-02";

export interface ScheduleTargetV1 {
  readonly kind: "resident" | "worker";
  readonly sessionId?: string;
}

export interface ScheduleCreateV1 {
  readonly scheduleId: string;
  readonly agentName: string;
  readonly target: ScheduleTargetV1;
  readonly expression: string;
  readonly payloadRef: string;
}

/** Ledger-derived schedule state. No process-local schedule state is authoritative. */
export interface ScheduleProjectionV1 extends ScheduleCreateV1 {
  readonly ownerKey: string;
  readonly status: "active" | "paused" | "cancelled";
  readonly generation: number;
  readonly nextFireAtDbMs: number | null;
  readonly nextFireRef: string | null;
  readonly pendingFireRef?: string;
  readonly settledFireRef?: string;
  readonly sourceEventId: string;
  readonly sourceOwnerSeq: number;
  readonly sourceLedgerSeq: number;
  readonly sourceOwnerHash: string;
  readonly asOfLedgerSeq: number;
}

export interface ScheduleFire {
  readonly schedule: ScheduleProjectionV1;
  readonly generation: number;
  readonly fireRef: string;
  readonly dueAtDbMs: number;
  readonly recordedAtDbMs: number;
}

export type ScheduleNativeCommand =
  | {
      readonly transitionId: "DP-23";
      readonly requestId: string;
      readonly principalId: string;
      readonly ownerKey: string;
      readonly schedule: ScheduleCreateV1;
      readonly nextFireAtDbMs: number;
      readonly nextFireRef: string;
    }
  | {
      readonly transitionId: "DP-24";
      readonly requestId: string;
      readonly principalId: string;
      readonly ownerKey: string;
      readonly scheduleId: string;
      readonly expectedSourceOwnerHash: string;
    }
  | {
      readonly transitionId: "RT-17";
      readonly requestId: string;
      readonly principalId: string;
      readonly ownerKey: string;
      readonly scheduleId: string;
      readonly expectedSourceOwnerHash: string;
      readonly generation: number;
      readonly fireRef: string;
      readonly dueAtDbMs: number;
      readonly recordedAtDbMs: number;
    }
  | {
      readonly transitionId: "SC-02";
      readonly requestId: string;
      readonly principalId: string;
      readonly ownerKey: string;
      readonly scheduleId: string;
      readonly expectedSourceOwnerHash: string;
      readonly generation: number;
      readonly fireRef: string;
      readonly settlement: "delivered" | "definite_failed";
      readonly settlementRef: string;
      readonly settledAtDbMs: number;
    }
  | {
      readonly transitionId: "SC-01";
      readonly requestId: string;
      readonly principalId: string;
      readonly ownerKey: string;
      readonly scheduleId: string;
      readonly expectedSourceOwnerHash: string;
      readonly generation: number;
      readonly settledFireRef: string;
      readonly nextFireAtDbMs: number;
      readonly nextFireRef: string;
    };

export type ScheduleTransitionResult =
  | { readonly status: "committed"; readonly snapshot: ScheduleProjectionV1 }
  | { readonly status: "conflict" }
  | { readonly status: "rejected"; readonly code: string };

/** Server-side closed transition face. It deliberately exposes no append or storage callback. */
export interface ScheduleTransitionPort {
  execute(command: ScheduleNativeCommand): Promise<ScheduleTransitionResult>;
}

export type ScheduleQuery =
  | { readonly kind: "schedule_by_id"; readonly scheduleId: string }
  | { readonly kind: "schedules_due"; readonly atMs: number; readonly limit: number };

export type ScheduleQueryResult =
  | { readonly kind: "schedule_by_id"; readonly snapshot: ScheduleProjectionV1 | null }
  | { readonly kind: "schedules_due"; readonly snapshots: readonly ScheduleProjectionV1[] };

/**
 * Durable projection/scanner face. `schedules_due` also returns settled generations lacking their
 * next-fire advance, allowing crash recovery between SC-02 and SC-01. It deliberately exposes no
 * process map or generic SQL.
 */
export interface ScheduleQueryPort {
  query(request: ScheduleQuery): Promise<ScheduleQueryResult>;
}

export interface ScheduleServiceOptions {
  readonly transitions: ScheduleTransitionPort;
  readonly queries: ScheduleQueryPort;
  readonly principalId: string;
  readonly ownerKey: (scheduleId: string) => string;
  readonly requestId?: () => string;
  readonly scanLimit?: number;
  readonly nowMs?: () => number;
}

function parseInteger(value: string, field: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid cron ${field} value: ${value}`);
  return Number.parseInt(value, 10);
}

function assertInRange(value: number, field: string, min: number, max: number): void {
  if (value < min || value > max) throw new Error(`Cron ${field} value out of range: ${value}`);
}

function addRange(
  values: Set<number>,
  field: string,
  min: number,
  max: number,
  range: string,
  step: number | undefined,
): void {
  const resolvedStep = step ?? 1;
  if (!Number.isInteger(resolvedStep) || resolvedStep <= 0) {
    throw new Error(`Invalid cron ${field} step: ${resolvedStep}`);
  }
  const rangeParts = range === "*" ? [String(min), String(max)] : range.split("-");
  if (rangeParts.length > 2) throw new Error(`Invalid cron ${field} range: ${range}`);
  const [startRaw, endRaw] = rangeParts;
  if (!startRaw || !endRaw) {
    if (step !== undefined) throw new Error(`Invalid cron ${field} step target: ${range}`);
    const value = parseInteger(range, field);
    assertInRange(value, field, min, max);
    values.add(value);
    return;
  }
  const start = parseInteger(startRaw, field);
  const end = parseInteger(endRaw, field);
  assertInRange(start, field, min, max);
  assertInRange(end, field, min, max);
  if (start > end) throw new Error(`Invalid cron ${field} range: ${range}`);
  for (let value = start; value <= end; value += resolvedStep) values.add(value);
}

function normalizeField(source: string, field: string, min: number, max: number): string {
  const values = new Set<number>();
  for (const part of source.split(",")) {
    if (!part) throw new Error(`Invalid cron ${field} field: ${source}`);
    const stepParts = part.split("/");
    if (stepParts.length > 2) throw new Error(`Invalid cron ${field} field: ${source}`);
    const [range, stepRaw] = stepParts;
    if (!range) throw new Error(`Invalid cron ${field} field: ${source}`);
    addRange(values, field, min, max, range, stepRaw ? parseInteger(stepRaw, field) : undefined);
  }
  return [...values].sort((left, right) => left - right).join(",");
}

function normalizeSchedule(schedule: string): string {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Unsupported cron schedule: ${schedule}`);
  return [
    normalizeField(fields[0] ?? "", "minute", 0, 59),
    normalizeField(fields[1] ?? "", "hour", 0, 23),
    normalizeField(fields[2] ?? "", "day-of-month", 1, 31),
    normalizeField(fields[3] ?? "", "month", 1, 12),
    normalizeField(fields[4] ?? "", "day-of-week", 0, 7),
  ].join(" ");
}

export function computeNextScheduleFireAt(schedule: string, afterMs: number): number {
  const nextRun = new Cron(normalizeSchedule(schedule), {
    paused: true,
    timezone: "UTC",
    domAndDow: true,
    mode: "5-part",
  }).nextRun(new Date(afterMs));
  if (!nextRun) throw new Error(`Unable to find next cron fire time for schedule: ${schedule}`);
  return nextRun.getTime();
}

function reference(parts: readonly (string | number)[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function committed(result: ScheduleTransitionResult, operation: string): ScheduleProjectionV1 {
  if (result.status === "committed") return assertScheduleProjectionV1(result.snapshot);
  if (result.status === "conflict") throw new Error(`schedule ${operation} conflicted`);
  throw new Error(`schedule ${operation} rejected: ${result.code}`);
}

function nonEmpty(value: string, field: string): void {
  if (value.length === 0) throw new Error(`schedule projection requires ${field}`);
}

function nonNegativeInteger(value: number, field: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`schedule projection requires non-negative integer ${field}`);
  }
}
function assertExactKeys(value: object, allowed: ReadonlySet<string>, contract: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${contract} contains unsupported field ${key}`);
  }
}

const scheduleCreateKeys = new Set([
  "scheduleId",
  "agentName",
  "target",
  "expression",
  "payloadRef",
]);
const scheduleProjectionKeys = new Set([
  ...scheduleCreateKeys,
  "ownerKey",
  "status",
  "generation",
  "nextFireAtDbMs",
  "nextFireRef",
  "pendingFireRef",
  "settledFireRef",
  "sourceEventId",
  "sourceOwnerSeq",
  "sourceLedgerSeq",
  "sourceOwnerHash",
  "asOfLedgerSeq",
]);
const scheduleTargetKeys = new Set(["kind", "sessionId"]);

function assertScheduleCreateV1(schedule: ScheduleCreateV1): void {
  assertExactKeys(schedule, scheduleCreateKeys, "schedule create");
  assertExactKeys(schedule.target, scheduleTargetKeys, "schedule target");
  nonEmpty(schedule.scheduleId, "scheduleId");
  nonEmpty(schedule.agentName, "agentName");
  nonEmpty(schedule.expression, "expression");
  nonEmpty(schedule.payloadRef, "payloadRef");
  if (schedule.target.kind !== "resident" && schedule.target.kind !== "worker") {
    throw new Error("schedule create has invalid target kind");
  }
  if (schedule.target.sessionId !== undefined) nonEmpty(schedule.target.sessionId, "sessionId");
}

export function assertScheduleProjectionV1(projection: ScheduleProjectionV1): ScheduleProjectionV1 {
  assertExactKeys(projection, scheduleProjectionKeys, "schedule projection");
  assertExactKeys(projection.target, scheduleTargetKeys, "schedule target");
  nonEmpty(projection.scheduleId, "scheduleId");
  nonEmpty(projection.ownerKey, "ownerKey");
  nonEmpty(projection.agentName, "agentName");
  nonEmpty(projection.expression, "expression");
  nonEmpty(projection.payloadRef, "payloadRef");
  nonEmpty(projection.sourceEventId, "sourceEventId");
  nonEmpty(projection.sourceOwnerHash, "sourceOwnerHash");
  if (projection.target.kind !== "resident" && projection.target.kind !== "worker") {
    throw new Error("schedule projection has invalid target kind");
  }
  if (projection.target.sessionId !== undefined) nonEmpty(projection.target.sessionId, "sessionId");
  if (
    projection.status !== "active" &&
    projection.status !== "paused" &&
    projection.status !== "cancelled"
  ) {
    throw new Error("schedule projection has invalid status");
  }
  nonNegativeInteger(projection.generation, "generation");
  nonNegativeInteger(projection.sourceOwnerSeq, "sourceOwnerSeq");
  nonNegativeInteger(projection.sourceLedgerSeq, "sourceLedgerSeq");
  nonNegativeInteger(projection.asOfLedgerSeq, "asOfLedgerSeq");
  if (projection.asOfLedgerSeq < projection.sourceLedgerSeq) {
    throw new Error("schedule projection asOfLedgerSeq precedes sourceLedgerSeq");
  }
  if (projection.nextFireAtDbMs !== null) {
    nonNegativeInteger(projection.nextFireAtDbMs, "nextFireAtDbMs");
  }
  if ((projection.nextFireAtDbMs === null) !== (projection.nextFireRef === null)) {
    throw new Error("schedule projection next fire time and ref must be present together");
  }
  if (projection.nextFireRef !== null) nonEmpty(projection.nextFireRef, "nextFireRef");
  if (projection.pendingFireRef !== undefined)
    nonEmpty(projection.pendingFireRef, "pendingFireRef");
  if (projection.settledFireRef !== undefined)
    nonEmpty(projection.settledFireRef, "settledFireRef");
  return projection;
}

/**
 * Kernel schedule lifecycle. The transition adapter must commit each closed command before the
 * returned promise resolves. In particular SC-02 carries a settlement ref only; SC-01 carries a
 * distinct next-fire ref so a delivery acknowledgement can never masquerade as the next due time.
 */
export class ScheduleService {
  private readonly requestId: () => string;
  private readonly scanLimit: number;

  constructor(private readonly options: ScheduleServiceOptions) {
    if (!options.principalId) throw new Error("schedule service requires principalId");
    this.requestId = options.requestId ?? (() => crypto.randomUUID());
    this.scanLimit = options.scanLimit ?? 100;
    if (!Number.isInteger(this.scanLimit) || this.scanLimit <= 0) {
      throw new Error("schedule service scanLimit must be a positive integer");
    }
  }

  async create(schedule: ScheduleCreateV1): Promise<string> {
    assertScheduleCreateV1(schedule);
    const createdAtDbMs = this.options.nowMs?.() ?? Date.now();
    nonNegativeInteger(createdAtDbMs, "createdAtDbMs");
    const nextFireAtDbMs = computeNextScheduleFireAt(schedule.expression, createdAtDbMs);
    const nextFireRef = reference([schedule.scheduleId, 1, nextFireAtDbMs]);
    const ownerKey = this.options.ownerKey(schedule.scheduleId);
    nonEmpty(ownerKey, "ownerKey");
    const result = await this.options.transitions.execute({
      transitionId: "DP-23",
      requestId: this.requestId(),
      principalId: this.options.principalId,
      ownerKey,
      schedule,
      nextFireAtDbMs,
      nextFireRef,
    });
    const created = committed(result, "create");
    if (created.scheduleId !== schedule.scheduleId || created.ownerKey !== ownerKey) {
      throw new Error("schedule create transition returned mismatched identity");
    }
    return schedule.scheduleId;
  }

  async cancel(scheduleId: string): Promise<boolean> {
    const snapshot = await this.get(scheduleId);
    if (snapshot === null || snapshot.status === "cancelled") return false;
    const result = await this.options.transitions.execute({
      transitionId: "DP-24",
      requestId: this.requestId(),
      principalId: this.options.principalId,
      ownerKey: snapshot.ownerKey,
      scheduleId,
      expectedSourceOwnerHash: snapshot.sourceOwnerHash,
    });
    if (result.status === "conflict") return false;
    committed(result, "cancel");
    return true;
  }

  async get(scheduleId: string): Promise<ScheduleProjectionV1 | null> {
    const result = await this.options.queries.query({ kind: "schedule_by_id", scheduleId });
    if (result.kind !== "schedule_by_id")
      throw new Error("schedule query returned wrong result kind");
    if (result.snapshot === null) return null;
    const projection = assertScheduleProjectionV1(result.snapshot);
    if (projection.scheduleId !== scheduleId) {
      throw new Error("schedule query returned mismatched scheduleId");
    }
    return projection;
  }

  async scanDue(atMs: number): Promise<readonly ScheduleProjectionV1[]> {
    nonNegativeInteger(atMs, "scan atMs");
    const result = await this.options.queries.query({
      kind: "schedules_due",
      atMs,
      limit: this.scanLimit,
    });
    if (result.kind !== "schedules_due")
      throw new Error("schedule scan returned wrong result kind");
    return result.snapshots.map(assertScheduleProjectionV1);
  }

  async recordFire(
    snapshot: ScheduleProjectionV1,
    recordedAtDbMs: number,
  ): Promise<ScheduleFire | null> {
    assertScheduleProjectionV1(snapshot);
    nonNegativeInteger(recordedAtDbMs, "recordedAtDbMs");
    if (
      snapshot.status !== "active" ||
      snapshot.pendingFireRef !== undefined ||
      snapshot.nextFireAtDbMs === null ||
      snapshot.nextFireRef === null ||
      snapshot.nextFireAtDbMs > recordedAtDbMs
    ) {
      return null;
    }
    const result = await this.options.transitions.execute({
      transitionId: "RT-17",
      requestId: this.requestId(),
      principalId: this.options.principalId,
      ownerKey: snapshot.ownerKey,
      scheduleId: snapshot.scheduleId,
      expectedSourceOwnerHash: snapshot.sourceOwnerHash,
      generation: snapshot.generation,
      fireRef: snapshot.nextFireRef,
      dueAtDbMs: snapshot.nextFireAtDbMs,
      recordedAtDbMs,
    });
    if (result.status === "conflict") return null;
    const recorded = committed(result, "record fire");
    if (recorded.pendingFireRef !== snapshot.nextFireRef) {
      throw new Error("schedule fire transition returned mismatched pending fire ref");
    }
    return {
      schedule: recorded,
      generation: snapshot.generation,
      fireRef: snapshot.nextFireRef,
      dueAtDbMs: snapshot.nextFireAtDbMs,
      recordedAtDbMs,
    };
  }

  async settle(
    fire: ScheduleFire,
    settlement: "delivered" | "definite_failed",
    settledAtDbMs: number,
  ): Promise<ScheduleProjectionV1> {
    nonNegativeInteger(settledAtDbMs, "settledAtDbMs");
    const settlementRef = reference([fire.fireRef, settlement, settledAtDbMs]);
    return committed(
      await this.options.transitions.execute({
        transitionId: "SC-02",
        requestId: this.requestId(),
        principalId: this.options.principalId,
        ownerKey: fire.schedule.ownerKey,
        scheduleId: fire.schedule.scheduleId,
        expectedSourceOwnerHash: fire.schedule.sourceOwnerHash,
        generation: fire.generation,
        fireRef: fire.fireRef,
        settlement,
        settlementRef,
        settledAtDbMs,
      }),
      "settle fire",
    );
  }

  async advance(settled: ScheduleProjectionV1, afterDbMs: number): Promise<ScheduleProjectionV1> {
    assertScheduleProjectionV1(settled);
    nonNegativeInteger(afterDbMs, "afterDbMs");
    if (settled.status !== "active" || settled.pendingFireRef !== undefined) {
      throw new Error("schedule advance requires an active settled generation");
    }
    if (settled.settledFireRef === undefined) {
      throw new Error("schedule advance requires a durable settlement ref");
    }
    const nextFireAtDbMs = computeNextScheduleFireAt(settled.expression, afterDbMs);
    const nextGeneration = settled.generation + 1;
    const nextFireRef = reference([settled.scheduleId, nextGeneration, nextFireAtDbMs]);
    return committed(
      await this.options.transitions.execute({
        transitionId: "SC-01",
        requestId: this.requestId(),
        principalId: this.options.principalId,
        ownerKey: settled.ownerKey,
        scheduleId: settled.scheduleId,
        expectedSourceOwnerHash: settled.sourceOwnerHash,
        generation: nextGeneration,
        settledFireRef: settled.settledFireRef,
        nextFireAtDbMs,
        nextFireRef,
      }),
      "advance",
    );
  }
}
