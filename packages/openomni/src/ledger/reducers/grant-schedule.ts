import type { Ledger } from "@openomni/protocol";

export type GrantStatusV1 = "active" | "revoked" | "expired";

export interface GrantProjectionV1 {
  readonly grantId: string;
  readonly version: number;
  readonly status: GrantStatusV1;
  readonly attemptSourceRef: string;
  readonly lastEventId: string;
}

export interface ScheduleProjectionV1 {
  readonly scheduleId: string;
  readonly generation: number;
  readonly status: "active" | "cancelled";
  readonly nextFireRef: string | null;
  readonly pendingFire: {
    readonly generation: number;
    readonly sourceRef: string;
    readonly eventId: string;
  } | null;
  readonly lastSettledGeneration: number | null;
}

const grantEvents = new Set([
  "grant.created.v1",
  "grant.revised.v1",
  "grant.revoked.v1",
  "grant.expired.v1",
]);

export function reduceGrant(
  events: readonly Ledger.EnvelopeV1[],
  grantId?: string,
): GrantProjectionV1 | null {
  let state: GrantProjectionV1 | null = null;
  for (const { event } of events) {
    if (
      !grantEvents.has(event.eventType) ||
      (grantId !== undefined && event.payload.grantId !== grantId)
    ) {
      continue;
    }
    const projectedGrantId = event.payload.grantId;
    const sourceRef = event.payload.attemptId;
    if (projectedGrantId === undefined || sourceRef === undefined) {
      throw new Error("grant projection missing exact grant and attempt facts");
    }
    if (state === null) {
      if (event.eventType !== "grant.created.v1")
        throw new Error("grant history must start with grant.created.v1");
      state = Object.freeze({
        grantId: projectedGrantId,
        version: 1,
        status: "active",
        attemptSourceRef: sourceRef,
        lastEventId: event.eventId,
      });
      continue;
    }
    if (projectedGrantId !== state.grantId) continue;
    if (state.status !== "active") throw new Error("grant terminal state cannot transition");
    if (sourceRef !== state.attemptSourceRef) throw new Error("grant attempt source ref mismatch");
    const status =
      event.eventType === "grant.revoked.v1"
        ? "revoked"
        : event.eventType === "grant.expired.v1"
          ? "expired"
          : event.eventType === "grant.revised.v1"
            ? "active"
            : null;
    if (status === null) throw new Error("grant can only be created once");
    state = Object.freeze({
      ...state,
      version: state.version + 1,
      status,
      lastEventId: event.eventId,
    });
  }
  return state;
}

const scheduleEvents = new Set([
  "schedule.created.v1",
  "schedule.advanced.v1",
  "schedule.cancelled.v1",
  "schedule.fire_due.v1",
  "schedule.fire_settled.v1",
]);

export function reduceSchedule(
  events: readonly Ledger.EnvelopeV1[],
  scheduleId?: string,
): ScheduleProjectionV1 | null {
  let state: ScheduleProjectionV1 | null = null;
  for (const { event } of events) {
    if (
      !scheduleEvents.has(event.eventType) ||
      (scheduleId !== undefined && event.payload.scheduleId !== scheduleId)
    ) {
      continue;
    }
    const projectedScheduleId = event.payload.scheduleId;
    if (projectedScheduleId === undefined) throw new Error("schedule event missing schedule ID");
    if (state === null) {
      if (event.eventType !== "schedule.created.v1" && event.eventType !== "schedule.advanced.v1") {
        throw new Error("schedule history must start with creation or initialization advance");
      }
      state = Object.freeze({
        scheduleId: projectedScheduleId,
        generation: 0,
        status: "active",
        nextFireRef: null,
        pendingFire: null,
        lastSettledGeneration: null,
      });
    }
    if (event.payload.scheduleId !== state.scheduleId) continue;
    if (state.status === "cancelled") throw new Error("cancelled schedule cannot transition");

    switch (event.eventType) {
      case "schedule.created.v1":
        if (state.generation !== 0 || state.nextFireRef !== null)
          throw new Error("schedule can only be created once");
        break;
      case "schedule.advanced.v1": {
        if (state.pendingFire !== null)
          throw new Error("schedule cannot advance while a fire is pending");
        const nextFireRef = event.payload.nextFireRef;
        if (nextFireRef === undefined || nextFireRef === null) {
          throw new Error("schedule advance missing deterministic next fire ref");
        }
        state = Object.freeze({
          ...state,
          generation: state.generation + 1,
          nextFireRef,
        });
        break;
      }
      case "schedule.fire_due.v1": {
        if (state.generation < 1 || state.pendingFire !== null)
          throw new Error("schedule generation is not due");
        const sourceRef = event.payload.nextFireRef;
        if (sourceRef === undefined || sourceRef === null || sourceRef !== state.nextFireRef) {
          throw new Error("schedule due source ref mismatch");
        }
        state = Object.freeze({
          ...state,
          pendingFire: Object.freeze({
            generation: state.generation,
            sourceRef,
            eventId: event.eventId,
          }),
        });
        break;
      }
      case "schedule.fire_settled.v1": {
        if (state.pendingFire === null) throw new Error("schedule has no pending fire to settle");
        if (event.payload.nextFireRef !== state.pendingFire.sourceRef) {
          throw new Error("schedule settlement source ref mismatch");
        }
        state = Object.freeze({
          ...state,
          pendingFire: null,
          nextFireRef: null,
          lastSettledGeneration: state.pendingFire.generation,
        });
        break;
      }
      case "schedule.cancelled.v1":
        if (state.pendingFire !== null)
          throw new Error("schedule with a pending fire cannot be cancelled");
        state = Object.freeze({ ...state, status: "cancelled", nextFireRef: null });
        break;
    }
  }
  return state;
}
