import { SessionHandleStore } from "@openomni/ledger";
import { Inbox, type LedgerAction, type LedgerSession } from "@openomni/protocol";
import type { SessionRunnerResult } from "./session-contract";

/** A child terminal is a letter, never a second completion authority. */
export function parentReply(
	row: LedgerSession.Row,
	terminal: LedgerAction.Append,
	result: SessionRunnerResult,
): readonly Inbox.Commit[] {
	if (row.parentId === null || result.kind === "waiting") return [];
	const original = SessionHandleStore.inboxRows(row.id)
		.map((item) => Inbox.MessageOrigin.safeParse(item.origin.value))
		.find((origin) => origin.success && origin.data.senderSessionId === row.parentId);
	if (original === undefined || !original.success) return [];
	return [{
		id: `${terminal.id}:reply`,
		sessionId: row.parentId,
		kind: "prompt",
		content: result.text ?? "",
		parentActionId: null,
		createdAt: terminal.ts,
		origin: {
			encodingVersion: 1,
			value: {
				kind: "child_terminal",
				messageId: original.data.messageId,
				sourceActionId: original.data.sourceActionId,
				replyTo: original.data.replyTo ?? original.data.messageId,
				childSessionId: row.id,
				terminalKind: result.kind,
			},
		},
	}];
}
