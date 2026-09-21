import type { Database } from "bun:sqlite";
import { Deadline, LedgerSession, type ObservationSink } from "@openomni/protocol";
import {
  CommitRefused,
  CorruptRecord,
  LeaseRefused,
  MaterializeRefused,
  SessionNotFound,
} from "../errors";
import type { SessionWriteAdapter } from "../services";
import { type SessionSqlRow, decodeSession } from "./sqlite-l0-rows.js";
import {
  sessionSelect,
  insertSession,
  selectSessionSql,
  selectSession,
  appendAction,
  commitSession,
  openChildCount,
} from "./sqlite-l0-write.js";
import { publishCommitted } from "./sqlite-l0-observation.js";
import { writeEffect, type RefuseWrite } from "./write-effect";

function materializeSession(
  db: Database,
  parsed: LedgerSession.Materialize,
  refuse: RefuseWrite,
): LedgerSession.MaterializeResult {
  if (
    parsed.initialAction.sessionId !== parsed.row.id ||
    parsed.initialAction.kind !== "session.configure" ||
    parsed.initialAction.parentId !== null ||
    parsed.row.revision !== 0
  )
    return refuse(new MaterializeRefused({ sessionId: parsed.row.id, reason: "input" }));
  if (!insertSession(db, parsed.row)) {
    const existing = selectSessionSql(db, parsed.row.id);
    if (existing === undefined)
      return refuse(new MaterializeRefused({ sessionId: parsed.row.id, reason: "state" }));
    if (existing.role !== null) return { created: false, row: decodeSession(existing) };
    const promoted = db
      .query(
        `UPDATE session SET parent_id = ?, role = ?, lease_owner = ?, lease_fence = ?,
         lease_expires_at = ?, state = ?, tools_generation = ?, system_hash = ?,
         policy_generation = ?
       WHERE id = ? AND role IS NULL AND revision = 0`,
      )
      .run(
        parsed.row.parentId,
        parsed.row.role,
        parsed.row.leaseOwner,
        parsed.row.leaseFence,
        parsed.row.leaseExpiresAt,
        parsed.row.state,
        parsed.row.toolsGeneration,
        parsed.row.systemHash,
        parsed.row.policyGeneration,
        parsed.row.id,
      );
    if (promoted.changes !== 1)
      return refuse(new MaterializeRefused({ sessionId: parsed.row.id, reason: "state" }));
  }
  const receipt = appendAction(db, parsed.initialAction, 0);
  if (receipt === undefined)
    return refuse(new MaterializeRefused({ sessionId: parsed.row.id, reason: "configuration" }));
  const row = selectSession(db, parsed.row.id);
  if (row === undefined)
    return refuse(new CorruptRecord({ operation: "materialize", id: parsed.row.id }));
  return { created: true, row, receipt };
}

function leaseRefusal(current: LedgerSession.Row, reason: "held" | "stale"): LeaseRefused {
  return new LeaseRefused({
    sessionId: current.id,
    reason,
    holder: current.leaseOwner,
    fence: current.leaseFence,
    expiresAt: current.leaseExpiresAt,
  });
}

function acquireLease(db: Database, request: LedgerSession.AcquireLease, refuse: RefuseWrite) {
  const current = selectSession(db, request.sessionId);
  if (current === undefined) return refuse(new SessionNotFound({ sessionId: request.sessionId }));
  if (current.leaseFence !== request.expectedFence) return refuse(leaseRefusal(current, "stale"));
  if (
    current.leaseOwner !== null &&
    current.leaseOwner !== request.owner &&
    current.leaseExpiresAt !== null &&
    !Deadline.isExpired(request.now, current.leaseExpiresAt)
  )
    return refuse(leaseRefusal(current, "held"));
  const fence = current.leaseFence + 1;
  const updated = db
    .query(
      `UPDATE session SET lease_owner = ?, lease_fence = ?, lease_expires_at = ?
     WHERE id = ? AND lease_fence = ? AND role IS NOT NULL
       AND (lease_owner IS NULL OR lease_owner = ? OR lease_expires_at <= ?)`,
    )
    .run(
      request.owner,
      fence,
      request.expiresAt,
      request.sessionId,
      request.expectedFence,
      request.owner,
      request.now,
    );
  if (updated.changes !== 1) {
    const latest = selectSession(db, request.sessionId);
    if (latest === undefined) return refuse(new SessionNotFound({ sessionId: request.sessionId }));
    return refuse(leaseRefusal(latest, "stale"));
  }
  return { ok: true as const, fence };
}

export function createSessions(
  db: Database,
  transaction: <T>(operation: () => T) => T,
  observationSink: ObservationSink,
): SessionWriteAdapter {
  return {
    create: (row) =>
      writeEffect("session.create", () =>
        transaction(() => insertSession(db, LedgerSession.Row.parse(row))),
      ),
    materialize: (input) =>
      writeEffect("session.materialize", (refuse) => {
        const result = transaction(() =>
          materializeSession(db, LedgerSession.Materialize.parse(input), refuse),
        );
        if (result.created) publishCommitted(db, observationSink, result.receipt);
        return result;
      }),
    get(id) {
      const row = db.query<SessionSqlRow, [string]>(`${sessionSelect} WHERE id = ?`).get(id);
      return row === null ? undefined : decodeSession(row);
    },
    openChildCount: (parentId) => openChildCount(db, parentId),
    list() {
      const rows = db
        .query<SessionSqlRow, []>(`${sessionSelect} WHERE role IS NOT NULL ORDER BY id`)
        .all();
      return rows.map(decodeSession);
    },
    acquireLease: (input) =>
      writeEffect("session.acquireLease", (refuse) =>
        transaction(() => acquireLease(db, LedgerSession.AcquireLease.parse(input), refuse)),
      ),
    renewLease: (input) =>
      writeEffect("session.renewLease", (refuse) =>
        transaction(() => {
          const request = LedgerSession.RenewLease.parse(input);
          const updated = db
            .query(
              `UPDATE session SET lease_expires_at = ?
         WHERE id = ? AND lease_owner = ? AND lease_fence = ?
           AND lease_expires_at > ? AND role IS NOT NULL`,
            )
            .run(request.expiresAt, request.sessionId, request.owner, request.fence, request.now);
          if (updated.changes === 1) return true as const;
          const current = selectSession(db, request.sessionId);
          if (current === undefined)
            return refuse(new SessionNotFound({ sessionId: request.sessionId }));
          return refuse(leaseRefusal(current, "stale"));
        }),
      ),
    commit: (input) =>
      writeEffect("session.commit", (refuse) => {
        const outcome = transaction(() => {
          const request = LedgerSession.Commit.parse(input);
          const result = commitSession(db, request, refuse);
          if (result === undefined)
            return refuse(new SessionNotFound({ sessionId: request.sessionId }));
          if (!result.ok)
            return refuse(
              new CommitRefused({
                sessionId: request.sessionId,
                reason: result.reason === "stale" ? "fence" : result.reason,
                expectedRevision: request.expectedRevision,
                currentRevision: result.currentRevision,
                fence: request.fence,
                currentFence: result.currentFence,
              }),
            );
          return result;
        });
        for (const receipt of outcome.receipts) publishCommitted(db, observationSink, receipt);
        return outcome;
      }),
  };
}
