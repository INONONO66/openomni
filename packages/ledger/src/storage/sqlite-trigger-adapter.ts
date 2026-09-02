import { Trigger, type Storage as ProtocolStorage } from "@openomni/protocol";
import type { Database } from "bun:sqlite";

type TriggerRow = {
  readonly id: string;
  readonly owner_session_id: string;
  readonly state: string;
  readonly kind: string;
  readonly data: string;
  readonly revision: number;
  readonly expires_at: number | null;
  readonly next_fire_at: number | null;
  readonly time_created: number;
  readonly time_updated: number;
};

function projectionBindings(record: Trigger.Record) {
  return [
    record.ownerSessionId,
    record.lifecycle.state,
    record.source.kind,
    JSON.stringify(record),
    record.revision,
    record.expiresAt ?? null,
    record.nextFireAt ?? null,
    record.createdAt,
    record.updatedAt,
  ] as const;
}

export function createSqliteTriggerAdapter(db: Database): ProtocolStorage.TriggerSubAdapter {
  return {
    create(record) {
      const parsed = Trigger.Record.parse(record);
      const result = db
        .query(
          `INSERT OR IGNORE INTO trigger_record (
             id, owner_session_id, state, kind, data, revision, expires_at,
             next_fire_at, time_created, time_updated
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(parsed.id, ...projectionBindings(parsed));
      return result.changes === 1;
    },
    get(id) {
      const row = db
        .query(
          `SELECT id, owner_session_id, state, kind, data, revision, expires_at,
                  next_fire_at, time_created, time_updated
           FROM trigger_record WHERE id = ?`,
        )
        .get(id) as TriggerRow | null;
      return row === null ? undefined : decodeTriggerRow(row);
    },
    list(filter) {
      const { sql, params } = triggerFilter(filter);
      const rows = db
        .query(
          `SELECT id, owner_session_id, state, kind, data, revision, expires_at,
                  next_fire_at, time_created, time_updated
           FROM trigger_record${sql}`,
        )
        .all(...params) as TriggerRow[];
      return rows.map(decodeTriggerRow);
    },
    listIds(filter) {
      const { sql, params } = triggerFilter(filter);
      return (
        db.query(`SELECT id FROM trigger_record${sql}`).all(...params) as Array<{ id: string }>
      ).map((row) => row.id);
    },
    listActiveIds() {
      return (
        db
          .query(
            `SELECT id FROM trigger_record
             WHERE state <> 'ended'
             ORDER BY time_created ASC, id ASC`,
          )
          .all() as Array<{ id: string }>
      ).map((row) => row.id);
    },
    countActiveByOwner(ownerSessionId) {
      const row = db
        .query(
          `SELECT COUNT(*) AS count FROM trigger_record
           WHERE owner_session_id = ? AND state <> 'ended'`,
        )
        .get(ownerSessionId) as { count: number };
      return row.count;
    },
    compareAndSet(id, expectedRevision, record) {
      const parsed = Trigger.Record.parse(record);
      if (parsed.id !== id) {
        throw new Error(`Trigger id mismatch: key=${id} payload=${parsed.id}`);
      }
      if (parsed.revision !== expectedRevision + 1) {
        throw new Error(
          `Trigger revision must advance exactly once: expected=${expectedRevision} payload=${parsed.revision}`,
        );
      }
      const result = db
        .query(
          `UPDATE trigger_record SET
             owner_session_id = ?, state = ?, kind = ?, data = ?, revision = ?,
             expires_at = ?, next_fire_at = ?, time_created = ?, time_updated = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(...projectionBindings(parsed), id, expectedRevision);
      return result.changes === 1;
    },
  };
}

function triggerFilter(filter: ProtocolStorage.TriggerListFilter | undefined): {
  sql: string;
  params: Array<string | number>;
} {
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (filter?.ownerSessionId !== undefined) {
    conditions.push("owner_session_id = ?");
    params.push(filter.ownerSessionId);
  }
  if (filter?.states !== undefined && filter.states.length > 0) {
    conditions.push(`state IN (${filter.states.map(() => "?").join(", ")})`);
    params.push(...filter.states);
  }
  if (filter?.kinds !== undefined && filter.kinds.length > 0) {
    conditions.push(`kind IN (${filter.kinds.map(() => "?").join(", ")})`);
    params.push(...filter.kinds);
  }
  const where = conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`;
  const direction = filter?.order === "newest" ? "DESC" : "ASC";
  const limit = listLimit(filter?.limit);
  params.push(limit);
  return {
    sql: `${where} ORDER BY time_created ${direction}, id ${direction} LIMIT ?`,
    params,
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
      `Trigger list limit must be in 1..${Trigger.Constants.MAX_TRIGGER_LIST_ROWS}`,
    );
  }
  return value;
}

function decodeTriggerRow(row: TriggerRow): Trigger.Record {
  const record = Trigger.Record.parse(JSON.parse(row.data));
  const mismatch =
    row.id !== record.id ||
    row.owner_session_id !== record.ownerSessionId ||
    row.state !== record.lifecycle.state ||
    row.kind !== record.source.kind ||
    row.revision !== record.revision ||
    row.expires_at !== (record.expiresAt ?? null) ||
    row.next_fire_at !== (record.nextFireAt ?? null) ||
    row.time_created !== record.createdAt ||
    row.time_updated !== record.updatedAt;
  if (mismatch) {
    throw new Error(`Trigger indexed projection mismatch: ${row.id}`);
  }
  return record;
}
