import { Delegation, type Storage as ProtocolStorage } from "@openomni/protocol";
import type { Database } from "bun:sqlite";

/**
 * Durable delegation rows. The kernel owns admission and settlement meaning;
 * this adapter records admission, terminal, and successful-wake CAS receipts.
 */
export function createSqliteDelegationAdapter(db: Database): ProtocolStorage.DelegationSubAdapter {
  return {
    create(record) {
      const parsed = Delegation.Record.parse(record);
      const result = db
        .query(
          `INSERT OR IGNORE INTO delegation (
             delegation_id, status, root_delegation_id, wait_id, data, time_created, settled_at, woken_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.delegationId,
          parsed.status,
          parsed.rootDelegationId,
          parsed.waitId ?? null,
          JSON.stringify(parsed),
          parsed.createdAt,
          parsed.settledAt ?? null,
          parsed.wokenAt ?? null,
        );
      return result.changes === 1;
    },
    get(delegationId) {
      const row = db
        .query("SELECT delegation_id, data, woken_at FROM delegation WHERE delegation_id = ?")
        .get(delegationId) as DelegationRow | null;
      return row === null ? undefined : decodeRow(row);
    },
    compareAndSwapStatus(delegationId, settled, settledAt) {
      const row = db
        .query("SELECT delegation_id, data, woken_at FROM delegation WHERE delegation_id = ?")
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
    compareAndSwapWoken(delegationId, wokenAt) {
      const row = db
        .query("SELECT delegation_id, data, woken_at FROM delegation WHERE delegation_id = ?")
        .get(delegationId) as DelegationRow | null;
      if (row === null || row.woken_at !== null) return false;
      const current = decodeRow(row);
      if (current.status !== "settled") return false;
      const next = Delegation.Record.parse({ ...current, wokenAt });
      const result = db
        .query(
          `UPDATE delegation
           SET data = ?, woken_at = ?
           WHERE delegation_id = ? AND status = 'settled' AND woken_at IS NULL`,
        )
        .run(JSON.stringify(next), wokenAt, delegationId);
      return result.changes === 1;
    },
    listOpen() {
      const rows = db
        .query(
          "SELECT delegation_id, data, woken_at FROM delegation WHERE status = 'open' ORDER BY time_created ASC",
        )
        .all() as DelegationRow[];
      return rows.map(decodeRow);
    },
    listSettledUnwoken() {
      const rows = db
        .query(
          `SELECT delegation_id, data, woken_at FROM delegation
           WHERE status = 'settled' AND woken_at IS NULL
           ORDER BY settled_at ASC`,
        )
        .all() as DelegationRow[];
      return rows.map(decodeRow);
    },
    listOpenByRoot(rootDelegationId) {
      const rows = db
        .query(
          `SELECT delegation_id, data, woken_at FROM delegation
           WHERE status = 'open' AND root_delegation_id = ?
           ORDER BY time_created ASC`,
        )
        .all(rootDelegationId) as DelegationRow[];
      return rows.map(decodeRow);
    },
    findByWaitId(waitId) {
      const row = db
        .query("SELECT delegation_id, data, woken_at FROM delegation WHERE wait_id = ?")
        .get(waitId) as DelegationRow | null;
      return row === null ? undefined : decodeRow(row);
    },
  };
}

type DelegationRow = Readonly<{
  delegation_id: string;
  data: string;
  woken_at: number | null;
}>;

function decodeRow(row: DelegationRow): Delegation.Record {
  const stored = JSON.parse(row.data) as Record<string, unknown>;
  // The additive receipt column is authoritative. Old JSON payloads omit it,
  // which intentionally upcasts to unwoken while the column remains NULL.
  // Assign rows written before WorkItem linkage carry no workItemId; reads
  // normalize them to a sentinel that resolves to no WorkItem, so the boot
  // sweep can still settle them instead of dying on the whole table.
  const record = Delegation.Record.parse({
    ...stored,
    ...(stored.operation === "assign" && stored.workItemId === undefined
      ? { workItemId: "legacy:pre-work-item-linkage" }
      : {}),
    ...(row.woken_at === null ? {} : { wokenAt: row.woken_at }),
  });
  if (record.delegationId !== row.delegation_id) {
    throw new Error(
      `Delegation id mismatch: key=${row.delegation_id} payload=${record.delegationId}`,
    );
  }
  return record;
}
