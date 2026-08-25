import { Delegation, type Storage as ProtocolStorage } from "@openomni/protocol";
import type { Database } from "bun:sqlite";

/**
 * Durable delegation rows. The kernel owns admission and settlement meaning;
 * this adapter only records insert and open-to-settled CAS receipts.
 */
export function createSqliteDelegationAdapter(db: Database): ProtocolStorage.DelegationSubAdapter {
  return {
    create(record) {
      const parsed = Delegation.Record.parse(record);
      const result = db
        .query(
          `INSERT OR IGNORE INTO delegation (
             delegation_id, status, root_delegation_id, wait_id, data, time_created, settled_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.delegationId,
          parsed.status,
          parsed.rootDelegationId,
          parsed.waitId ?? null,
          JSON.stringify(parsed),
          parsed.createdAt,
          parsed.settledAt ?? null,
        );
      return result.changes === 1;
    },
    get(delegationId) {
      const row = db
        .query("SELECT delegation_id, data FROM delegation WHERE delegation_id = ?")
        .get(delegationId) as DelegationRow | null;
      return row === null ? undefined : decodeRow(row);
    },
    compareAndSwapStatus(delegationId, settled, settledAt) {
      const row = db
        .query("SELECT delegation_id, data FROM delegation WHERE delegation_id = ?")
        .get(delegationId) as DelegationRow | null;
      if (row === null) return false;
      const current = decodeRow(row);
      if (current.status !== "open") return false;
      const next = Delegation.Record.parse({
        ...current,
        status: "settled",
        settled,
        settledAt,
      });
      const result = db
        .query(
          `UPDATE delegation
           SET status = ?, data = ?, settled_at = ?
           WHERE delegation_id = ? AND status = 'open'`,
        )
        .run("settled", JSON.stringify(next), settledAt, delegationId);
      return result.changes === 1;
    },
    listOpen() {
      const rows = db
        .query(
          "SELECT delegation_id, data FROM delegation WHERE status = 'open' ORDER BY time_created ASC",
        )
        .all() as DelegationRow[];
      return rows.map(decodeRow);
    },
    listOpenByRoot(rootDelegationId) {
      const rows = db
        .query(
          `SELECT delegation_id, data FROM delegation
           WHERE status = 'open' AND root_delegation_id = ?
           ORDER BY time_created ASC`,
        )
        .all(rootDelegationId) as DelegationRow[];
      return rows.map(decodeRow);
    },
    findByWaitId(waitId) {
      const row = db
        .query("SELECT delegation_id, data FROM delegation WHERE wait_id = ?")
        .get(waitId) as DelegationRow | null;
      return row === null ? undefined : decodeRow(row);
    },
  };
}

type DelegationRow = Readonly<{ delegation_id: string; data: string }>;

function decodeRow(row: DelegationRow): Delegation.Record {
  const record = Delegation.Record.parse(JSON.parse(row.data));
  if (record.delegationId !== row.delegation_id) {
    throw new Error(
      `Delegation id mismatch: key=${row.delegation_id} payload=${record.delegationId}`,
    );
  }
  return record;
}
