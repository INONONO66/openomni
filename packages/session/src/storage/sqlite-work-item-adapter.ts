import type { Database } from "bun:sqlite";
import { WorkItem, type Storage as ProtocolStorage } from "@openomni/protocol";

export function createSqliteWorkItemAdapter(db: Database): ProtocolStorage.WorkItemSubAdapter {
  return {
    get: (hash: string): WorkItem.Info | undefined => {
      const row = db.query("SELECT data FROM work_item WHERE hash = ?").get(hash) as {
        data: string;
      } | null;
      return row ? (JSON.parse(row.data) as WorkItem.Info) : undefined;
    },

    set: (hash: string, item: WorkItem.Info): void => {
      if (hash !== item.hash) {
        throw new Error(`WorkItem hash mismatch: key=${hash} payload=${item.hash}`);
      }
      const now = Date.now();
      const status = WorkItem.deriveStatus(item);
      db.query(
        `INSERT INTO work_item (hash, data, status, assignee_id, session_id, parent_hash, source_channel, time_created, time_updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(hash) DO UPDATE SET
           data = excluded.data,
           status = excluded.status,
           assignee_id = excluded.assignee_id,
           session_id = excluded.session_id,
           parent_hash = excluded.parent_hash,
           source_channel = excluded.source_channel,
           time_updated = excluded.time_updated`,
      ).run(
        hash,
        JSON.stringify(item),
        status,
        item.assigneeId ?? null,
        item.sessionId ?? null,
        item.relations.parentHash ?? null,
        item.sourceChannel,
        item.timestamps.created,
        now,
      );
    },

    list: (filter?: ProtocolStorage.WorkItemListFilter): WorkItem.Info[] => {
      const conditions: string[] = [];
      const params: (string | null)[] = [];

      addNullableCondition(conditions, params, "assignee_id", filter?.assigneeId);
      addNullableCondition(conditions, params, "session_id", filter?.sessionId);
      addNullableCondition(conditions, params, "parent_hash", filter?.parentHash);

      if (filter?.status && filter.status.length > 0) {
        const placeholders = filter.status.map(() => "?").join(", ");
        conditions.unshift(`status IN (${placeholders})`);
        params.unshift(...filter.status);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const rows = db
        .query(`SELECT data FROM work_item ${where} ORDER BY time_created ASC`)
        .all(...params) as Array<{ data: string }>;
      return rows.map((r) => JSON.parse(r.data) as WorkItem.Info);
    },

    remove: (hash: string): boolean => {
      const result = db.query("DELETE FROM work_item WHERE hash = ?").run(hash);
      return result.changes > 0;
    },
  };
}

function addNullableCondition(
  conditions: string[],
  params: (string | null)[],
  column: string,
  value: string | null | undefined,
): void {
  if (value === undefined) return;
  if (value === null) {
    conditions.push(`${column} IS NULL`);
    return;
  }
  conditions.push(`${column} = ?`);
  params.push(value);
}
