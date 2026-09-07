import { Gateway, type Inbox, type ObservationSink, type SessionTurn } from "@openomni/protocol";
import { scopeObservation } from "./observation/bus";

/** Invoked only after the consuming inbox/action transaction returns its receipt. */
export function observeDrained(
  rows: readonly Inbox.Row[],
  turnId: string,
  boundary: SessionTurn.Boundary,
  at: number,
  sink: ObservationSink,
): void {
  for (const row of rows) {
    const scoped = scopeObservation(
      sink,
      { sessionId: row.sessionId, turnId },
      { clock: () => at },
    );
    scoped.publish(Gateway.MessageObserved, {
      kind: "message.drained",
      messageId: row.id,
      queueMs: Math.max(0, at - row.createdAt),
      boundary,
    });
  }
}
