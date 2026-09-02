import { Trigger, type Storage as ProtocolStorage } from "@openomni/protocol";
import type { Database } from "bun:sqlite";

type TriggerFireRow = {
  readonly id: string;
  readonly trigger_id: string;
  readonly owner_session_id: string;
  readonly status: string;
  readonly data: string;
  readonly revision: number;
  readonly time_created: number;
  readonly time_updated: number;
};

function projectionBindings(record: Trigger.Fire) {
  return [
    record.triggerId,
    record.ownerSessionId,
    record.status,
    JSON.stringify(record),
    record.revision,
    record.recordedAt,
    record.updatedAt,
  ] as const;
}

export function createSqliteTriggerFireAdapter(
  db: Database,
): ProtocolStorage.TriggerFireSubAdapter {
  return {
    create(record) {
      const parsed = Trigger.Fire.parse(record);
      const result = db
        .query(
          `INSERT OR IGNORE INTO trigger_fire (
             id, trigger_id, owner_session_id, status, data, revision,
             time_created, time_updated
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(parsed.id, ...projectionBindings(parsed));
      return result.changes === 1;
    },
    get(id) {
      const row = db
        .query(
          `SELECT id, trigger_id, owner_session_id, status, data, revision,
                  time_created, time_updated
           FROM trigger_fire WHERE id = ?`,
        )
        .get(id) as TriggerFireRow | null;
      return row === null ? undefined : decodeTriggerFireRow(row);
    },
    list(filter) {
      const conditions: string[] = [];
      const params: Array<string | number> = [];
      if (filter?.triggerId !== undefined) {
        conditions.push("trigger_id = ?");
        params.push(filter.triggerId);
      }
      if (filter?.ownerSessionId !== undefined) {
        conditions.push("owner_session_id = ?");
        params.push(filter.ownerSessionId);
      }
      if (filter?.statuses !== undefined && filter.statuses.length > 0) {
        conditions.push(`status IN (${filter.statuses.map(() => "?").join(", ")})`);
        params.push(...filter.statuses);
      }
      const where = conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`;
      params.push(listLimit(filter?.limit));
      const rows = db
        .query(
          `SELECT id, trigger_id, owner_session_id, status, data, revision,
                  time_created, time_updated
           FROM trigger_fire${where}
           ORDER BY time_created ASC, id ASC LIMIT ?`,
        )
        .all(...params) as TriggerFireRow[];
      return rows.map(decodeTriggerFireRow);
    },
    compareAndSet(id, expectedRevision, record) {
      const parsed = Trigger.Fire.parse(record);
      if (parsed.id !== id) {
        throw new Error(`Trigger Fire id mismatch: key=${id} payload=${parsed.id}`);
      }
      if (parsed.revision !== expectedRevision + 1) {
        throw new Error(
          `Trigger Fire revision must advance exactly once: expected=${expectedRevision} payload=${parsed.revision}`,
        );
      }
      const result = db
        .query(
          `UPDATE trigger_fire SET
             trigger_id = ?, owner_session_id = ?, status = ?, data = ?, revision = ?,
             time_created = ?, time_updated = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(...projectionBindings(parsed), id, expectedRevision);
      return result.changes === 1;
    },
    listUnackedIds() {
      return (
        db
          .query(
            `SELECT id FROM trigger_fire
             WHERE status IN ('recorded', 'delivered')
             ORDER BY time_created ASC, id ASC`,
          )
          .all() as Array<{ id: string }>
      ).map((row) => row.id);
    },
  };
}

function listLimit(limit: number | undefined): number {
  const value = limit ?? Trigger.Constants.MAX_TRIGGER_LIST_ROWS;
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > Trigger.Constants.MAX_TRIGGER_LIST_ROWS
  ) {
    throw new RangeError(
      `Trigger Fire list limit must be in 1..${Trigger.Constants.MAX_TRIGGER_LIST_ROWS}`,
    );
  }
  return value;
}

function decodeTriggerFireRow(row: TriggerFireRow): Trigger.Fire {
  const record = Trigger.Fire.parse(JSON.parse(row.data));
  const mismatch =
    row.id !== record.id ||
    row.trigger_id !== record.triggerId ||
    row.owner_session_id !== record.ownerSessionId ||
    row.status !== record.status ||
    row.revision !== record.revision ||
    row.time_created !== record.recordedAt ||
    row.time_updated !== record.updatedAt;
  if (mismatch) {
    throw new Error(`Trigger Fire indexed projection mismatch: ${row.id}`);
  }
  return record;
}
