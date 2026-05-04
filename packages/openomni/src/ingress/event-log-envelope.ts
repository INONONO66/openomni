import { ExecutionEvent } from "@openomni/protocol";
import { Log, Storage } from "@openomni/session";

const INGRESS_LEDGER_VISIBILITY = "internal";
const TEXT_SUMMARY_LIMIT = 240;

export interface IngressLedgerEvent {
  readonly actionId: string;
}

export interface TextSummary {
  readonly text: string;
  readonly length: number;
  readonly truncated: boolean;
}

export function summarizeText(text: string): TextSummary {
  return {
    text: text.length > TEXT_SUMMARY_LIMIT ? text.slice(0, TEXT_SUMMARY_LIMIT) : text,
    length: text.length,
    truncated: text.length > TEXT_SUMMARY_LIMIT,
  };
}

function fallbackNextSequence(
  eventLog: NonNullable<Storage.Adapter["eventLog"]>,
  sessionId: string,
): number {
  let maxSequence = 0;
  for (const row of eventLog.replay(sessionId)) {
    try {
      const parsed = ExecutionEvent.Schema.safeParse(JSON.parse(row.data));
      if (parsed.success) maxSequence = Math.max(maxSequence, parsed.data.sequence);
    } catch (error) {
      Log.warn("ingress: malformed EventLog row skipped for sequence allocation", {
        sessionId,
        error: String(error),
      });
    }
  }
  return maxSequence + 1;
}

export function createIngressLedger(sessionId: string, scope: string) {
  const adapter = Storage.get();
  const eventLog = adapter.eventLog;
  if (eventLog === undefined || adapter.session.get(sessionId) === undefined) {
    return { append: () => undefined as IngressLedgerEvent | undefined };
  }

  return {
    append(
      name: string,
      payload: Record<string, unknown>,
      parentActionId?: string,
    ): IngressLedgerEvent | undefined {
      let sequence: number;
      try {
        sequence = eventLog.allocateSequence
          ? eventLog.allocateSequence(sessionId)
          : fallbackNextSequence(eventLog, sessionId);
      } catch (error) {
        Log.warn("ingress: EventLog replay failed for sequence allocation", {
          sessionId,
          name,
          error: String(error),
        });
        return undefined;
      }

      const event: ExecutionEvent.MirroredBusEvent = {
        type: "bus_event",
        name,
        payload,
        actionId: `${sessionId}:${scope}:${name}:${sequence}`,
        ...(parentActionId !== undefined && { parentActionId }),
        visibility: INGRESS_LEDGER_VISIBILITY,
        timestamp: new Date().toISOString(),
        sequence,
      };

      try {
        eventLog.append(sessionId, event.type, JSON.stringify(event));
        return { actionId: event.actionId };
      } catch (error) {
        Log.warn("ingress: EventLog append failed", {
          sessionId,
          name,
          error: String(error),
        });
        return undefined;
      }
    },
  };
}
