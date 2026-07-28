import type { Ledger } from "@openomni/protocol";
import type { KernelTransitionCommandV1 } from "../ports.js";

export class KernelGuardError extends Error {
  readonly code = "transition_forbidden" as const;

  constructor(readonly reason: string) {
    super(`kernel transition guard rejected: ${reason}`);
    this.name = "KernelGuardError";
  }
}

export interface ReducedOwnerStateV1 {
  readonly eventsBySubject: ReadonlyMap<string, readonly Ledger.EnvelopeV1[]>;
}

export function reduceOwnerEvents(events: readonly Ledger.EnvelopeV1[]): ReducedOwnerStateV1 {
  const mutable = new Map<string, Ledger.EnvelopeV1[]>();
  for (const envelope of events) {
    const subjectId = envelope.event.payload.subjectId;
    const existing = mutable.get(subjectId);
    if (existing === undefined) mutable.set(subjectId, [envelope]);
    else existing.push(envelope);
  }
  return {
    eventsBySubject: new Map(
      [...mutable].map(([subjectId, subjectEvents]) => [subjectId, Object.freeze(subjectEvents)]),
    ),
  };
}

const CREATION_TRANSITIONS = new Set(["SS-01", "SS-02", "WI-01", "AT-01", "WT-01", "GR-01"]);
const TERMINAL_EVENT_TYPES = new Set([
  "session.closed.v1",
  "session.expired.v1",
  "work.archived.v1",
  "attempt.succeeded.v1",
  "attempt.failed.v1",
  "attempt.cancelled.v1",
  "wait.resolved.v1",
  "wait.expired.v1",
  "wait.cancelled.v1",
  "grant.revoked.v1",
  "grant.expired.v1",
]);

/** The single owner-state semantic gate used before every accepted append. */
export function assertTransitionGuards(
  command: KernelTransitionCommandV1,
  currentHead: Ledger.HeadV1,
  ownerEvents: readonly Ledger.EnvelopeV1[],
): void {
  if (
    currentHead.owner.ownerKey !== command.expectedHead.owner.ownerKey ||
    currentHead.ownerSeq !== command.expectedHead.ownerSeq ||
    currentHead.eventHash !== command.expectedHead.eventHash
  ) {
    throw new KernelGuardError("head_conflict");
  }

  const state = reduceOwnerEvents(ownerEvents);
  const subjectEvents = state.eventsBySubject.get(command.payload.subjectId) ?? [];
  if (CREATION_TRANSITIONS.has(command.transitionId) && subjectEvents.length > 0) {
    throw new KernelGuardError("subject_already_exists");
  }
  if (subjectEvents.some(({ event }) => TERMINAL_EVENT_TYPES.has(event.eventType))) {
    throw new KernelGuardError("subject_is_terminal");
  }

  if ("recordVersion" in command.payload) {
    const configurationEvents = subjectEvents.filter(({ event }) =>
      event.eventType.startsWith(
        command.transitionId === "AF-01"
          ? "artifact."
          : command.command.split(".")[1] === "authority"
            ? "authority."
            : command.command.split(".")[1] === "connector"
              ? "connector."
              : "actor.",
      ),
    );
    if (command.payload.recordVersion !== configurationEvents.length + 1) {
      throw new KernelGuardError("configuration_version_conflict");
    }
  }
}
