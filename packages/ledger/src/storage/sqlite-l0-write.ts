import { z } from "zod";
import type { Database } from "bun:sqlite";
import {
  Deadline,
  Inbox,
  LedgerAction,
  type LedgerSession,
  SessionTransition,
} from "@openomni/protocol";
import { inboxAppend } from "./l0-action-builders.js";
import { SessionSqlRow, decodeSession } from "./sqlite-l0-rows";

export const sessionSelect = `SELECT id, parent_id, role, lease_owner, lease_fence,
  lease_expires_at, revision, state, tools_generation, system_hash, policy_generation FROM session`;

export function insertSession(db: Database, row: LedgerSession.Row): boolean {
  const result = db
    .query(
      `INSERT INTO session (
         id, data, time_created, time_updated, parent_id, role, lease_owner,
         lease_fence, lease_expires_at, revision, state, tools_generation,
         system_hash, policy_generation
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(
      row.id,
      JSON.stringify(l0SessionInfo(row)),
      0,
      0,
      row.parentId,
      row.role,
      row.leaseOwner,
      row.leaseFence,
      row.leaseExpiresAt,
      row.revision,
      row.state,
      row.toolsGeneration,
      row.systemHash,
      row.policyGeneration,
    );
  return result.changes === 1;
}

export function selectSessionSql(db: Database, id: string): SessionSqlRow | undefined {
  const row = SessionSqlRow.nullable().parse(db.query(`${sessionSelect} WHERE id = ?`).get(id));
  return row === null ? undefined : row;
}

export function selectSession(db: Database, id: string): LedgerSession.Row | undefined {
  const row = selectSessionSql(db, id);
  return row === undefined ? undefined : decodeSession(row);
}

export function appendAction(
  db: Database,
  action: LedgerAction.Append,
  expectedRevision: number,
): LedgerAction.Receipt | undefined {
  if (actionExists(db, action.id)) return undefined;
  if (!parentBelongsToSession(db, action.parentId, action.sessionId)) return undefined;
  const revision = expectedRevision + 1;
  const updated = db
    .query(
      `UPDATE session SET revision = ?
       WHERE id = ? AND revision = ? AND role IS NOT NULL`,
    )
    .run(revision, action.sessionId, expectedRevision);
  if (updated.changes !== 1) return undefined;
  const revert = "revert" in action ? action.revert : undefined;
  db.query(
    `INSERT INTO action (
         id, parent_id, session_id, kind, intent, effect, revert, irreversible,
         encoding_version, ts, ordinal
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    action.id,
    action.parentId,
    action.sessionId,
    action.kind,
    JSON.stringify(action.intent.value),
    JSON.stringify(action.effect.value),
    revert === undefined ? null : JSON.stringify(revert.value),
    "irreversible" in action ? 1 : 0,
    action.intent.encodingVersion,
    action.ts,
    revision,
  );
  projectRequestDeadline(db, action);
  const node = LedgerAction.Node.parse({ ...action, ordinal: revision });
  return { action: node, revision };
}

function projectRequestDeadline(db: Database, action: LedgerAction.Append): void {
  if (action.kind !== "request" && action.kind !== "reply") return;
  const effect = action.effect.value;
  if (
    effect === null ||
    typeof effect !== "object" ||
    Array.isArray(effect) ||
    effect.phase !== "state"
  )
    return;
  const request = SessionTransition.Request.parse(effect.request);
  const status =
    request.state === "open" ? "armed" : request.state === "expired" ? "fired" : "cancelled";
  db.query(`INSERT INTO alarm (id, session_id, kind, fire_at, spec, encoding_version, status, time_created, time_updated)
    VALUES (?, ?, 'at', ?, ?, 1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status = excluded.status, time_updated = excluded.time_updated`).run(
    `${request.requestId}:deadline`,
    request.sessionId,
    request.deadline,
    JSON.stringify({ kind: "request_deadline", requestId: request.requestId }),
    status,
    request.createdAt,
    action.ts,
  );
}

export class SessionCommitRefused extends Error {
  constructor(readonly result: LedgerSession.CommitResult) {
    super("session commit refused");
    this.name = "SessionCommitRefused";
  }
}

export function commitSession(
  db: Database,
  request: LedgerSession.Commit,
): LedgerSession.CommitResult | undefined {
  const current = selectSession(db, request.sessionId);
  if (current === undefined) return undefined;
  const refusal = sessionAuthorityRefusal(db, request, current);
  if (refusal !== undefined) return refusal;
  if (!validActionBatch(db, request.actions, request.sessionId)) {
    return refusedSessionCommit("revision", current);
  }
  if (!validSessionInboxOwnership(request)) {
    return refusedSessionCommit("inbox", current);
  }
  if (!canConsumeInbox(db, request)) {
    return refusedSessionCommit("inbox", current);
  }

  const receipts: LedgerAction.Receipt[] = [];
  let revision = current.revision;
  for (const action of request.actions) {
    const receipt = appendAction(db, action, revision);
    if (receipt === undefined) {
      throw new SessionCommitRefused(refusedSessionCommit("revision", current));
    }
    receipts.push(receipt);
    revision = receipt.revision;
  }
  for (const id of request.consumeInboxIds) {
    const consumed = db
      .query(
        `UPDATE inbox SET status = 'consumed', consumed_by = ?, consumed_at = ?
         WHERE id = ? AND session_id = ? AND status = 'pending'`,
      )
      .run(request.owner, request.now, id, request.sessionId);
    if (consumed.changes !== 1) {
      throw new SessionCommitRefused(refusedSessionCommit("inbox", current));
    }
  }

  if (request.receive !== undefined) {
    const received = commitInbox(db, request.receive);
    if (received === undefined)
      throw new SessionCommitRefused(refusedSessionCommit("inbox", current));
    receipts.push(...received.receipts);
    revision = received.receipts.at(-1)?.revision ?? revision;
  }
  if (request.admit !== undefined) {
    const admitted = commitInbox(db, request.admit);
    if (admitted === undefined)
      throw new SessionCommitRefused(refusedSessionCommit("inbox", current));
    receipts.push(...admitted.receipts);
  }
  const generation = request.generation ?? current;
  const updated = db
    .query(
      `UPDATE session SET state = ?, tools_generation = ?, system_hash = ?,
         policy_generation = ?, lease_owner = ?, lease_expires_at = ?
       WHERE id = ? AND lease_owner = ? AND lease_fence = ? AND revision = ?
         AND lease_expires_at > ? AND role IS NOT NULL`,
    )
    .run(
      request.state,
      generation.toolsGeneration,
      generation.systemHash,
      generation.policyGeneration,
      request.releaseLease ? null : request.owner,
      request.releaseLease ? null : current.leaseExpiresAt,
      request.sessionId,
      request.owner,
      request.fence,
      revision,
      request.now,
    );
  if (updated.changes !== 1) {
    throw new SessionCommitRefused(refusedSessionCommit("stale", current));
  }
  const row = selectSession(db, request.sessionId);
  if (row === undefined) throw new Error("committed session disappeared");
  return { ok: true, row, receipts };
}

function sessionAuthorityRefusal(
  db: Database,
  request: LedgerSession.Commit,
  current: LedgerSession.Row,
): LedgerSession.CommitResult | undefined {
  if (
    current.leaseOwner !== request.owner ||
    current.leaseFence !== request.fence ||
    current.leaseExpiresAt === null ||
    Deadline.isExpired(request.now, current.leaseExpiresAt)
  ) {
    return refusedSessionCommit("stale", current);
  }
  if (current.revision !== request.expectedRevision) {
    return refusedSessionCommit("revision", current);
  }
  if (
    request.requestCount !== undefined &&
    pendingRequestCount(db, request.requestCount.since) !== request.requestCount.count
  ) {
    return refusedSessionCommit("revision", current);
  }
  return undefined;
}

function validSessionInboxOwnership(request: LedgerSession.Commit): boolean {
  if (request.receive !== undefined && request.receive.sessionId !== request.sessionId) {
    return false;
  }
  if (
    request.admit !== undefined &&
    (request.admit.createSession?.row.parentId !== request.sessionId ||
      request.admit.sender?.sessionId !== request.sessionId ||
      request.admit.sender.owner !== request.owner ||
      request.admit.sender.fence !== request.fence)
  )
    return false;
  return true;
}

function validActionBatch(
  db: Database,
  actions: readonly LedgerAction.Append[],
  sessionId: string,
): boolean {
  const ids = new Set<string>();
  for (const action of actions) {
    if (action.sessionId !== sessionId || ids.has(action.id) || actionExists(db, action.id)) {
      return false;
    }
    if (
      action.parentId !== null &&
      !ids.has(action.parentId) &&
      !parentBelongsToSession(db, action.parentId, sessionId)
    ) {
      return false;
    }
    ids.add(action.id);
  }
  return true;
}

function canConsumeInbox(db: Database, request: LedgerSession.Commit): boolean {
  if (new Set(request.consumeInboxIds).size !== request.consumeInboxIds.length) return false;
  for (const id of request.consumeInboxIds) {
    const row = z
      .object({ session_id: z.string(), status: z.string() })
      .nullable()
      .parse(db.query("SELECT session_id, status FROM inbox WHERE id = ?").get(id));
    if (row?.session_id !== request.sessionId || row.status !== "pending") return false;
  }
  return true;
}

function refusedSessionCommit(
  reason: "stale" | "revision" | "inbox",
  current: LedgerSession.Row,
): LedgerSession.CommitResult {
  return {
    ok: false,
    reason,
    currentFence: current.leaseFence,
    currentRevision: current.revision,
  };
}

function actionExists(db: Database, id: string): boolean {
  return db.query("SELECT 1 FROM action WHERE id = ?").get(id) !== null;
}

function parentBelongsToSession(db: Database, parentId: string | null, sessionId: string): boolean {
  if (parentId === null) return true;
  const row = z
    .object({ session_id: z.string() })
    .nullable()
    .parse(db.query("SELECT session_id FROM action WHERE id = ?").get(parentId));
  return row?.session_id === sessionId;
}

export function openChildCount(db: Database, parentId: string): number {
  const row = db
    .query<{ n: number | bigint }, [string]>(`
		SELECT COUNT(*) AS n FROM session child WHERE child.parent_id = ? AND (
			EXISTS (SELECT 1 FROM inbox i WHERE i.session_id = child.id AND i.status = 'pending')
			OR EXISTS (SELECT 1 FROM action intent WHERE intent.session_id = child.id AND intent.kind = 'turn'
				AND json_extract(intent.intent, '$.phase') = 'intent'
				AND NOT EXISTS (SELECT 1 FROM action result WHERE result.id = json_extract(intent.intent, '$.resultId')))
			OR COALESCE((SELECT json_extract(a.effect, '$.kind') FROM action a
				WHERE a.session_id = child.id AND a.kind = 'turn' AND json_extract(a.effect, '$.phase') = 'terminal'
				ORDER BY a.ordinal DESC LIMIT 1), 'open') NOT IN ('result', 'interrupted', 'error')
		)`)
    .get(parentId);
  return Number(row?.n ?? 0);
}

interface InboxCommitResult {
  readonly committed: Inbox.Row;
  readonly receipts: LedgerAction.Receipt[];
}

export function commitInbox(db: Database, row: Inbox.Commit): InboxCommitResult | undefined {
  if (actionExists(db, row.id)) return undefined;
  if (!validInboxSender(db, row)) return undefined;
  const receipts: LedgerAction.Receipt[] = [];
  const child = row.createSession;
  if (child !== undefined) {
    if (!validInboxChild(db, row, child)) return undefined;
    if (!withinChildLimits(db, child.row.parentId, row.limits)) return undefined;
    if (!insertSession(db, child.row)) return undefined;
    const configured = appendAction(db, child.initialAction, 0);
    if (configured === undefined) throw new Error("child configuration refused");
    receipts.push(configured);
  }
  const session = z
    .object({ revision: z.number() })
    .nullable()
    .parse(db.query("SELECT revision FROM session WHERE id = ?").get(row.sessionId));
  if (session === null) return undefined;
  const receipt = appendAction(db, inboxAppend(row), session.revision);
  if (receipt === undefined) {
    if (receipts.length > 0) throw new Error("message inbox commit refused");
    return undefined;
  }
  const ordinalRow = z
    .object({ ordinal: z.number() })
    .parse(
      db
        .query("SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM inbox WHERE session_id = ?")
        .get(row.sessionId),
    );
  const committed = Inbox.Row.parse({
    id: row.id,
    sessionId: row.sessionId,
    kind: row.kind,
    content: row.content,
    origin: row.origin,
    status: "pending",
    consumedBy: null,
    consumedAt: null,
    createdAt: row.createdAt,
    ordinal: ordinalRow.ordinal,
  });
  db.query(
    `INSERT INTO inbox (
             id, session_id, kind, content, origin, encoding_version, status,
             consumed_by, consumed_at, time_created, ordinal
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    committed.id,
    committed.sessionId,
    committed.kind,
    committed.content,
    JSON.stringify(committed.origin.value),
    committed.origin.encodingVersion,
    committed.status,
    committed.consumedBy,
    committed.consumedAt,
    committed.createdAt,
    committed.ordinal,
  );
  receipts.push(receipt);
  return { committed, receipts };
}

function validInboxSender(db: Database, row: Inbox.Commit): boolean {
  if (row.sender === undefined) return true;
  const sender = selectSession(db, row.sender.sessionId);
  return (
    sender !== undefined &&
    sender.leaseOwner === row.sender.owner &&
    sender.leaseFence === row.sender.fence &&
    sender.leaseExpiresAt !== null &&
    !Deadline.isExpired(row.createdAt, sender.leaseExpiresAt)
  );
}

function validInboxChild(
  db: Database,
  row: Inbox.Commit,
  child: LedgerSession.Materialize,
): boolean {
  if (
    (child.row.parentId !== null && child.row.parentId !== row.sender?.sessionId) ||
    child.row.id !== row.sessionId ||
    child.row.revision !== 0 ||
    child.initialAction.sessionId !== row.sessionId ||
    child.initialAction.parentId !== null ||
    child.initialAction.kind !== "session.configure" ||
    row.parentActionId !== null ||
    actionExists(db, child.initialAction.id) ||
    child.initialAction.id === row.id
  )
    return false;
  return true;
}

function withinChildLimits(
  db: Database,
  parentId: string | null,
  limits: Inbox.Commit["limits"],
): boolean {
  if (parentId === null) return true;
  if (limits === undefined || openChildCount(db, parentId) >= limits.fanout) return false;
  let depth = 1;
  let ancestor = selectSession(db, parentId);
  while (ancestor?.parentId !== null) {
    if (ancestor === undefined) throw new Error("session ancestry is missing");
    depth += 1;
    ancestor = selectSession(db, ancestor.parentId);
  }
  return depth <= limits.depth;
}

function pendingRequestCount(db: Database, since: number): number {
  const row = z.object({ count: z.number() }).parse(
    db
      .query(`
    SELECT COUNT(*) AS count FROM (
      SELECT effect, ROW_NUMBER() OVER (
        PARTITION BY json_extract(effect, '$.request.requestId') ORDER BY ordinal DESC
      ) AS latest
      FROM action
      WHERE kind IN ('request', 'reply') AND json_extract(effect, '$.phase') = 'state'
    )
    WHERE latest = 1
      AND json_extract(effect, '$.request.state') = 'open'
      AND json_extract(effect, '$.request.mode') = 'approval'
      AND json_extract(effect, '$.request.createdAt') > ?
  `)
      .get(since),
  );
  return row.count;
}

export function insertInbox(db: Database, row: Inbox.Commit): Inbox.Row {
  const ordinal = db
    .query<{ ordinal: number }, [string]>(
      "SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM inbox WHERE session_id = ?",
    )
    .get(row.sessionId);
  if (ordinal === null) throw new Error("inbox ordinal unavailable");
  const committed = Inbox.Row.parse({
    id: row.id,
    sessionId: row.sessionId,
    kind: row.kind,
    content: row.content,
    origin: row.origin,
    createdAt: row.createdAt,
    status: "pending",
    consumedBy: null,
    consumedAt: null,
    ordinal: ordinal.ordinal,
  });
  db.query(`INSERT INTO inbox (id, session_id, kind, content, origin, encoding_version, status, consumed_by, consumed_at, time_created, ordinal)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)`).run(
    row.id,
    row.sessionId,
    row.kind,
    row.content,
    JSON.stringify(row.origin.value),
    row.origin.encodingVersion,
    row.createdAt,
    committed.ordinal,
  );
  return committed;
}

function l0SessionInfo(row: LedgerSession.Row) {
  return {
    id: row.id,
    title: row.id,
    model: { providerID: "l0", modelID: "l0" },
    time: { created: 0, updated: 0 },
    spawnDepth: row.parentId === null ? 0 : 1,
    agent: { id: row.role },
    ...(row.parentId === null ? {} : { parentSessionId: row.parentId }),
  };
}
