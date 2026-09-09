import type { Database } from "bun:sqlite";
import {
  LedgerAction,
  type ObservationSink,
  type Storage as ProtocolStorage,
} from "@openomni/protocol";
import { ActionSqlRow, decodeAction } from "./sqlite-l0-rows";
import { appendAction } from "./sqlite-l0-write";
import { publishCommitted } from "./sqlite-l0-observation";

export function createActions(
  db: Database,
  transaction: <T>(operation: () => T) => T,
  observationSink: ObservationSink,
): ProtocolStorage.ActionSubAdapter {
  return {
    append(input, expectedRevision) {
      const parsed = LedgerAction.Append.parse(input);
      const receipt = transaction(() => appendAction(db, parsed, expectedRevision));
      if (receipt !== undefined) publishCommitted(db, observationSink, receipt);
      return receipt;
    },
    tree(sessionId) {
      const rows = ActionSqlRow.array().parse(
        db
          .query(
            `SELECT id, parent_id, session_id, kind, intent, effect, revert,
                  irreversible, encoding_version, ts, ordinal
           FROM action WHERE session_id = ? ORDER BY ordinal`,
          )
          .all(sessionId),
      );
      return rows.map(decodeAction);
    },
    range(sessionId, afterRevision, limit) {
      const rows = ActionSqlRow.array().parse(
        db
          .query(
            `SELECT id, parent_id, session_id, kind, intent, effect, revert,
                  irreversible, encoding_version, ts, ordinal
           FROM action WHERE session_id = ? AND ordinal > ? ORDER BY ordinal LIMIT ?`,
          )
          .all(sessionId, afterRevision, limit),
      );
      return rows.map(decodeAction);
    },
  };
}
