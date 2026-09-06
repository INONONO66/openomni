import { SessionHandleStore } from "@openomni/ledger";
import { Inbox, Gateway, type LedgerSession, type SessionGeneration } from "@openomni/protocol";
import type { createGatewayRouter } from "@openomni/channels";
import { terminalMessage } from "./terminal-message";

type Ports = Parameters<typeof createGatewayRouter>[0];

export function commitMessageInbox(input: Inbox.Commit): Inbox.Row {
	const terminal = terminalMessage.getStore();
	if (terminal === undefined) return SessionHandleStore.commitInbox(input);
	const { commit, reply } = terminal.input;
	if (input.id !== reply.id || input.sessionId !== reply.sessionId) {
		throw new Error("terminal inbox binding mismatch");
	}
	const result = SessionHandleStore.commit({
		...commit, expectedRevision: SessionHandleStore.row(commit.sessionId).revision,
		deliveries: [{
			id: input.id, sessionId: input.sessionId, kind: input.kind,
			content: input.content, origin: input.origin, createdAt: input.createdAt,
			parentActionId: input.parentActionId,
		}], releaseLease: false,
	});
	if (!result.ok) throw new Error(`terminal inbox commit ${result.reason}`);
	terminal.result = result;
	const row = SessionHandleStore.inboxRows(reply.sessionId).find((item) => item.id === input.id);
	if (row === undefined) throw new Error("terminal inbox receipt missing");
	return row;
}

export function messageMaterialization(input: {
	readonly id: string;
	readonly parentId: string | null;
	readonly role: LedgerSession.Role;
	readonly tools: readonly SessionGeneration.Tool[];
	readonly preset: string;
	readonly runner: string;
	readonly at: number;
}): LedgerSession.Materialize {
	const snapshot = SessionHandleStore.generationSnapshot({
		generation: 1, revertTo: 0, tools: input.tools,
		system: { preset: input.preset, blocks: [{ id: "runner", source: "app:runner", content: input.runner }] },
		policyGeneration: SessionHandleStore.currentPolicyGeneration(),
	});
	return {
		row: {
			id: input.id, parentId: input.parentId, role: input.role,
			leaseOwner: null, leaseFence: 0, leaseExpiresAt: null,
			revision: 0, state: "idle", toolsGeneration: snapshot.generation,
			systemHash: snapshot.systemHash, policyGeneration: snapshot.policyGeneration,
		},
		initialAction: SessionHandleStore.configureAction({
			id: crypto.randomUUID(), sessionId: input.id, parentId: null,
			operation: "create", snapshot, at: input.at,
		}),
	};
}

export function prepareMessage(
	materialize: (id: string, parentId: string | null, role: LedgerSession.Role, runner: string) => LedgerSession.Materialize,
): Ports["prepare"] {
	return (sender, send, target, messageId) => {
		if (sender.kind === "external") {
			const exists = SessionHandleStore.listRows().some((row) => row.id === target);
			const source = exists && send.replyTo !== undefined ? SessionHandleStore.tree(target).find((action) => {
				const intent = action.intent.value;
				if (action.kind !== "message" || intent === null || typeof intent !== "object" || Array.isArray(intent)) return false;
				const value = intent.value;
				return value !== null && typeof value === "object" && !Array.isArray(value) && value.messageId === send.replyTo;
			}) : undefined;
			return {
				target,
				...(source === undefined || send.replyTo === undefined ? {} : {
					origin: Inbox.ReplyOrigin.parse({
						kind: "external_reply", messageId: send.replyTo, sourceActionId: source.id, replyTo: send.replyTo,
					})
				}),
				...(!exists ? { createSession: materialize(target, null, "resident", "resident") } : {}),
				message: {
					sender: "external", addressee: "bot", identity: true, grantTier: true,
					egressBudget: true,
					eventIdUnique: !exists || !SessionHandleStore.inboxRows(target).some((row) => row.id === messageId),
					replyCorrelation: true,
				},
			};
		}
		const source = SessionHandleStore.row(sender.id);
		if (source.leaseOwner === null) throw new Error("session sender has no active lease");
		const rows = SessionHandleStore.listRows();
		const recipient = send.to.kind === "session" ? SessionHandleStore.row(target) : undefined;
		const origins = SessionHandleStore.inboxRows(source.id).flatMap((row) => {
			const parsed = Inbox.MessageOrigin.safeParse(row.origin.value);
			return parsed.success ? [parsed.data] : [];
		});
		const parentDeadline = origins.at(-1)?.deadline;
		const terminal = terminalMessage.getStore();
		const bounds = SessionHandleStore.policyRows(source.policyGeneration).flatMap((row) => {
			const match = row.match.value;
			if (row.kind !== "message" || row.phase !== "pre" || match === null || typeof match !== "object" || Array.isArray(match)) return [];
			const parsed = Gateway.RuleTableB.safeParse(match.message);
			if (!parsed.success) return [];
			const rule = parsed.data;
			return rule.senderRole === source.role && rule.effect === "deny"
				&& (rule.targetKind === undefined || rule.targetKind === send.to.kind)
				&& (rule.type === undefined || rule.type === send.type)
				&& (rule.targetRole === undefined || (send.to.kind === "new_session" && rule.targetRole === send.to.role))
				? [rule.check] : [];
		});
		const fanout = bounds.flatMap((check) => check.kind === "fanout" ? [check.max] : []);
		const depths = bounds.flatMap((check) => check.kind === "depth" ? [check.max] : []);
		if (send.to.kind === "new_session" && (fanout.length === 0 || depths.length === 0)) throw new Error("child admission bounds missing from pinned policy");
		let depth = 1;
		let parent = source.parentId;
		while (parent !== null) {
			depth += 1;
			parent = rows.find((row) => row.id === parent)?.parentId ?? null;
		}
		return {
			target,
			...(terminal === undefined ? {} : {
				messageId: terminal.input.reply.id,
				origin: Inbox.ReplyOrigin.parse(terminal.input.reply.origin.value),
			}),
			sender: { sessionId: sender.id, owner: source.leaseOwner, fence: source.leaseFence },
			...(send.to.kind === "new_session"
				? {
					createSession: materialize(target, sender.id, send.to.role, send.to.runner),
					limits: { fanout: Math.min(...fanout), depth: Math.min(...depths) },
				} : {}),
			message: {
				sender: "session", senderRole: source.role, targetKind: send.to.kind,
				...(recipient === undefined
					? send.to.kind === "new_session" ? { targetRole: send.to.role } : {}
					: { targetRole: recipient.role }),
				type: send.type,
				parentChild: recipient === undefined || recipient.id === source.id
					|| recipient.parentId === source.id || source.parentId === recipient.id,
				fanout: SessionHandleStore.openChildCount(source.id),
				depth,
				withinParentDeadline: parentDeadline === undefined
					|| (send.deadline !== undefined && send.deadline <= parentDeadline),
			},
		};
	};
}
