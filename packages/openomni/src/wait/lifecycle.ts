import { Operational, Wait } from "@openomni/protocol";
import { WaitStore } from "@openomni/session";
import { Bus } from "@openomni/telemetry";

/**
 * Effectful kernel Wait service (#215). Definitions (schema + fold) live in
 * protocol; durable persistence and fold application live in the session
 * WaitStore; this service is the single kernel entry that wires them to
 * delivery. Owner decision 2: ONLY awaited delivery opens a Wait row —
 * fire-and-forget and the synchronous resident.ask path record audit events
 * and never write.
 */
export namespace WaitService {
  /** Opens the one durable Wait for an awaited delivery. Fails closed on a missing adapter or duplicate origin message. */
  export function open(input: Wait.Create, traceId: string): Wait.Record {
    return WaitStore.create(input, traceId);
  }

  /**
   * Applies one inbound reply: the fold decides (duplicate / late / deadline /
   * unknown / ambiguous / attach / resolve) and the store persists the
   * outcome under a revision compare-and-set.
   */
  export function attachReply(id: string, input: Wait.ReplyInput, traceId: string): Wait.Outcome {
    return WaitStore.attachReply(id, input, traceId);
  }

  /**
   * Records the platform message id returned by the concrete delivery owner
   * after a successful awaited delivery: correlation.replyToMessageId re-keys
   * from the internal message id to the platform id so real platform replies
   * correlate. No receipt leaves the correlation unchanged (internal id).
   */
  export function recordDeliveryReceipt(
    id: string,
    input: Wait.DeliveryReceiptInput,
    traceId: string,
  ): Wait.Outcome {
    return WaitStore.recordDeliveryReceipt(id, input, traceId);
  }

  /**
   * Lazy expiry entry: a late reply is often the first observer of a passed
   * deadline — the route folds the wait to expired (partial when replies had
   * attached) before returning the typed rejection.
   */
  export function expire(id: string, traceId: string, at = Date.now()): Wait.Outcome {
    return WaitStore.expire(id, traceId, at);
  }

  /**
   * Expiry sweep entry (boot recovery): folds every deadline-passed open
   * wait to expired (partial when replies attached). Per-wait fault
   * isolation (#510 review fix F3): one corrupt wait (e.g. a stream whose
   * head disagrees with its row) records an Operational.Events.Error and the sweep
   * continues — a single bad row must never kill boot recovery.
   *
   * `traceId` is the caller's (boot recovery's): the sweep is mid-flow, not a
   * trace origin — ONE id covers the whole sweep, including every per-corrupt-
   * wait error it records.
   */
  export function sweepExpired(traceId: string, now = Date.now()): Wait.Record[] {
    const expired: Wait.Record[] = [];
    for (const record of WaitStore.list(["open"])) {
      if (now <= record.expiresAt) continue;
      try {
        const outcome = expire(record.id, traceId, now);
        if (outcome.kind === "expired") expired.push(outcome.record);
      } catch (error) {
        Bus.publish(Operational.Events.Error, {
          traceId,
          time: Date.now(),
          component: "wait",
          msg: `wait expiry sweep failed for ${record.id}`,
          context: {
            waitId: record.id,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
    return expired;
  }

  /**
   * Audit record for the synchronous in-process resident.ask path: the ask
   * resolves inside one dispatch, so it never opens a Wait row (#215 owner
   * decision 2) — this event is the only trace it leaves.
   */
  export function auditSyncAsk(input: {
    dispatchId: string;
    traceId: string;
    sessionId: string;
    phase: "opened" | "answered" | "failed";
  }): void {
    Bus.publish(Wait.Events.SyncAsk, { ...input, time: Date.now() });
  }
}
