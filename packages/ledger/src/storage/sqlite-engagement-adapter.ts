import { Engagement, type Storage as ProtocolStorage } from "@openomni/protocol";
import type { Database } from "bun:sqlite";
import type { SqliteJsonDataRow } from "./sqlite-json-data";

/**
 * Durable engagement rows (#709, brain domain — gateway-design §4/§5).
 * Write shape is owned by the EngagementStore factory (`Engagement.open` /
 * the transition fold); this adapter records receipts (`changes === 1`) and
 * re-validates only on read, across the persistence boundary.
 */
export function createSqliteEngagementAdapter(db: Database): ProtocolStorage.EngagementSubAdapter {
  return {
    create(record) {
      const result = db
        .query(
          `INSERT OR IGNORE INTO engagement (
             id, owner_session_id, state, data, revision, expires_at,
             time_created, time_updated
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.ownerSessionId,
          record.state,
          JSON.stringify(record),
          record.revision,
          record.expiresAt ?? null,
          record.createdAt,
          record.updatedAt,
        );
      return result.changes === 1;
    },
    get(id) {
      const row = db
        .query("SELECT data FROM engagement WHERE id = ?")
        .get(id) as SqliteJsonDataRow | null;
      return row ? decodeEngagementRow(row) : undefined;
    },
    list(filter) {
      const conditions: string[] = [];
      const params: string[] = [];
      if (filter?.ownerSessionId !== undefined) {
        conditions.push("owner_session_id = ?");
        params.push(filter.ownerSessionId);
      }
      if (filter?.states !== undefined && filter.states.length > 0) {
        conditions.push(`state IN (${filter.states.map(() => "?").join(", ")})`);
        params.push(...filter.states);
      }
      const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
      const rows = db
        .query(`SELECT data FROM engagement${where} ORDER BY time_created ASC`)
        .all(...params) as SqliteJsonDataRow[];
      return rows.map(decodeEngagementRow);
    },
    compareAndSet(id, expectedRevision, record) {
      if (record.id !== id) {
        throw new Error(`Engagement id mismatch: key=${id} payload=${record.id}`);
      }
      if (record.revision !== expectedRevision + 1) {
        throw new Error(
          `Engagement revision must advance exactly once: expected=${expectedRevision} payload=${record.revision}`,
        );
      }
      const result = db
        .query(
          `UPDATE engagement SET
             state = ?,
             data = ?,
             revision = ?,
             expires_at = ?,
             time_updated = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(
          record.state,
          JSON.stringify(record),
          record.revision,
          record.expiresAt ?? null,
          record.updatedAt,
          id,
          expectedRevision,
        );
      return result.changes === 1;
    },
  };
}

function decodeEngagementRow(row: SqliteJsonDataRow): Engagement.Record {
  return Engagement.Record.parse(JSON.parse(row.data));
}
