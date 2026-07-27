import type { Ledger } from "@openomni/protocol";

export type AttemptStatusV1 =
  | "allocated"
  | "starting"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface AttemptProjectionV1 {
  readonly attemptId: string;
  readonly attemptSeq: number;
  readonly retryOfAttemptId: string | null;
  readonly status: AttemptStatusV1;
  readonly revision: number;
  readonly startIntentRef: string | null;
  readonly confirmedEffectRefs: readonly string[];
  readonly failureRef: string | null;
  readonly waitRef: string | null;
}

const ATTEMPT_EVENTS = new Set<Ledger.NativeEventTypeV1>([
  "attempt.allocated.v1",
  "attempt.start_requested.v1",
  "attempt.running.v1",
  "attempt.start_failed.v1",
  "attempt.waiting.v1",
  "attempt.succeeded.v1",
  "attempt.failed.v1",
  "attempt.cancelled.v1",
  "attempt.interrupted.v1",
]);

function ref(envelope: Ledger.EnvelopeV1): string {
  const payload = envelope.event.payload;
  const snapshot = payload.attemptSnapshotRef ?? payload.effectSettlementRef;
  if (snapshot === undefined || snapshot === null || typeof snapshot === "string") {
    throw new Error("attempt-related event missing projection snapshot ref");
  }
  return snapshot.digest;
}

function terminal(status: AttemptStatusV1): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

/** Deterministically rebuilds immutable attempt lineage and lifecycle state. */
export function reduceAttemptProjections(
  events: readonly Ledger.EnvelopeV1[],
): ReadonlyMap<string, AttemptProjectionV1> {
  const states = new Map<string, AttemptProjectionV1>();
  let lastAllocated: AttemptProjectionV1 | null = null;
  const confirmedEffects = new Map<string, readonly string[]>();
  for (const envelope of [...events].sort((a, b) => a.ownerSeq - b.ownerSeq)) {
    const { event } = envelope;
    if (event.eventType === "effect.confirmed.v1") {
      const attemptId = event.payload.attemptId;
      if (attemptId === undefined) throw new Error("effect confirmation missing attempt binding");
      const existing = confirmedEffects.get(attemptId) ?? [];
      confirmedEffects.set(attemptId, Object.freeze([...existing, ref(envelope)]));
      continue;
    }
    if (!ATTEMPT_EVENTS.has(event.eventType)) continue;
    const attemptId = event.payload.attemptId;
    if (attemptId === undefined) throw new Error("attempt event missing attempt ID");
    const current = states.get(attemptId);
    if (event.eventType === "attempt.allocated.v1") {
      if (current !== undefined) throw new Error("invalid attempt history: duplicate allocation");
      if (lastAllocated !== null && !terminal(lastAllocated.status)) {
        throw new Error("invalid attempt history: retry predecessor is nonterminal");
      }
      const allocated: AttemptProjectionV1 = Object.freeze({
        attemptId,
        attemptSeq: states.size + 1,
        retryOfAttemptId: lastAllocated?.attemptId ?? null,
        status: "allocated" as const,
        revision: 1,
        startIntentRef: null,
        confirmedEffectRefs: Object.freeze([]) as readonly string[],
        failureRef: null,
        waitRef: null,
      });
      states.set(attemptId, allocated);
      lastAllocated = allocated;
      continue;
    }
    if (current === undefined) throw new Error("invalid attempt history: event before allocation");
    if (terminal(current.status))
      throw new Error("invalid attempt history: event after terminal state");
    let next: AttemptProjectionV1;
    switch (event.eventType) {
      case "attempt.start_requested.v1":
        if (current.status !== "allocated")
          throw new Error("invalid attempt history: start requires allocated");
        next = {
          ...current,
          status: "starting",
          startIntentRef: ref(envelope),
          revision: current.revision + 1,
        };
        break;
      case "attempt.running.v1": {
        if (current.status !== "starting" && current.status !== "waiting") {
          throw new Error("invalid attempt history: confirmation requires starting or waiting");
        }
        const confirmations = confirmedEffects.get(attemptId) ?? [];
        if (confirmations.length === current.confirmedEffectRefs.length) {
          throw new Error("invalid attempt history: running requires a newly confirmed effect");
        }
        next = {
          ...current,
          status: "running",
          confirmedEffectRefs: Object.freeze([...confirmations]),
          revision: current.revision + 1,
        };
        break;
      }
      case "attempt.start_failed.v1":
        if (current.status !== "starting")
          throw new Error("invalid attempt history: start failure requires starting");
        next = {
          ...current,
          status: "failed",
          failureRef: ref(envelope),
          revision: current.revision + 1,
        };
        break;
      case "attempt.waiting.v1":
        if (current.status !== "running")
          throw new Error("invalid attempt history: wait requires running");
        next = {
          ...current,
          status: "waiting",
          waitRef: ref(envelope),
          revision: current.revision + 1,
        };
        break;
      case "attempt.succeeded.v1":
      case "attempt.failed.v1":
      case "attempt.cancelled.v1":
      case "attempt.interrupted.v1": {
        const status = event.eventType.slice("attempt.".length, -".v1".length) as AttemptStatusV1;
        const allowed =
          (status === "succeeded" && current.status === "running") ||
          ((status === "failed" || status === "interrupted") &&
            (current.status === "starting" ||
              current.status === "running" ||
              current.status === "waiting")) ||
          (status === "cancelled" &&
            (current.status === "starting" ||
              current.status === "running" ||
              current.status === "waiting"));
        if (!allowed)
          throw new Error("invalid attempt history: terminal edge from incompatible state");
        next = {
          ...current,
          status,
          failureRef:
            status === "failed" || status === "interrupted" ? ref(envelope) : current.failureRef,
          revision: current.revision + 1,
        };
        break;
      }
      default:
        continue;
    }
    const frozen = Object.freeze(next);
    states.set(attemptId, frozen);
    if (lastAllocated?.attemptId === attemptId) lastAllocated = frozen;
  }
  return new Map(states);
}

export function attemptIsTerminal(attempt: AttemptProjectionV1): boolean {
  return terminal(attempt.status);
}
