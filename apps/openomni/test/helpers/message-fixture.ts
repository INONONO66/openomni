import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Bus, createDispatcher, createExecutor, eraseTool,
} from "@openomni/agent";
import { initialize, SessionHandleStore } from "@openomni/ledger";
import { compilePolicySnapshot } from "@openomni/policy";
import { type Gateway, LedgerAction, type LedgerSession } from "@openomni/protocol";
import { createResidentGateway, type OutboundMessaging } from "../../src/gateway";
import { commitMessageInbox, messageMaterialization, prepareMessage } from "../../src/composition/message-session";
import { seedKernelPolicyRows } from "../../src/policy-seed";
import { createSendMessageTool } from "../../src/tools/authority/send-message";

export function messageFixture(role: LedgerSession.Role = "resident", messaging?: OutboundMessaging) {
	const directory = mkdtempSync(join(tmpdir(), "message-policy-"));
	const dbPath = join(directory, "test.sqlite");
	initialize({ dbPath, observationSink: Bus });
	const generation = seedKernelPolicyRows();
	const sessionId = "sender";
	SessionHandleStore.materialize({
		id: sessionId, parentId: null, role, tools: [], system: { preset: "", blocks: [] },
		policyGeneration: generation, actionId: "configure", at: 1,
	});
	const lease = SessionHandleStore.acquireLease({
		sessionId, owner: "test", expectedFence: 0, now: 100, expiresAt: 100_000,
	});
	if (!lease.ok) throw new Error("fixture lease refused");
	const executor = createExecutor({
		identity: { sessionId, role, parentActionId: null },
		policy: compilePolicySnapshot({ generation, rows: SessionHandleStore.policyRows(generation), kinds: LedgerAction.Kind.options }),
		ledger: {
			async commit(action) {
				const receipt = SessionHandleStore.commit({
					sessionId, owner: "test", fence: lease.fence, now: 100,
					expectedRevision: SessionHandleStore.row(sessionId).revision, actions: [action],
					consumeInboxIds: [], state: "running", releaseLease: false,
				});
				if (!receipt.ok || receipt.receipts[0] === undefined) throw new Error("fixture commit refused");
				return receipt.receipts[0];
			}
		},
		observations: Bus, clock: () => 100, entropy: () => crypto.randomUUID(),
	});
	const gateway = createResidentGateway({
		clock: () => 100,
		inbox: { commit: commitMessageInbox },
		prepare: prepareMessage((id, parentId, childRole, runner) => messageMaterialization({
			id, parentId, role: childRole, runner, tools: [], preset: "", at: 100,
		})),
		armDeadline: SessionHandleStore.armMessageDeadline,
	}, messaging);
	const dispatcher = createDispatcher([eraseTool(createSendMessageTool(gateway))], { executor });
	return {
		directory, dbPath, gateway, sessionId,
		send: (input: Gateway.SendMessage) => dispatcher.execute({
			id: crypto.randomUUID(), tool: "sendMessage", input,
		}, { sessionId, turnId: "test-turn" }),
	};
}
