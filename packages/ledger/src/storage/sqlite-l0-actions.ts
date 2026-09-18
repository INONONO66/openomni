import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
  LedgerAction,
  type ObservationSink,
  type Storage as ProtocolStorage,
} from "@openomni/protocol";
import { computeActionHash, GENESIS_PREV_HASH } from "./l0-hash";
import { ActionSqlRow, decodeAction } from "./sqlite-l0-rows.js";
import { appendAction } from "./sqlite-l0-write.js";
import { publishCommitted } from "./sqlite-l0-observation.js";

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
    verifyChain(sessionId) {
      return verifyChain(db, sessionId);
    },
    tree(sessionId) {
      const rows = ActionSqlRow.array().parse(
        db
          .query(
            `SELECT id, parent_id, session_id, kind, intent, effect, revert,
                  irreversible, encoding_version, ts, ordinal, prev_hash, action_hash
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
                  irreversible, encoding_version, ts, ordinal, prev_hash, action_hash
           FROM action WHERE session_id = ? AND ordinal > ? ORDER BY ordinal LIMIT ?`,
          )
          .all(sessionId, afterRevision, limit),
      );
      return rows.map(decodeAction);
    },
  };
}

/** Any stored representation SQLite admits into a TEXT hash column; only a string can verify. */
const HashCell = z.union([z.string(), z.null(), z.number(), z.bigint(), z.instanceof(Uint8Array)]);

function describeHashCell(cell: z.infer<typeof HashCell>): string {
  if (cell instanceof Uint8Array) return `blob:${Buffer.from(cell).toString("hex")}`;
  return String(cell);
}

const VerifyRow = ActionSqlRow.extend({ prev_hash: HashCell, action_hash: HashCell });

export function verifyChain(db: Database, sessionId: string): LedgerAction.ChainVerdict {
  const rows = VerifyRow.array().parse(
    db.query("SELECT * FROM action WHERE session_id = ? ORDER BY ordinal").all(sessionId),
  );
  let prevHash = GENESIS_PREV_HASH;
  for (const row of rows) {
    if (row.prev_hash !== prevHash) {
      return {
        kind: "broken",
        ordinal: row.ordinal,
        expected: prevHash,
        actual: describeHashCell(row.prev_hash),
      };
    }
    const expected = computeActionHash({ ...row, prev_hash: prevHash });
    if (row.action_hash !== expected) {
      return { kind: "broken", ordinal: row.ordinal, expected, actual: describeHashCell(row.action_hash) };
    }
    prevHash = expected;
  }
  return { kind: "intact", head: rows.length === 0 ? null : prevHash, length: rows.length };
}
