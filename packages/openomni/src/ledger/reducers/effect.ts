import type { Ledger } from "@openomni/protocol";

export type EffectStatusV1 =
  | "pending"
  | "confirmed"
  | "definite_failed"
  | "unknown"
  | "manually_resolved";

export interface EffectProjectionV1 {
  readonly effectId: string;
  readonly idempotencyRef: string;
  readonly status: EffectStatusV1;
  readonly intentEventId: string;
  readonly settlementEventId: string | null;
  readonly unknownEventId: string | null;
}

const effectEvents = new Set([
  "effect.intent.v1",
  "effect.confirmed.v1",
  "effect.definite_failed.v1",
  "effect.unknown.v1",
  "effect.manually_resolved.v1",
]);

export function reduceEffect(
  events: readonly Ledger.EnvelopeV1[],
  effectId?: string,
): EffectProjectionV1 | null {
  let state: EffectProjectionV1 | null = null;
  for (const { event } of events) {
    if (
      !effectEvents.has(event.eventType) ||
      (effectId !== undefined && event.payload.effectId !== effectId)
    ) {
      continue;
    }
    const projectedEffectId = event.payload.effectId;
    const sourceRef = event.payload.idempotencyKey;
    if (projectedEffectId === undefined || sourceRef === undefined) {
      throw new Error("effect event missing exact effect and idempotency facts");
    }
    if (state === null) {
      if (event.eventType !== "effect.intent.v1")
        throw new Error("effect settlement requires a recorded intent");
      state = Object.freeze({
        effectId: projectedEffectId,
        idempotencyRef: sourceRef,
        status: "pending",
        intentEventId: event.eventId,
        settlementEventId: null,
        unknownEventId: null,
      });
      continue;
    }
    if (projectedEffectId !== state.effectId) continue;
    if (sourceRef !== state.idempotencyRef) throw new Error("effect source ref mismatch");

    if (event.eventType === "effect.manually_resolved.v1") {
      if (state.status !== "unknown")
        throw new Error("only an unknown effect may be manually resolved");
      state = Object.freeze({
        ...state,
        status: "manually_resolved",
        settlementEventId: event.eventId,
      });
      continue;
    }
    if (event.eventType === "effect.intent.v1") throw new Error("effect intent is immutable");
    if (state.status !== "pending") throw new Error("effect is already settled");
    const status =
      event.eventType === "effect.confirmed.v1"
        ? "confirmed"
        : event.eventType === "effect.definite_failed.v1"
          ? "definite_failed"
          : "unknown";
    state = Object.freeze({
      ...state,
      status,
      settlementEventId: event.eventId,
      unknownEventId: status === "unknown" ? event.eventId : null,
    });
  }
  return state;
}

/** External action is legal only after its durable intent exists and while it remains pending. */
export function assertEffectMayAct(state: EffectProjectionV1 | null): EffectProjectionV1 {
  if (state === null) throw new Error("effect action denied: missing recorded intent");
  if (state.status !== "pending")
    throw new Error(`effect action denied: effect is ${state.status}`);
  return state;
}
