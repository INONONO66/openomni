import type { Database } from "bun:sqlite";
import {
  canonicalDigest,
  Inbox,
  type LedgerAction,
  type ObservationSink,
  type Storage as ProtocolStorage,
} from "@openomni/protocol";
import { ActionSqlRow, InboxSqlRow, decodeAction, decodeInbox } from "./sqlite-l0-rows.js";
import { commitInbox } from "./sqlite-l0-write.js";
import { publishCommitted } from "./sqlite-l0-observation.js";

export function createInbox(
  db: Database,
  transaction: <T>(operation: () => T) => T,
  observationSink: ObservationSink,
): ProtocolStorage.InboxSubAdapter {
  return {
    commit(input) {
      const row = Inbox.Commit.parse(input);
      const result = transaction(() => commitInbox(db, row));
      if (result === undefined) return undefined;
      for (const receipt of result.receipts) publishCommitted(db, observationSink, receipt);
      return result.committed;
    },
    receive(input) {
      const row = Inbox.Commit.parse(input);
      const received = transaction(() => {
        const existing = InboxSqlRow.nullable().parse(
          db.query("SELECT * FROM inbox WHERE id = ?").get(row.id),
        );
        if (existing !== null) {
          const committed = decodeInbox(existing);
          if (receivedDigest(committed) !== receivedDigest(row)) {
            throw new Error("message identity reused with different payload");
          }
          return { row: committed, receipt: receivedAction(db, row.id), receipts: [] };
        }
        const result = commitInbox(db, row);
        if (result === undefined) return undefined;
        return {
          row: result.committed,
          receipt: receivedAction(db, row.id),
          receipts: result.receipts,
        };
      });
      if (received === undefined) return undefined;
      for (const receipt of received.receipts) publishCommitted(db, observationSink, receipt);
      return { row: received.row, receipt: received.receipt };
    },
    list(sessionId, status) {
      const rows = InboxSqlRow.array().parse(
        status === undefined
          ? db.query("SELECT * FROM inbox WHERE session_id = ? ORDER BY ordinal").all(sessionId)
          : db
              .query("SELECT * FROM inbox WHERE session_id = ? AND status = ? ORDER BY ordinal")
              .all(sessionId, status),
      );
      return rows.map(decodeInbox);
    },
  };
}

function receivedDigest(
  row: Pick<Inbox.Row, "id" | "sessionId" | "kind" | "content" | "origin">,
): string {
  return canonicalDigest({
    id: row.id,
    sessionId: row.sessionId,
    kind: row.kind,
    content: row.content,
    origin: row.origin,
  });
}

function receivedAction(db: Database, id: string): LedgerAction.Receipt {
  const row = ActionSqlRow.nullable().parse(db.query("SELECT * FROM action WHERE id = ?").get(id));
  if (row === null) throw new Error("receiving inbox action is missing");
  const action = decodeAction(row);
  return { action, revision: action.ordinal };
}
