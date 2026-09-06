import { SessionHandleStore } from "@openomni/ledger";
import { canonicalDigest } from "@openomni/protocol";
import type { createGatewayRouter } from "@openomni/channels";

type Request = Parameters<Parameters<typeof createGatewayRouter>[0]["run"]>[1];

export function messageDecisionRules(sessionId: string, request: Request): readonly string[] {
	const inputHash = canonicalDigest({
		kind: "message", phase: "pre", op: request.op,
		role: SessionHandleStore.row(sessionId).role, sessionId,
		message: request.message, value: request.intent,
	});
	for (const action of SessionHandleStore.tree(sessionId).reverse()) {
		const value = action.intent.value;
		if (action.kind !== "policy.decision" || value === null || typeof value !== "object"
			|| Array.isArray(value) || value.inputHash !== inputHash) continue;
		const ids = value.matchedRuleIds;
		if (!Array.isArray(ids)) throw new Error("message decision rule identities are missing");
		return ids.map((id) => {
			if (typeof id !== "string") throw new Error("invalid message decision rule identity");
			return id;
		});
	}
	throw new Error("message pre decision is missing");
}
