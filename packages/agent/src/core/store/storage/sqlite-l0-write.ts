import { z } from "zod";
import type { Database } from "bun:sqlite";
import { LedgerAction, type LedgerSession } from "@openomni/protocol";
import { computeActionHash, GENESIS_PREV_HASH } from "../action-hash.js";
import { SessionSqlRow, decodeSession } from "./sqlite-l0-rows";
import { CorruptRecord } from "../errors";
import type { RefuseWrite } from "./write-effect";

export const sessionSelect = `SELECT id, parent_id, role, lease_owner, lease_fence,
  revision, state, tools_generation, system_hash, policy_generation FROM session`;

export function insertSession(db: Database, row: LedgerSession.Row): boolean {
  const result = db
    .query(
      `INSERT INTO session (
         id, parent_id, role, lease_owner, lease_fence, revision, state,
         tools_generation, system_hash, policy_generation
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(
      row.id,
      row.parentId,
      row.role,
      row.fenceOwner,
      row.fence,
      row.revision,
      row.state,
      row.toolsGeneration,
      row.systemHash,
      row.policyGeneration,
    );
  return result.changes === 1;
}

function selectSessionSql(db: Database, id: string): SessionSqlRow | undefined {
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
  const head = db
    .query<{ action_hash: string }, [string]>(
      "SELECT action_hash FROM action WHERE session_id = ? ORDER BY ordinal DESC LIMIT 1",
    )
    .get(action.sessionId);
  const prevHash = head === null ? GENESIS_PREV_HASH : z.string().parse(head.action_hash);
  const stored = {
    prev_hash: prevHash,
    id: action.id,
    parent_id: action.parentId,
    session_id: action.sessionId,
    kind: action.kind,
    intent: JSON.stringify(action.intent.value),
    effect: JSON.stringify(action.effect.value),
    revert: revert === undefined ? null : JSON.stringify(revert.value),
    irreversible: "irreversible" in action ? (1 as const) : (0 as const),
    encoding_version: action.intent.encodingVersion,
    ts: action.ts,
    ordinal: revision,
  };
  const actionHash = computeActionHash(stored);
  db.query(
    `INSERT INTO action (
         id, parent_id, session_id, kind, intent, effect, revert, irreversible,
         encoding_version, ts, ordinal, prev_hash, action_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    stored.id,
    stored.parent_id,
    stored.session_id,
    stored.kind,
    stored.intent,
    stored.effect,
    stored.revert,
    stored.irreversible,
    stored.encoding_version,
    stored.ts,
    stored.ordinal,
    prevHash,
    actionHash,
  );
  const node = LedgerAction.Node.parse({ ...action, ordinal: revision, prevHash, actionHash });
  return { action: node, revision };
}

/**
 * Fenced chain commit (W5.2): authority is owner + fence equality against the
 * single session row plus the expected revision — the catalog fence CAS
 * already decided which activation may hold this owner+fence pair, so no
 * lease-expiry clock enters the predicate.
 */
export function commitSession(
  db: Database,
  request: LedgerSession.Commit,
  refuse: RefuseWrite,
): LedgerSession.CommitResult | undefined {
  const current = selectSession(db, request.sessionId);
  if (current === undefined) return undefined;
  const refusal = sessionAuthorityRefusal(db, request, current);
  if (refusal !== undefined) return refusal;
  if (!validActionBatch(db, request.actions, request.sessionId)) {
    return refusedSessionCommit("revision", current);
  }

  const receipts: LedgerAction.Receipt[] = [];
  let revision = current.revision;
  for (const action of request.actions) {
    const receipt = appendAction(db, action, revision);
    if (receipt === undefined) return refusedSessionCommit("revision", current);
    receipts.push(receipt);
    revision = receipt.revision;
  }
  const generation = request.generation ?? current;
  const updated = db
    .query(
      `UPDATE session SET state = ?, tools_generation = ?, system_hash = ?,
         policy_generation = ?
       WHERE id = ? AND lease_owner = ? AND lease_fence = ? AND revision = ?
         AND role IS NOT NULL`,
    )
    .run(
      request.state,
      generation.toolsGeneration,
      generation.systemHash,
      generation.policyGeneration,
      request.sessionId,
      request.owner,
      request.fence,
      revision,
    );
  if (updated.changes !== 1) return refusedSessionCommit("stale", current);
  const row = selectSession(db, request.sessionId);
  if (row === undefined)
    return refuse(new CorruptRecord({ operation: "session.commit", id: request.sessionId }));
  return { ok: true, row, receipts };
}

function sessionAuthorityRefusal(
  db: Database,
  request: LedgerSession.Commit,
  current: LedgerSession.Row,
): LedgerSession.CommitResult | undefined {
  if (current.fenceOwner !== request.owner || current.fence !== request.fence) {
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

function refusedSessionCommit(
  reason: "stale" | "revision",
  current: LedgerSession.Row,
): LedgerSession.CommitResult {
  return {
    ok: false,
    reason,
    currentFence: current.fence,
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

function pendingRequestCount(db: Database, since: number): number {
  const row = z.object({ count: z.number() }).parse(
    db
      .query(`
    SELECT COUNT(*) AS count FROM (
      SELECT effect, ROW_NUMBER() OVER (
        PARTITION BY json_extract(effect, '$.request.requestId') ORDER BY ordinal DESC
      ) AS latest
      FROM action
      WHERE kind = 'request'
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
