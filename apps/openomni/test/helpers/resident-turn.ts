import { Bus } from "@openomni/agent";
import { SessionHandleStore } from "@openomni/ledger";
import { L0Observation, type SessionTurn } from "@openomni/protocol";
import { eventSignal } from "./event-signal";

/** A model turn completes in the ledger, not through an unsolicited external reply. */
export function nextResidentTurn(timeoutMs = 10_000): Promise<SessionTurn.Terminal> {
  const signal = eventSignal<SessionTurn.Terminal>("resident terminal", timeoutMs);
  const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
    if (event.kind !== "turn" || SessionHandleStore.row(event.sessionId).role !== "resident") return;
    const terminal = SessionHandleStore.latestTurnTerminal(event.sessionId);
    if (terminal?.action.id === event.id) signal.resolve(terminal.effect);
  });
  return signal.promise.finally(unsubscribe);
}
