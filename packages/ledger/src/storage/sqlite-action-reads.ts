import type { Database } from "bun:sqlite";
import type { Storage } from "@openomni/protocol";
import { z } from "zod";
import { ActionSqlRow, decodeAction } from "./sqlite-l0-rows";

const pageSize = z.number().int().positive().max(256);
type Reads = Pick<
  Storage.ActionSubAdapter,
  | "priorModelAttempt"
  | "generationFor"
  | "turnTerminalFor"
  | "latestTurnTerminal"
  | "latestTurnUpdate"
  | "turnIntentsPage"
  | "turnTailPage"
  | "openTurnsPage"
  | "resultFor"
  | "requestInputById"
  | "requestStateById"
  | "guardedOperationsPage"
  | "requestStatesPage"
  | "outboundStatesPage"
  | "openOperationsPage"
  | "operationChildrenPage"
>;

function decodeOne(value: ActionSqlRow | null) {
  const row = ActionSqlRow.nullable().parse(value);
  return row === null ? undefined : decodeAction(row);
}

function decodeRows(values: ActionSqlRow[]) {
  return ActionSqlRow.array().parse(values).map(decodeAction);
}

/** Each semantic port owns a literal statement and explicit bindings. */
export function createActionReads(db: Database): Reads {
  return {
    priorModelAttempt(sessionId, turnId) {
      return decodeOne(
        db
          .query<ActionSqlRow, [string, string, string]>(`
        SELECT a.* FROM action a JOIN action llm ON llm.id = a.parent_id
        LEFT JOIN action turn ON turn.id = llm.parent_id
        WHERE a.session_id = ? AND a.kind = 'attempt'
          AND json_extract(a.intent, '$.phase') = 'intent'
          AND json_extract(a.intent, '$.op') = 'chat' AND llm.parent_id != ?
          AND coalesce(json_extract(turn.intent, '$.turnId'), '') != ?
        ORDER BY a.ordinal DESC LIMIT 1`)
          .get(sessionId, turnId, turnId),
      );
    },
    generationFor(sessionId, generation) {
      return decodeOne(
        db
          .query<ActionSqlRow, [string, number]>(`
        SELECT * FROM action WHERE session_id = ? AND kind = 'session.configure'
          AND json_valid(effect) AND json_extract(effect, '$.snapshot.generation') = ?
        ORDER BY ordinal DESC LIMIT 1`)
          .get(sessionId, generation),
      );
    },
    turnTerminalFor(sessionId, turnId) {
      return decodeOne(
        db
          .query<ActionSqlRow, [string, string]>(`
        SELECT * FROM action WHERE session_id = ? AND kind = 'turn'
          AND json_extract(effect, '$.phase') = 'terminal'
          AND json_extract(effect, '$.turnId') = ?
        ORDER BY ordinal DESC LIMIT 1`)
          .get(sessionId, turnId),
      );
    },
    latestTurnTerminal(sessionId) {
      return decodeOne(
        db
          .query<ActionSqlRow, [string]>(`
        SELECT * FROM action WHERE session_id = ? AND kind = 'turn'
          AND json_extract(effect, '$.phase') = 'terminal'
        ORDER BY ordinal DESC LIMIT 1`)
          .get(sessionId),
      );
    },
    latestTurnUpdate(sessionId, turnId) {
      return decodeOne(
        db
          .query<ActionSqlRow, [string, string, string]>(`
        SELECT * FROM action WHERE session_id = ? AND kind = 'turn'
          AND (json_extract(intent, '$.turnId') = ? OR json_extract(effect, '$.turnId') = ?)
        ORDER BY ordinal DESC LIMIT 1`)
          .get(sessionId, turnId, turnId),
      );
    },
    turnIntentsPage(sessionId, beforeRevision, limit) {
      return decodeRows(
        db
          .query<ActionSqlRow, [string, number, number]>(`
        SELECT * FROM action WHERE session_id = ? AND kind = 'turn'
          AND json_extract(intent, '$.phase') = 'intent' AND ordinal < ?
        ORDER BY ordinal DESC LIMIT ?`)
          .all(sessionId, beforeRevision, pageSize.parse(limit)),
      );
    },
    turnTailPage(sessionId, cursor, limit) {
      return decodeRows(
        db
          .query<ActionSqlRow, [string, number, number]>(`
        SELECT * FROM action WHERE session_id = ? AND kind IN ('turn', 'inbox.deliver')
          AND ordinal > ?
        ORDER BY ordinal LIMIT ?`)
          .all(sessionId, cursor, pageSize.parse(limit)),
      );
    },
    openTurnsPage(sessionId, cursor, limit) {
      return decodeRows(
        db
          .query<ActionSqlRow, [string, number, string, number]>(`
        SELECT a.* FROM action a WHERE a.session_id = ? AND a.kind = 'turn'
          AND json_extract(a.intent, '$.phase') = 'intent' AND a.ordinal > ?
          AND a.id NOT IN (SELECT json_extract(effect, '$.turnId') FROM action
            WHERE session_id = ? AND kind = 'turn'
            AND json_extract(effect, '$.phase') = 'terminal'
            AND json_extract(effect, '$.turnId') IS NOT NULL)
        ORDER BY a.ordinal LIMIT ?`)
          .all(sessionId, cursor, sessionId, pageSize.parse(limit)),
      );
    },
    resultFor(sessionId, parentId) {
      return decodeOne(
        db
          .query<ActionSqlRow, [string, string]>(`
        SELECT * FROM action WHERE session_id = ? AND parent_id = ? AND kind != 'fold.checkpoint'
          AND json_extract(effect, '$.phase') = 'result'
        ORDER BY ordinal DESC LIMIT 1`)
          .get(sessionId, parentId),
      );
    },
    requestInputById(sessionId, inputId) {
      return decodeOne(
        db
          .query<ActionSqlRow, [string, string]>(`
        SELECT * FROM action WHERE session_id = ? AND kind IN ('request', 'reply')
          AND json_extract(intent, '$.inputId') = ?
        ORDER BY ordinal DESC LIMIT 1`)
          .get(sessionId, inputId),
      );
    },
    requestStateById(id) {
      return decodeOne(
        db
          .query<ActionSqlRow, [string]>(`
        SELECT * FROM action WHERE kind IN ('request', 'reply')
          AND json_extract(effect, '$.phase') = 'state'
          AND json_extract(effect, '$.request.requestId') = ?
        ORDER BY rowid DESC LIMIT 1`)
          .get(id),
      );
    },
    requestStatesPage(sessionId, cursor, limit) {
      return decodeRows(
        db
          .query<ActionSqlRow, [string | null, string | null, string, number]>(`
        SELECT a.* FROM action a WHERE a.kind IN ('request', 'reply')
          AND json_extract(a.effect, '$.phase') = 'state'
          AND (? IS NULL OR a.session_id = ?) AND json_extract(a.effect, '$.request.requestId') > ?
          AND a.rowid = (SELECT max(b.rowid) FROM action b WHERE b.kind IN ('request', 'reply')
            AND json_extract(b.effect, '$.phase') = 'state'
            AND json_extract(b.effect, '$.request.requestId') = json_extract(a.effect, '$.request.requestId'))
        ORDER BY json_extract(a.effect, '$.request.requestId') LIMIT ?`)
          .all(sessionId ?? null, sessionId ?? null, cursor, pageSize.parse(limit)),
      );
    },
    outboundStatesPage(sessionId, cursor, limit) {
      return decodeRows(
        db
          .query<ActionSqlRow, [string, string, number]>(`
        SELECT a.* FROM action a WHERE a.session_id = ? AND a.kind = 'outbound'
          AND coalesce(json_extract(a.effect, '$.outbound.message.messageId'), a.id) > ?
          AND (json_extract(a.effect, '$.outbound.message.messageId') IS NULL
            OR a.ordinal = (SELECT max(b.ordinal) FROM action b WHERE b.session_id = a.session_id
              AND b.kind = 'outbound' AND json_extract(b.effect, '$.outbound.message.messageId') =
                json_extract(a.effect, '$.outbound.message.messageId')))
        ORDER BY coalesce(json_extract(a.effect, '$.outbound.message.messageId'), a.id) LIMIT ?`)
          .all(sessionId, cursor, pageSize.parse(limit)),
      );
    },
    guardedOperationsPage(sessionId, turnId, cursor, limit) {
      return decodeRows(
        db
          .query<ActionSqlRow, [string, number, string, number]>(`
        SELECT a.* FROM action a WHERE a.session_id = ? AND a.ordinal > ?
          AND EXISTS (SELECT 1 FROM action member WHERE member.session_id = a.session_id
            AND member.kind = 'tool' AND json_extract(member.intent, '$.phase') = 'intent'
            AND (a.id = member.id OR a.parent_id = member.id)
            AND EXISTS (SELECT 1 FROM action guarded WHERE guarded.session_id = member.session_id
              AND guarded.kind = 'tool' AND json_extract(guarded.intent, '$.turnId') = ?
              AND json_extract(guarded.intent, '$.approvalRequired') = 1
              AND json_extract(guarded.intent, '$.waveId') = json_extract(member.intent, '$.waveId'))
            AND EXISTS (SELECT 1 FROM action unfinished WHERE unfinished.session_id = member.session_id
              AND unfinished.kind = 'tool' AND json_extract(unfinished.intent, '$.phase') = 'intent'
              AND json_extract(unfinished.intent, '$.waveId') = json_extract(member.intent, '$.waveId')
              AND NOT EXISTS (SELECT 1 FROM action settled WHERE settled.session_id = unfinished.session_id
                AND settled.parent_id = unfinished.id AND settled.kind != 'fold.checkpoint'
                AND json_extract(settled.effect, '$.phase') = 'result')))
        ORDER BY a.ordinal LIMIT ?`)
          .all(sessionId, cursor, turnId, pageSize.parse(limit)),
      );
    },
    openOperationsPage(sessionId, turnId, cursor, limit) {
      return decodeRows(
        db
          .query<ActionSqlRow, [string, number, string, string, string, number]>(`
        SELECT a.* FROM action a WHERE a.session_id = ? AND a.ordinal > ?
          AND a.kind IN ('llm', 'message', 'compaction', 'tool')
          AND json_extract(a.intent, '$.phase') = 'intent'
          AND (a.parent_id = ? OR json_extract(a.intent, '$.turnId') = ?
            OR a.parent_id IN (SELECT id FROM action WHERE session_id = a.session_id AND kind = 'turn'
              AND json_extract(intent, '$.phase') = 'resume' AND json_extract(intent, '$.turnId') = ?))
          AND NOT EXISTS (SELECT 1 FROM action WHERE session_id = a.session_id AND parent_id = a.id
            AND kind != 'fold.checkpoint' AND json_extract(effect, '$.phase') = 'result')
          AND (a.kind != 'tool' OR NOT EXISTS (SELECT 1 FROM action guarded
            WHERE guarded.session_id = a.session_id
              AND json_extract(guarded.intent, '$.waveId') = json_extract(a.intent, '$.waveId')
              AND json_extract(guarded.intent, '$.approvalRequired') = 1))
        ORDER BY a.ordinal LIMIT ?`)
          .all(sessionId, cursor, turnId, turnId, turnId, pageSize.parse(limit)),
      );
    },
    operationChildrenPage(sessionId, parentId, cursor, limit) {
      return decodeRows(
        db
          .query<ActionSqlRow, [string, string, number, number]>(`
        SELECT * FROM action WHERE session_id = ? AND parent_id = ? AND ordinal > ?
        ORDER BY ordinal LIMIT ?`)
          .all(sessionId, parentId, cursor, pageSize.parse(limit)),
      );
    },
  };
}
