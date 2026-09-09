import type { Database } from "bun:sqlite";
import {
  Alarm,
  canonicalDigest,
  type ObservationSink,
  type Storage as ProtocolStorage,
} from "@openomni/protocol";
import {
  alarmAppend,
  alarmFired,
  alarmOccurrence,
  alarmPrompt,
  inboxAppend,
} from "./l0-action-builders.js";
import { AlarmSqlRow, decodeAlarm } from "./sqlite-l0-rows";
import { selectSession, appendAction, insertInbox } from "./sqlite-l0-write";
import { publishCommitted } from "./sqlite-l0-observation";

function selectAlarm(db: Database, id: string): Alarm.Row | undefined {
  const row = db.query<AlarmSqlRow, [string]>("SELECT * FROM alarm WHERE id = ?").get(id);
  return row === null ? undefined : decodeAlarm(AlarmSqlRow.parse(row));
}

function armAlarm(db: Database, parsed: Alarm.Arm) {
  const session = selectSession(db, parsed.sessionId);
  if (session === undefined) return undefined;
  const receipt = appendAction(db, alarmAppend(parsed), session.revision);
  if (receipt === undefined) return undefined;
  const row = Alarm.Row.parse({
    ...parsed,
    status: "armed",
    createdAt: parsed.fireAt,
    updatedAt: parsed.fireAt,
  });
  db.query(`INSERT INTO alarm (
		id, session_id, kind, fire_at, spec, encoding_version, status, time_created, time_updated
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.id,
    row.sessionId,
    row.kind,
    row.fireAt,
    row.spec === undefined ? null : JSON.stringify(row.spec.value),
    row.spec?.encodingVersion ?? 1,
    row.status,
    row.createdAt,
    row.updatedAt,
  );
  return { receipt, row };
}

export function createAlarms(
  db: Database,
  transaction: <T>(operation: () => T) => T,
  observationSink: ObservationSink,
): ProtocolStorage.AlarmSubAdapter {
  return {
    arm(input) {
      const parsed = Alarm.Arm.parse(input);
      const result = transaction(() => armAlarm(db, parsed));
      if (result === undefined) return undefined;
      publishCommitted(db, observationSink, result.receipt);
      return result.row;
    },
    get: (id) => selectAlarm(db, id),
    cancel(id, sessionId, at) {
      const result = transaction(() => controlAlarm(db, id, sessionId, at, "cancel"));
      if (result !== undefined) publishCommitted(db, observationSink, result.receipt);
      return result?.row;
    },
    rearm(id, sessionId, at) {
      const result = transaction(() => controlAlarm(db, id, sessionId, at, "rearm"));
      if (result !== undefined) publishCommitted(db, observationSink, result.receipt);
      return result?.row;
    },
    acquire(id, expectedFence) {
      return transaction(() => {
        const updated = db
          .query(
            "UPDATE alarm SET fence = fence + 1 WHERE id = ? AND fence = ? AND status = 'armed'",
          )
          .run(id, expectedFence);
        return updated.changes === 1 ? selectAlarm(db, id) : undefined;
      });
    },
    fire(input) {
      const parsed = Alarm.Fire.parse(input);
      const result = transaction(() => fireAlarm(db, parsed));
      if (result !== undefined)
        for (const receipt of result.receipts) publishCommitted(db, observationSink, receipt);
      return result;
    },
    due(at) {
      const rows = AlarmSqlRow.array().parse(
        db
          .query("SELECT * FROM alarm WHERE status = 'armed' AND fire_at <= ? ORDER BY fire_at, id")
          .all(at),
      );
      return rows.map(decodeAlarm);
    },
  };
}

function controlAlarm(
  db: Database,
  id: string,
  sessionId: string,
  at: number,
  op: "cancel" | "rearm",
) {
  const current = selectAlarm(db, id);
  if (
    current === undefined ||
    current.sessionId !== sessionId ||
    current.kind !== "watch" ||
    (current.status !== "armed" && current.status !== "paused")
  )
    return undefined;
  const session = selectSession(db, current.sessionId);
  if (session === undefined) return undefined;
  const row: Alarm.Row = {
    ...current,
    status: op === "cancel" ? "cancelled" : "armed",
    updatedAt: at,
    fence: current.fence + 1,
    ...(op === "rearm"
      ? { epoch: current.epoch + 1, fireAt: at, notifications: 0, lastBatch: null }
      : {}),
  };
  const receipt = appendAction(
    db,
    {
      id: canonicalDigest([id, row.epoch, op]),
      parentId: id,
      sessionId: row.sessionId,
      kind: "alarm.arm",
      intent: { encodingVersion: 1, value: { op, alarmId: id, epoch: row.epoch } },
      effect: {
        encodingVersion: 1,
        value: {
          status: row.status,
          epoch: row.epoch,
          fence: row.fence,
          fireAt: row.fireAt,
          notifications: row.notifications,
          lastBatch: row.lastBatch,
        },
      },
      irreversible: true,
      ts: at,
    },
    session.revision,
  );
  if (receipt === undefined) return undefined;
  db.query(
    "UPDATE alarm SET status = ?, time_updated = ?, fire_at = ?, epoch = ?, fence = ?, notifications = ?, last_batch = ? WHERE id = ?",
  ).run(row.status, at, row.fireAt, row.epoch, row.fence, row.notifications, row.lastBatch, id);
  return { row, receipt };
}

function fireAlarm(db: Database, input: Alarm.Fire): Alarm.Fired | undefined {
  const row = selectAlarm(db, input.id);
  const occurrence = row === undefined ? undefined : alarmOccurrence(row, input);
  if (row === undefined || occurrence === undefined) return undefined;
  const session = selectSession(db, row.sessionId);
  if (session === undefined) return undefined;
  const { status, terminal } = occurrence;
  const fired = appendAction(db, alarmFired(row, input, occurrence), session.revision);
  if (fired === undefined) return undefined;
  const pending = alarmPrompt(row, input, occurrence);
  const prompt = appendAction(db, inboxAppend(pending), fired.revision);
  if (prompt === undefined) throw new Error("alarm prompt append refused");
  const inbox = insertInbox(db, pending);
  db.query(
    "UPDATE alarm SET status = ?, notifications = notifications + ?, last_batch = ?, fence = fence + ?, time_updated = ? WHERE id = ?",
  ).run(
    status,
    status === "armed" ? 1 : 0,
    terminal ? row.lastBatch : (input.batchHash ?? row.lastBatch),
    status === "armed" ? 0 : 1,
    input.at,
    row.id,
  );
  const committed = selectAlarm(db, row.id);
  if (committed === undefined) throw new Error("fired alarm disappeared");
  return { row: committed, inbox, receipts: [fired, prompt] };
}
