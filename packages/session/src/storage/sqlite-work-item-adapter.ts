import type { Database } from "bun:sqlite";
import { WorkItem, type Storage as ProtocolStorage } from "@openomni/protocol";
import { isAuthorizedCompletionWriter } from "../work-item/completion-writer.js";

export function createSqliteWorkItemAdapter(db: Database): ProtocolStorage.WorkItemSubAdapter {
  const adapter: ProtocolStorage.WorkItemSubAdapter = {
    create: (hash: string, item: WorkItem.Info): boolean => {
      const parsed = WorkItem.Info.parse(item);
      assertMatchingHash(hash, parsed.hash);
      assertPendingCompletionBaseline(parsed);
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
      const row = db
        .query("SELECT hash, data FROM work_item WHERE hash = ?")
        .get(hash) as WorkItemRow | null;
      return row ? decodeWorkItemRow(row) : undefined;
    },

    compareAndSet: (hash: string, expectedHead: number, item: WorkItem.Info): boolean => {
      const parsed = WorkItem.Info.parse(item);
      assertMatchingHash(hash, parsed.hash);
      if (parsed.revision !== expectedHead + 1) {
        throw new Error(
          `WorkItem revision must advance once: expected=${expectedHead} payload=${parsed.revision}`,
        );
      }
      const currentRow = db
        .query("SELECT hash, data FROM work_item WHERE hash = ?")
        .get(hash) as WorkItemRow | null;
      const current = currentRow ? decodeWorkItemRow(currentRow) : undefined;
      if (
        current &&
        changesCompletionAuthority(current, parsed) &&
        !isAuthorizedCompletionWriter()
      ) {
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
        .query(`SELECT hash, data FROM work_item ${where} ORDER BY time_created ASC`)
        .all(...params) as WorkItemRow[];
      return rows.map(decodeWorkItemRow);
    },

    remove: (hash: string): boolean => {
      const result = db.query("DELETE FROM work_item WHERE hash = ?").run(hash);
      return result.changes > 0;
    },
  };
  return adapter;
}

function assertPendingCompletionBaseline(item: WorkItem.Info): void {
  const facts = item.completionFacts;
  if (
    WorkItem.deriveStatus(item) !== "pending" ||
    facts.revision !== 0 ||
    facts.claims.length > 0 ||
    facts.observations.length > 0 ||
    facts.results.length > 0 ||
    facts.invalidations.length > 0 ||
    facts.verificationErrors.length > 0 ||
    facts.effects.length > 0 ||
    facts.requestReservations.length > 0 ||
    facts.admissions.length > 0 ||
    item.completionReport !== undefined ||
    item.completionTerminalReceipt !== undefined
  ) {
    throw new Error("WorkItem create accepts pending completion baselines only");
  }
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

type WorkItemRow = Readonly<{ hash: string; data: string }>;

function decodeWorkItemRow(row: WorkItemRow): WorkItem.Info {
  const item = decodeWorkItem(row.data);
  assertMatchingHash(row.hash, item.hash);
  return item;
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
