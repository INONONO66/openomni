import type { Database } from "bun:sqlite";
import { WorkItem, type Storage as ProtocolStorage } from "@openomni/protocol";
import { isAuthorizedCompletionWriter } from "../work-item/completion-writer.js";

export function createSqliteWorkItemAdapter(db: Database): ProtocolStorage.WorkItemSubAdapter {
  const adapter: ProtocolStorage.WorkItemSubAdapter = {
    create: (hash: string, item: WorkItem.Info): boolean => {
      const parsed = WorkItem.Info.parse(item);
      assertMatchingHash(hash, parsed.workItemId);
      assertPendingCompletionBaseline(parsed);
      const result = db
        .query(
          `INSERT OR IGNORE INTO work_item
             (hash, data, revision, status, assignee_id, session_id, parent_hash, source_channel, time_created, time_updated)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          hash,
          JSON.stringify(parsed),
          parsed.revision,
          WorkItem.deriveStatus(parsed),
          parsed.assigneeId ?? null,
          parsed.sessionId ?? null,
          parsed.relations.parentId ?? null,
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
      assertMatchingHash(hash, parsed.workItemId);
      if (parsed.revision !== expectedHead + 1) {
        throw new Error(
          `WorkItem revision must advance once: expected=${expectedHead} payload=${parsed.revision}`,
        );
      }
      const currentRow = db
        .query("SELECT hash, data FROM work_item WHERE hash = ?")
        .get(hash) as WorkItemRow | null;
      const current = currentRow ? decodeWorkItemRow(currentRow) : undefined;
      if (current?.revision === expectedHead) assertCompletionLedgerExtension(current, parsed);
      if (
        current &&
        changesCompletionAuthority(current, parsed) &&
        !isAuthorizedCompletionWriter()
      ) {
        throw new Error("WorkItem completion fact writes are restricted to the OpenOmni boundary");
      }
      // Revision CAS on the physical column (0014): the column is written in
      // lockstep with the payload's revision, so head==revision holds for
      // both readers.
      const result = db
        .query(
          `UPDATE work_item SET
             data = ?,
             revision = ?,
             status = ?,
             assignee_id = ?,
             session_id = ?,
             parent_hash = ?,
             source_channel = ?,
             time_updated = ?
           WHERE hash = ?
             AND revision = ?`,
        )
        .run(
          JSON.stringify(parsed),
          parsed.revision,
          WorkItem.deriveStatus(parsed),
          parsed.assigneeId ?? null,
          parsed.sessionId ?? null,
          parsed.relations.parentId ?? null,
          parsed.sourceChannel,
          Date.now(),
          hash,
          expectedHead,
        );
      return result.changes === 1;
    },

    list: (filter?: ProtocolStorage.WorkItemListFilter): WorkItem.Info[] => {
      const conditions: string[] = [];
      const params: (string | null)[] = [];

      addNullableCondition(conditions, params, "assignee_id", filter?.assigneeId);
      addNullableCondition(conditions, params, "session_id", filter?.sessionId);
      addNullableCondition(conditions, params, "parent_hash", filter?.parentId);

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

function assertCompletionLedgerExtension(current: WorkItem.Info, next: WorkItem.Info): void {
  assertAppendOnly("evidence", current.evidence, next.evidence);
  const collections = [
    ["criteria", current.completionFacts.criteria, next.completionFacts.criteria],
    ["claims", current.completionFacts.claims, next.completionFacts.claims],
    ["observations", current.completionFacts.observations, next.completionFacts.observations],
    ["results", current.completionFacts.results, next.completionFacts.results],
    ["invalidations", current.completionFacts.invalidations, next.completionFacts.invalidations],
    [
      "verification errors",
      current.completionFacts.verificationErrors,
      next.completionFacts.verificationErrors,
    ],
    ["effects", current.completionFacts.effects, next.completionFacts.effects],
    [
      "request reservations",
      current.completionFacts.requestReservations,
      next.completionFacts.requestReservations,
    ],
    ["admissions", current.completionFacts.admissions, next.completionFacts.admissions],
  ] as const;
  for (const [name, previous, candidate] of collections) {
    assertAppendOnly(`completion ${name}`, previous, candidate);
  }
  if (next.completionFacts.revision < current.completionFacts.revision) {
    throw new Error("completion facts revision cannot move backward");
  }
  if (
    current.completionReport !== undefined &&
    JSON.stringify(current.completionReport) !== JSON.stringify(next.completionReport)
  ) {
    throw new Error("completion report is immutable");
  }
  if (
    current.completionTerminalReceipt !== undefined &&
    JSON.stringify(current.completionTerminalReceipt) !==
      JSON.stringify(next.completionTerminalReceipt)
  ) {
    throw new Error("completion terminal receipt is immutable");
  }
}

function assertAppendOnly(
  name: string,
  previous: readonly unknown[],
  candidate: readonly unknown[],
): void {
  if (
    candidate.length < previous.length ||
    previous.some((entry, index) => JSON.stringify(entry) !== JSON.stringify(candidate[index]))
  ) {
    throw new Error(`${name} are append-only`);
  }
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
  return WorkItem.Info.parse(JSON.parse(data));
}

type WorkItemRow = Readonly<{ hash: string; data: string }>;

function decodeWorkItemRow(row: WorkItemRow): WorkItem.Info {
  const item = decodeWorkItem(row.data);
  assertMatchingHash(row.hash, item.workItemId);
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
