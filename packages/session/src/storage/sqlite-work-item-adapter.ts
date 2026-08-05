import type { Database } from "bun:sqlite";
import { WorkItem, type Storage as ProtocolStorage } from "@openomni/protocol";
import { isWorkItemCompletionWriter } from "../work-item/completion-writer.js";

export function createSqliteWorkItemAdapter(db: Database): ProtocolStorage.WorkItemSubAdapter {
  return {
    create: (hash: string, item: WorkItem.Info): boolean => {
      const parsed = WorkItem.Info.parse(item);
      assertMatchingHash(hash, parsed.hash);
      const result = db
        .query(
          `INSERT OR IGNORE INTO work_item
             (hash, data, status, assignee_id, session_id, parent_hash, source_channel, time_created, time_updated)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          hash,
          JSON.stringify(parsed),
          WorkItem.deriveStatus(parsed),
          parsed.assigneeId ?? null,
          parsed.sessionId ?? null,
          parsed.relations.parentHash ?? null,
          parsed.sourceChannel,
          parsed.timestamps.created,
          parsed.timestamps.updated,
        );
      return result.changes === 1;
    },

    get: (hash: string): WorkItem.Info | undefined => {
      const row = db.query("SELECT data FROM work_item WHERE hash = ?").get(hash) as {
        data: string;
      } | null;
      return row ? decodeWorkItem(row.data) : undefined;
    },

    compareAndSet: (hash: string, expectedHead: number, item: WorkItem.Info): boolean => {
      const parsed = WorkItem.Info.parse(item);
      assertMatchingHash(hash, parsed.hash);
      if (parsed.revision !== expectedHead + 1) {
        throw new Error(
          `WorkItem revision must advance once: expected=${expectedHead} payload=${parsed.revision}`,
        );
      }
      const currentRow = db.query("SELECT data FROM work_item WHERE hash = ?").get(hash) as {
        data: string;
      } | null;
      const current = currentRow ? decodeWorkItem(currentRow.data) : undefined;
      if (current && changesCompletionAuthority(current, parsed) && !isWorkItemCompletionWriter()) {
        throw new Error("WorkItem completion fact writes are restricted to the OpenOmni boundary");
      }
      const result = db
        .query(
          `UPDATE work_item SET
             data = ?,
             status = ?,
             assignee_id = ?,
             session_id = ?,
             parent_hash = ?,
             source_channel = ?,
             time_updated = ?
           WHERE hash = ?
             AND (
               json_extract(data, '$.revision') = ?
               OR (
                 json_type(data, '$.revision') IS NULL
                 AND json_type(data, '$.completionContract') IS NULL
                 AND json_type(data, '$.completionFacts') IS NULL
                 AND CASE
                   WHEN json_type(data, '$.timestamps.completed') IN ('integer', 'real') THEN 2
                   ELSE 0
                 END = ?
               )
             )`,
        )
        .run(
          JSON.stringify(parsed),
          WorkItem.deriveStatus(parsed),
          parsed.assigneeId ?? null,
          parsed.sessionId ?? null,
          parsed.relations.parentHash ?? null,
          parsed.sourceChannel,
          Date.now(),
          hash,
          expectedHead,
          expectedHead,
        );
      return result.changes === 1;
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
      return rows.map((row) => decodeWorkItem(row.data));
    },

    remove: (hash: string): boolean => {
      const result = db.query("DELETE FROM work_item WHERE hash = ?").run(hash);
      return result.changes > 0;
    },
  };
}

function changesCompletionAuthority(current: WorkItem.Info, next: WorkItem.Info): boolean {
  return (
    JSON.stringify(current.completionFacts) !== JSON.stringify(next.completionFacts) ||
    JSON.stringify(current.completionReport) !== JSON.stringify(next.completionReport) ||
    JSON.stringify(current.completionTerminalReceipt) !==
      JSON.stringify(next.completionTerminalReceipt)
  );
}

function decodeWorkItem(data: string): WorkItem.Info {
  return WorkItem.Info.parse(WorkItem.upcastLegacyCompletion(JSON.parse(data)));
}

function assertMatchingHash(key: string, payload: string): void {
  if (key !== payload) {
    throw new Error(`WorkItem hash mismatch: key=${key} payload=${payload}`);
  }
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
