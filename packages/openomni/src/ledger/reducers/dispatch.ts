import type { Ledger } from "@openomni/protocol";

export type DispatchStatusV1 = "decided" | "pending" | "received" | "delivered" | "failed";

export interface DispatchRecordV1 {
  readonly dispatchId: string;
  readonly status: DispatchStatusV1;
  readonly decisionEventId?: string;
  readonly pendingEventId?: string;
  readonly receivedEventId?: string;
  readonly settlementEventId?: string;
  readonly snapshotRef?: string;
}

export interface DispatchProjectionV1 {
  readonly records: ReadonlyMap<string, DispatchRecordV1>;
}

export class IllegalDispatchTransitionError extends Error {
  readonly code = "transition_forbidden" as const;

  constructor(
    readonly dispatchId: string,
    readonly from: DispatchStatusV1 | "absent",
    readonly eventType: Ledger.NativeEventTypeV1,
  ) {
    super(`illegal dispatch transition: ${dispatchId} ${from} -> ${eventType}`);
    this.name = "IllegalDispatchTransitionError";
  }
}

export function emptyDispatchProjection(): DispatchProjectionV1 {
  return Object.freeze({ records: new Map() });
}

function eventOf(input: Ledger.EventV1 | Ledger.EnvelopeV1): Ledger.EventV1 {
  return "event" in input ? input.event : input;
}

function nextRecord(
  previous: DispatchRecordV1 | undefined,
  event: Ledger.EventV1,
): DispatchRecordV1 {
  const dispatchId = event.payload.dispatchId;
  if (dispatchId === undefined) throw new Error("dispatch event missing dispatch ID");
  const snapshotRef = event.payload.dispatchSnapshotRef?.digest;
  if (snapshotRef === undefined) throw new Error("dispatch event missing projection snapshot ref");
  const from = previous?.status ?? "absent";
  const base = { dispatchId, snapshotRef };

  switch (event.eventType) {
    case "dispatch.decision.v1":
      if (previous !== undefined)
        throw new IllegalDispatchTransitionError(dispatchId, from, event.eventType);
      return Object.freeze({ ...base, status: "decided", decisionEventId: event.eventId });
    case "dispatch.pending.v1":
      if (previous !== undefined && previous.status !== "decided") {
        throw new IllegalDispatchTransitionError(dispatchId, from, event.eventType);
      }
      return Object.freeze({
        ...base,
        ...previous,
        status: "pending",
        pendingEventId: event.eventId,
        snapshotRef,
      });
    case "dispatch.received.v1":
      // Received is folded under the destination owner, so it has no local pending predecessor.
      if (previous !== undefined)
        throw new IllegalDispatchTransitionError(dispatchId, from, event.eventType);
      return Object.freeze({ ...base, status: "received", receivedEventId: event.eventId });
    case "dispatch.delivered.v1":
    case "dispatch.failed.v1":
      if (previous?.status !== "pending") {
        throw new IllegalDispatchTransitionError(dispatchId, from, event.eventType);
      }
      return Object.freeze({
        ...previous,
        status: event.eventType === "dispatch.delivered.v1" ? "delivered" : "failed",
        settlementEventId: event.eventId,
      });
    default:
      return previous ?? Object.freeze({ dispatchId, status: "decided" });
  }
}

/** Strict fold for dispatch_projection. Non-dispatch events leave the projection unchanged. */
export function reduceDispatch(
  current: DispatchProjectionV1,
  input: Ledger.EventV1 | Ledger.EnvelopeV1,
): DispatchProjectionV1 {
  const event = eventOf(input);
  if (!event.eventType.startsWith("dispatch.")) return current;

  const dispatchId = event.payload.dispatchId;
  if (dispatchId === undefined) throw new Error("dispatch event missing dispatch ID");
  const records = new Map(current.records);
  records.set(dispatchId, nextRecord(records.get(dispatchId), event));
  return Object.freeze({ records });
}
