import { z } from "zod";
import { parseStoredJson } from "./sqlite-json-data";
import type { Database } from "bun:sqlite";
import {
  Gateway,
  Inbox,
  type LedgerAction,
  PlainValueSchema,
  SessionTransition,
  L0Observation,
  type ObservationSink,
} from "@openomni/protocol";

export function publishCommitted(
  db: Database,
  sink: ObservationSink,
  receipt: LedgerAction.Receipt,
): void {
  try {
    sink.publish(L0Observation.ActionCommittedEvent, {
      id: receipt.action.id,
      sessionId: receipt.action.sessionId,
      revision: receipt.revision,
      kind: receipt.action.kind,
    });
    publishMessageTerminal(db, sink, receipt.action);
  } catch {
    console.warn(`post-commit observation failed: ${receipt.action.id}`);
  }
}

function publishMessageTerminal(
  db: Database,
  sink: ObservationSink,
  action: LedgerAction.Node,
): void {
  const scoped = sink.scope?.({ sessionId: action.sessionId }) ?? sink;
  if (action.kind === "request" && action.id.endsWith(":resolution")) {
    const effect = action.effect.value;
    if (effect === null || typeof effect !== "object" || Array.isArray(effect)) return;
    const request = SessionTransition.Request.parse(effect.request);
    if (request.mode === "reply" && request.state === "expired") {
      const source = requestMessageIdentity(db, request.requestId, action.sessionId);
      scoped.publish(Gateway.MessageObserved, {
        kind: "message.timed_out",
        messageId: source.messageId,
        waitedMs: Math.max(0, action.ts - request.createdAt),
      });
    }
    return;
  }
  if (action.kind !== "prompt") return;
  const native = SessionTransition.OutboundMessage.safeParse(action.intent.value);
  const external = Inbox.ReplyOrigin.safeParse(action.intent.value);
  const binding = native.success
    ? { requestId: native.data.requestId, replyTo: native.data.replyTo }
    : external.success
      ? { requestId: external.data.sourceActionId, replyTo: external.data.replyTo }
      : undefined;
  if (binding === undefined) return;
  const source = requestMessageIdentity(db, binding.requestId, action.sessionId);
  scoped.publish(Gateway.MessageObserved, {
    kind: "message.replied",
    messageId: source.messageId,
    replyTo: binding.replyTo,
    roundTripMs: Math.max(0, action.ts - source.ts),
  });
}

function requestMessageIdentity(
  db: Database,
  id: string,
  sessionId: string,
): { messageId: string; ts: number } {
  const source = z
    .object({ intent: z.string(), ts: z.number() })
    .nullable()
    .parse(
      db.query("SELECT intent, ts FROM action WHERE id = ? AND session_id = ?").get(id, sessionId),
    );
  if (source === null) throw new Error("committed reply source is missing");
  const intent = PlainValueSchema.parse(parseStoredJson(source.intent));
  const value =
    intent !== null && typeof intent === "object" && !Array.isArray(intent)
      ? intent.value
      : undefined;
  const messageId =
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.messageId === "string"
      ? value.messageId
      : id;
  return { messageId, ts: source.ts };
}
