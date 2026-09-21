import type { Database } from "bun:sqlite";
import {
  canonicalDigest,
  Inbox,
  type LedgerAction,
  type ObservationSink,
} from "@openomni/protocol";
import { ActionSqlRow, InboxSqlRow, decodeAction, decodeInbox } from "./sqlite-l0-rows.js";
import { commitInbox } from "./sqlite-l0-write.js";
import { publishCommitted } from "./sqlite-l0-observation.js";
import { CorruptRecord, InboxCommitRefused } from "../errors";
import type { InboxWriteAdapter } from "../services";
import { writeEffect, type RefuseWrite } from "./write-effect";

export function createInbox(
  db: Database,
  transaction: <T>(operation: () => T) => T,
  observationSink: ObservationSink,
): InboxWriteAdapter {
  return {
    commit: (input) =>
      writeEffect("inbox.commit", (refuse) => {
        const result = transaction(() => {
          const row = Inbox.Commit.parse(input);
          const committed = commitInbox(db, row, refuse);
          if (committed === undefined)
            return refuse(
              new InboxCommitRefused({
                sessionId: row.sessionId,
                inboxId: row.id,
                reason: "admission",
              }),
            );
          return committed;
        });
        for (const receipt of result.receipts) publishCommitted(db, observationSink, receipt);
        return result.committed;
      }),
    receive: (input) =>
      writeEffect("inbox.receive", (refuse) => {
        const received = transaction(() => {
          const row = Inbox.Commit.parse(input);
          const existing = InboxSqlRow.nullable().parse(
            db.query("SELECT * FROM inbox WHERE id = ?").get(row.id),
          );
          if (existing !== null) {
            const committed = decodeInbox(existing);
            if (receivedDigest(committed) !== receivedDigest(row)) {
              return refuse(
                new InboxCommitRefused({
                  sessionId: row.sessionId,
                  inboxId: row.id,
                  reason: "identity",
                }),
              );
            }
            return { row: committed, receipt: receivedAction(db, row.id, refuse), receipts: [] };
          }
          const result = commitInbox(db, row, refuse);
          if (result === undefined)
            return refuse(
              new InboxCommitRefused({
                sessionId: row.sessionId,
                inboxId: row.id,
                reason: "admission",
              }),
            );
          return {
            row: result.committed,
            receipt: receivedAction(db, row.id, refuse),
            receipts: result.receipts,
          };
        });
        for (const receipt of received.receipts) publishCommitted(db, observationSink, receipt);
        return { row: received.row, receipt: received.receipt };
      }),
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

function receivedAction(db: Database, id: string, refuse: RefuseWrite): LedgerAction.Receipt {
  const row = ActionSqlRow.nullable().parse(db.query("SELECT * FROM action WHERE id = ?").get(id));
  if (row === null) return refuse(new CorruptRecord({ operation: "inbox.receive", id }));
  const action = decodeAction(row);
  return { action, revision: action.ordinal };
}
