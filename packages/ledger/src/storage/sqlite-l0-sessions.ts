import type { Database } from "bun:sqlite";
import {
  Deadline,
  LedgerSession,
  type ObservationSink,
  type Storage as ProtocolStorage,
} from "@openomni/protocol";
import { SessionSqlRow, decodeSession } from "./sqlite-l0-rows";
import {
  sessionSelect,
  insertSession,
  selectSessionSql,
  selectSession,
  appendAction,
  SessionCommitRefused,
  commitSession,
  openChildCount,
} from "./sqlite-l0-write";
import { publishCommitted } from "./sqlite-l0-observation";

export function createSessions(
  db: Database,
  transaction: <T>(operation: () => T) => T,
  observationSink: ObservationSink,
): ProtocolStorage.SessionLedgerSubAdapter {
  return {
    create(row) {
      return transaction(() => insertSession(db, LedgerSession.Row.parse(row)));
    },
    materialize(input) {
      const parsed = LedgerSession.Materialize.parse(input);
      if (
        parsed.initialAction.sessionId !== parsed.row.id ||
        parsed.initialAction.kind !== "session.configure" ||
        parsed.initialAction.parentId !== null ||
        parsed.row.revision !== 0
      ) {
        return undefined;
      }
      const result = transaction(() => {
        if (!insertSession(db, parsed.row)) {
          const existing = selectSessionSql(db, parsed.row.id);
          if (existing === undefined) return undefined;
          if (existing.role !== null) {
            return { created: false as const, row: decodeSession(existing) };
          }
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
          if (promoted.changes !== 1) return undefined;
        }
        const receipt = appendAction(db, parsed.initialAction, 0);
        if (receipt === undefined) throw new Error("initial session configuration was refused");
        const row = selectSession(db, parsed.row.id);
        if (row === undefined) throw new Error("materialized session disappeared");
        return { created: true as const, row, receipt };
      });
      if (result?.created === true) publishCommitted(db, observationSink, result.receipt);
      return result;
    },
    get: (id) => selectSession(db, id),
    openChildCount: (parentId) => openChildCount(db, parentId),
    list() {
      const rows = SessionSqlRow.array().parse(
        db.query(`${sessionSelect} WHERE role IS NOT NULL ORDER BY id`).all(),
      );
      return rows.map(decodeSession);
    },
    acquireLease(input) {
      const request = LedgerSession.AcquireLease.parse(input);
      return transaction(() => {
        const current = selectSession(db, request.sessionId);
        if (current === undefined) return undefined;
        if (current.leaseFence !== request.expectedFence) {
          return {
            ok: false as const,
            reason: "stale" as const,
            currentFence: current.leaseFence,
          };
        }
        if (
          current.leaseOwner !== null &&
          current.leaseOwner !== request.owner &&
          current.leaseExpiresAt !== null &&
          !Deadline.isExpired(request.now, current.leaseExpiresAt)
        ) {
          return {
            ok: false as const,
            reason: "held" as const,
            holder: current.leaseOwner,
            expiresAt: current.leaseExpiresAt,
          };
        }
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
          if (latest === undefined) return undefined;
          return {
            ok: false as const,
            reason: "stale" as const,
            currentFence: latest.leaseFence,
          };
        }
        return { ok: true as const, fence };
      });
    },
    renewLease(input) {
      const request = LedgerSession.RenewLease.parse(input);
      return transaction(
        () =>
          db
            .query(
              `UPDATE session SET lease_expires_at = ?
               WHERE id = ? AND lease_owner = ? AND lease_fence = ?
                 AND lease_expires_at > ? AND role IS NOT NULL`,
            )
            .run(request.expiresAt, request.sessionId, request.owner, request.fence, request.now)
            .changes === 1,
      );
    },
    commit(input) {
      const request = LedgerSession.Commit.parse(input);
      let outcome: LedgerSession.CommitResult | undefined;
      try {
        outcome = transaction(() => commitSession(db, request));
      } catch (error) {
        if (error instanceof SessionCommitRefused) outcome = error.result;
        else throw error;
      }
      if (outcome?.ok === true) {
        for (const receipt of outcome.receipts) publishCommitted(db, observationSink, receipt);
      }
      return outcome;
    },
  };
}
