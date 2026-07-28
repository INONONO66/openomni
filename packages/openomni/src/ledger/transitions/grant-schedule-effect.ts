import type { Ledger } from "@openomni/protocol";
import type { KernelTransitionCommandV1 } from "../ports.js";
import { reduceEffect, type EffectProjectionV1 } from "../reducers/effect.js";
import { reduceGrant, reduceSchedule } from "../reducers/grant-schedule.js";

export class GrantScheduleEffectGuardError extends Error {
  readonly code = "transition_forbidden" as const;

  constructor(readonly reason: string) {
    super(`grant/schedule/effect transition forbidden: ${reason}`);
    this.name = "GrantScheduleEffectGuardError";
  }
}

function deny(reason: string): never {
  throw new GrantScheduleEffectGuardError(reason);
}

function grantAttemptRef(command: KernelTransitionCommandV1): string {
  if (!("attempt" in command.payload) || command.payload.attempt === undefined) {
    return deny("missing payload.attempt");
  }
  return command.payload.attempt.attemptId;
}

function scheduleNextFireRef(command: KernelTransitionCommandV1): string {
  if (!("nextFireRef" in command.payload) || typeof command.payload.nextFireRef !== "string") {
    return deny("missing payload.nextFireRef");
  }
  return command.payload.nextFireRef;
}

function effectIdempotencyRef(command: KernelTransitionCommandV1): string {
  const payload = command.payload as { readonly effect?: Ledger.EffectRefV1 };
  if (payload.effect === undefined) return deny("missing payload.effect");
  return payload.effect.idempotencyKey;
}

function assertOwnerHistory(
  command: KernelTransitionCommandV1,
  events: readonly Ledger.EnvelopeV1[],
): void {
  if (events.length !== command.expectedHead.ownerSeq)
    deny("owner history does not match expected head");
  let previousHash: Ledger.EnvelopeV1["previousEventHash"] = "GENESIS_V1";
  for (let index = 0; index < events.length; index += 1) {
    const envelope = events[index];
    if (envelope === undefined) deny("owner history is missing an event");
    if (
      envelope.event.owner.ownerKey !== command.payload.owner.ownerKey ||
      envelope.ownerSeq !== index + 1 ||
      envelope.previousEventHash !== previousHash
    ) {
      deny("owner history is not exact and contiguous");
    }
    previousHash = envelope.eventHash;
  }
  if (previousHash !== command.expectedHead.eventHash) deny("owner history head hash mismatch");
}

export function assertGrantTransition(
  command: KernelTransitionCommandV1,
  ownerEvents: readonly Ledger.EnvelopeV1[],
): void {
  if (!command.transitionId.startsWith("GR-")) deny("not a grant transition");
  assertOwnerHistory(command, ownerEvents);
  const sourceRef = grantAttemptRef(command);
  if (!("attempt" in command.payload) || command.payload.attempt === undefined) {
    deny("missing payload.attempt");
  }
  const state = reduceGrant(ownerEvents, command.payload.grantId as string);
  switch (command.transitionId) {
    case "GR-01":
      if (state !== null) deny("grant already exists");
      if (command.expectedHead.ownerSeq !== 0) deny("grant creation requires genesis head");
      return;
    case "GR-02":
    case "GR-03":
    case "GR-04":
      if (state === null) deny("grant does not exist");
      if (state.status !== "active") deny(`grant is ${state.status}`);
      if (state.attemptSourceRef !== sourceRef) deny("grant attempt source ref mismatch");
      return;
    default:
      deny("unknown grant transition");
  }
}

function effectBySourceRef(
  events: readonly Ledger.EnvelopeV1[],
  sourceRef: string,
): EffectProjectionV1 | null {
  const effectIds = [
    ...new Set(
      events
        .filter(
          ({ event }) =>
            event.eventType === "effect.intent.v1" && event.payload.idempotencyKey === sourceRef,
        )
        .map(({ event }) => event.payload.effectId)
        .filter((effectId): effectId is string => effectId !== undefined),
    ),
  ];
  if (effectIds.length !== 1) return null;
  const effectId = effectIds[0];
  if (effectId === undefined) return null;
  return reduceEffect(events, effectId);
}

export function assertScheduleTransition(
  command: KernelTransitionCommandV1,
  ownerEvents: readonly Ledger.EnvelopeV1[],
): void {
  if (!command.transitionId.startsWith("SC-")) deny("not a schedule transition");
  assertOwnerHistory(command, ownerEvents);
  const nextFireRef = scheduleNextFireRef(command);
  const scheduleId =
    command.payload.version === "native-transition-payload-v1"
      ? command.payload.scheduleId
      : undefined;
  const state = reduceSchedule(ownerEvents, scheduleId);
  switch (command.transitionId) {
    case "SC-01":
      if (state !== null && (state.status !== "active" || state.pendingFire !== null)) {
        deny("schedule cannot advance from its current state");
      }
      return;
    case "SC-02": {
      if (state === null || state.status !== "active") deny("active schedule does not exist");
      if (state.pendingFire === null) deny("schedule has no pending due generation");
      if (state.pendingFire.sourceRef !== nextFireRef)
        deny("schedule due generation source ref mismatch");
      const effect = effectBySourceRef(ownerEvents, state.pendingFire.sourceRef);
      if (effect === null) deny("schedule fire is pending without a recorded effect intent");
      if (effect.status === "pending" || effect.status === "unknown") {
        deny(`schedule fire effect is ${effect.status}`);
      }
      if (effect.status !== "confirmed" && effect.status !== "definite_failed") {
        deny(`schedule fire effect has non-settleable status ${effect.status}`);
      }
      return;
    }
    default:
      deny("unknown schedule transition");
  }
}

export function assertEffectTransition(
  command: KernelTransitionCommandV1,
  ownerEvents: readonly Ledger.EnvelopeV1[],
): void {
  if (!command.transitionId.startsWith("EF-")) deny("not an effect transition");
  assertOwnerHistory(command, ownerEvents);
  const sourceRef = effectIdempotencyRef(command);
  const payload = command.payload as { readonly effect?: Ledger.EffectRefV1 };
  const effect = payload.effect;
  if (effect === undefined) deny("missing effect");
  const effectId = effect.effectId;
  const state = reduceEffect(ownerEvents, effectId);
  if (state === null) deny("effect settlement requires record-before-act intent");
  if (state.idempotencyRef !== sourceRef) deny("effect source ref mismatch");
  switch (command.transitionId) {
    case "EF-01":
    case "EF-02":
    case "EF-03":
      if (state.status !== "pending") deny(`effect is ${state.status}`);
      return;
    case "EF-04":
      if (state.status !== "unknown") deny("manual resolution requires unknown effect");
      return;
    default:
      deny("unknown effect transition");
  }
}

export function assertGrantScheduleEffectTransition(
  command: KernelTransitionCommandV1,
  ownerEvents: readonly Ledger.EnvelopeV1[],
): void {
  if (command.transitionId.startsWith("GR-")) {
    assertGrantTransition(command, ownerEvents);
    return;
  }
  if (command.transitionId.startsWith("SC-")) {
    assertScheduleTransition(command, ownerEvents);
    return;
  }
  if (command.transitionId.startsWith("EF-")) {
    assertEffectTransition(command, ownerEvents);
    return;
  }
  deny("transition is outside GR/SC/EF families");
}
