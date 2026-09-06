import { AsyncLocalStorage } from "node:async_hooks";
import { Bus, createExecutor, type SessionRuntime } from "@openomni/agent";
import { SessionHandleStore } from "@openomni/ledger";
import type { GatewayRouter } from "@openomni/channels";
import { Inbox, type LedgerSession } from "@openomni/protocol";

type TerminalInput = Parameters<NonNullable<SessionRuntime["commitTerminal"]>>[0];
interface TerminalContext {
	readonly input: TerminalInput;
	readonly executor: ReturnType<typeof createExecutor>;
	result?: LedgerSession.CommitResult;
}

export const terminalMessage = new AsyncLocalStorage<TerminalContext>();

export function commitTerminalMessage(
	ingest: GatewayRouter["ingest"],
	clock: () => number,
): NonNullable<SessionRuntime["commitTerminal"]> {
	return async (input) => {
		const { commit, reply, policy } = input;
		const executor = createExecutor({
			identity: {
				sessionId: commit.sessionId,
				role: SessionHandleStore.row(commit.sessionId).role,
				parentActionId: commit.actions.at(-1)?.parentId ?? null,
			},
			policy, observations: Bus, clock, entropy: () => crypto.randomUUID(),
			ledger: {
				async commit(action) {
					const row = SessionHandleStore.row(commit.sessionId);
					const result = SessionHandleStore.commit({
						...commit, now: clock(), expectedRevision: row.revision,
						actions: [action], consumeInboxIds: [], state: row.state, releaseLease: false,
					});
					if (!result.ok) throw new Error(`terminal message action commit ${result.reason}`);
					const receipt = result.receipts[0];
					if (receipt === undefined) throw new Error("terminal message action receipt missing");
					return receipt;
				},
			},
		});
		const context: TerminalContext = { input, executor };
		return terminalMessage.run(context, async () => {
			try {
				const origin = Inbox.ReplyOrigin.parse(reply.origin.value);
				const admitted = await ingest({ kind: "session", id: commit.sessionId }, {
					to: { kind: "session", id: reply.sessionId }, type: "message",
					content: reply.content, replyTo: origin.replyTo,
				});
				if (admitted.status === "blocked_pre" || context.result === undefined) {
					throw new Error("terminal gateway admission refused");
				}
				return context.result;
			} finally {
				if (commit.releaseLease) {
					const row = SessionHandleStore.row(commit.sessionId);
					const released = SessionHandleStore.commit({
						...commit, now: clock(), expectedRevision: row.revision,
						actions: [], consumeInboxIds: [], state: row.state, releaseLease: true,
					});
					if (!released.ok) throw new Error(`terminal message lease release ${released.reason}`);
				}
			}
		});
	};
}
