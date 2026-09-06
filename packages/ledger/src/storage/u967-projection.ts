import { Wait } from "@openomni/protocol";
import type { Database } from "bun:sqlite";
import { z } from "zod";

// Offline projection boundary only, reusing the surviving field schemas.
// No runtime store reads historical owners through this boundary.
const HistoricalProjection = z.strictObject({
	...Wait.Record.shape,
	ownerRef: z.strictObject({ kind: z.enum(["session", "workItem"]), id: z.string().min(1) }),
});

export const DispositionCandidates = z.array(z.strictObject({
	id: z.string(), revision: z.number().int().nonnegative(), status: Wait.Status,
}));
export type DispositionCandidates = z.infer<typeof DispositionCandidates>;

const projections = [
	["id", "id"], ["owner_kind", "ownerRef.kind"], ["owner_id", "ownerRef.id"],
	["origin_message_id", "originMessageId"], ["revision", "revision"], ["status", "status"],
	["partial", "partial"], ["endpoint_id", "correlation.endpointId"],
	["channel_id", "correlation.channelId"], ["reply_to_message_id", "correlation.replyToMessageId"],
	["thread_id", "correlation.threadId"], ["token_hash", "correlation.tokenHash"],
	["external_conversation_id", "correlation.externalConversationId"], ["expires_at", "expiresAt"],
	["time_created", "createdAt"], ["time_updated", "updatedAt"],
] as const;

function validJson(db: Database, table: "wait"): boolean {
	using invalid = db.prepare<{ invalid: number }, []>(`SELECT 1 AS invalid FROM ${table} WHERE NOT json_valid(data) LIMIT 1`);
	if (invalid.get()) return false;
	using duplicates = db.prepare<{ duplicate: number }, []>(`SELECT 1 AS duplicate FROM ${table}, json_tree(${table}.data) AS tree
    WHERE tree.key IS NOT NULL GROUP BY ${table}.rowid, tree.parent, tree.key
    HAVING count(*) > 1 LIMIT 1`);
	return duplicates.get() === null;
}

function coherentWaits(db: Database): boolean {
	const mismatch = projections.map(([column, field]) => `${column} IS NOT json_extract(data, '$.${field}')`);
	mismatch.push("follow_up_until IS NOT (json_extract(data, '$.resolvedAt') + json_extract(data, '$.followUpWindow'))");
	using statement = db.prepare<{ mismatch: number }, []>(`SELECT 1 AS mismatch FROM wait WHERE ${mismatch.join(" OR ")} LIMIT 1`);
	return statement.get() === null;
}

function terminalComplete(record: z.infer<typeof HistoricalProjection>): boolean {
	const times = [record.createdAt, record.updatedAt, record.expiresAt, record.followUpWindow,
	record.resolvedAt ?? 0, record.cancelledAt ?? 0, ...record.replies.map((reply) => reply.receivedAt)];
	if (times.some((time) => time > Number.MAX_SAFE_INTEGER) || record.updatedAt < record.createdAt) return false;
	if (new Set(record.expectedResponders).size !== record.expectedResponders.length
		|| new Set(record.allowedActions).size !== record.allowedActions.length) return false;
	if (record.resolutionPolicy === "quorum") {
		if (record.quorum === undefined || record.quorum.expected !== record.expectedResponders.length) return false;
	} else if (record.quorum !== undefined) return false;
	if (new Set(record.replies.map((reply) => reply.replyKey)).size !== record.replies.length) return false;
	if (record.replies.some((reply) => !record.expectedResponders.includes(reply.responderId)
		|| reply.receivedAt < record.createdAt || reply.receivedAt > record.updatedAt
		|| (record.resolvedAt === undefined ? reply.receivedAt >= record.expiresAt
			: reply.receivedAt > record.resolvedAt + record.followUpWindow)
		|| (record.cancelledAt !== undefined && reply.receivedAt > record.cancelledAt))) return false;
	const responders = new Set(record.replies.map((reply) => reply.responderId)).size;
	const resolvedAt = record.resolvedAt;
	const resolvedResponders = resolvedAt === undefined ? responders
		: new Set(record.replies.filter((reply) => reply.receivedAt <= resolvedAt).map((reply) => reply.responderId)).size;
	const threshold = record.resolutionPolicy === "all" ? record.expectedResponders.length : record.quorum?.threshold ?? 1;
	switch (record.status) {
		case "open": return record.resolvedAt === undefined && record.cancelledAt === undefined && !record.partial;
		case "cancelled": return record.revision > 0 && !record.partial && record.resolvedAt === undefined && record.cancelledAt !== undefined
			&& record.cancelledAt >= record.createdAt && record.cancelledAt <= record.updatedAt;
		case "expired": return record.revision > 0 && record.resolvedAt === undefined && record.cancelledAt === undefined
			&& record.updatedAt >= record.expiresAt && record.partial === (record.replies.length > 0);
		case "resolved": return record.revision > 0 && record.resolvedAt !== undefined && record.cancelledAt === undefined
			&& record.resolvedAt >= record.createdAt && record.resolvedAt <= record.updatedAt
			&& record.resolvedAt + record.followUpWindow <= Number.MAX_SAFE_INTEGER && resolvedResponders >= threshold && !record.partial;
	}
}

export function inspect967Projections(db: Database, now: number) {
	const candidates: DispositionCandidates = [];
	const blocked: string[] = [];
	if (!validJson(db, "wait") || !coherentWaits(db)) {
		return { candidates, blocked: ["invalid_rows"] };
	}
	// Offline archives may predate the message cutover. Do not reinterpret a
	// retired lifecycle: any retained row requires its own approved disposition.
	using historical = db.prepare<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'delegation'");
	if (historical.get() !== null) {
		using retained = db.prepare<{ present: number | bigint }, []>("SELECT 1 AS present FROM delegation LIMIT 1");
		if (retained.get() !== null) return { candidates, blocked: ["protected_rows"] };
	}
	using waits = db.prepare<{ data: string }, []>("SELECT data FROM wait ORDER BY id");
	for (const row of waits.all()) {
		const parsed = HistoricalProjection.safeParse(JSON.parse(row.data));
		if (!parsed.success || !terminalComplete(parsed.data)) {
			blocked.push("invalid_rows");
			continue;
		}
		const record = parsed.data;
		if (record.ownerRef.kind === "session") {
			if (!Wait.Record.safeParse(record).success) blocked.push("invalid_rows");
			continue;
		}
		if (record.status === "open"
			|| (record.resolvedAt !== undefined && now <= record.resolvedAt + record.followUpWindow)) {
			blocked.push(`protected_rows:${record.id}`);
		} else {
			candidates.push({ id: record.id, revision: record.revision, status: record.status });
		}
	}
	return { candidates, blocked };
}
