import { SessionHandleStore } from "@openomni/ledger";
import { canonicalDigest, Inbox, SessionTransition, type LedgerAction, type LedgerSession } from "@openomni/protocol";
import type { SessionRunnerResult } from "./session-contract";

/** A child seals its own obligation; only the receiving executor changes the parent. */
export function parentReply(
  row: LedgerSession.Row,
  terminal: LedgerAction.Append,
  result: SessionRunnerResult,
): SessionTransition.OutboundMessage | undefined {
  if (row.parentId === null || result.kind === "waiting") return undefined;
  const original = SessionHandleStore.inboxRows(row.id)
    .map((item) => Inbox.MessageOrigin.safeParse(item.origin.value))
    .find((origin) => origin.success && origin.data.senderSessionId === row.parentId);
  if (original === undefined || !original.success) return undefined;
  const message = {
    messageId: `${terminal.id}:reply`,
    sourceSessionId: row.id,
    sourceActionId: terminal.id,
    destinationSessionId: row.parentId,
    requestId: original.data.sourceActionId,
    replyTo: original.data.replyTo ?? original.data.messageId,
    terminal: result.kind === "result" ? "completed" as const : result.kind,
    content: result.text ?? "",
  };
  return SessionTransition.OutboundMessage.parse({ ...message, digest: canonicalDigest(message) });
}
