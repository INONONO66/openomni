import { Wait } from "@openomni/protocol";
import { Bus, WaitStore } from "@openomni/session";

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
  export function open(input: Wait.Create): Wait.Record {
    return WaitStore.create(input);
  }

  /**
   * Applies one inbound reply: the fold decides (duplicate / late / deadline /
   * unknown / ambiguous / attach / resolve) and the store persists the
   * outcome under a revision compare-and-set.
   */
  export function attachReply(id: string, input: Wait.ReplyInput): Wait.Outcome {
    return WaitStore.attachReply(id, input);
  }

  export function cancel(id: string, at = Date.now()): Wait.Outcome {
    return WaitStore.cancel(id, at);
  }

  /**
   * Lazy expiry entry: a late reply is often the first observer of a passed
   * deadline — the route folds the wait to expired (partial when replies had
   * attached) before returning the typed rejection.
   */
  export function expire(id: string, at = Date.now()): Wait.Outcome {
    return WaitStore.expire(id, at);
  }

  /** Expiry sweep entry (boot recovery): folds every deadline-passed open wait to expired (partial when replies attached). */
  export function sweepExpired(now = Date.now()): Wait.Record[] {
    const expired: Wait.Record[] = [];
    for (const record of WaitStore.list(["open"])) {
      if (now <= record.expiresAt) continue;
      const outcome = expire(record.id, now);
      if (outcome.kind === "expired") expired.push(outcome.record);
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
    sessionId: string;
    phase: "opened" | "answered" | "failed";
  }): void {
    Bus.publish(Wait.Events.SyncAsk, { ...input, time: Date.now() });
  }
}
