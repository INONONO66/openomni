import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
  LedgerAction,
  SessionTransition,
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
    actionById(id) {
      const row = ActionSqlRow.nullable().parse(
        db.query("SELECT * FROM action WHERE id = ?").get(id),
      );
      return row === null ? undefined : decodeAction(row);
    },
    configurationActions(sessionId) {
      const rows = ActionSqlRow.array().parse(
        db
          .query(
            "SELECT * FROM action WHERE session_id = ? AND kind IN ('session.configure') ORDER BY ordinal",
          )
          .all(sessionId),
      );
      return rows.map(decodeAction);
    },
    policyDecisionRuleIds(sessionId, inputHash) {
      const row = z
        .object({ intent: z.string() })
        .nullable()
        .parse(
          db
            .query(
              `SELECT intent FROM action WHERE session_id = ? AND kind = 'policy.decision'
           AND json_extract(intent, '$.inputHash') = ? ORDER BY ordinal DESC LIMIT 1`,
            )
            .get(sessionId, inputHash),
        );
      if (row === null) return undefined;
      const parsed = z
        .object({ matchedRuleIds: z.array(z.string()) })
        .safeParse(JSON.parse(row.intent));
      if (!parsed.success)
        throw new Error("invalid message decision rule identity", { cause: parsed.error });
      return parsed.data.matchedRuleIds;
    },
    messageActionByPlatformId(sessionId, messageId) {
      const row = ActionSqlRow.nullable().parse(
        db
          .query(
            `SELECT * FROM action WHERE session_id = ? AND kind = 'message'
           AND json_extract(intent, '$.value.messageId') = ? ORDER BY ordinal LIMIT 1`,
          )
          .get(sessionId, messageId),
      );
      return row === null ? undefined : decodeAction(row);
    },
    outboundReceipt(destinationSessionId, messageId) {
      const rows = ActionSqlRow.array().parse(
        db
          .query(
            `SELECT * FROM action WHERE session_id = ? AND kind = 'prompt' AND id = ?
           UNION ALL
           SELECT * FROM action WHERE session_id = ? AND kind = 'reply'
           AND json_extract(effect, '$.answer.outbound.messageId') = ? ORDER BY ordinal`,
          )
          .all(destinationSessionId, messageId, destinationSessionId, messageId),
      );
      for (const row of rows) {
        const action = decodeAction(row);
        if (action.kind === "reply") {
          const effect = action.effect.value;
          if (effect === null || typeof effect !== "object" || Array.isArray(effect)) continue;
          const answer = SessionTransition.Answer.safeParse(effect.answer);
          if (!answer.success) continue;
        }
        return { action, revision: action.ordinal };
      }
      return undefined;
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
      return {
        kind: "broken",
        ordinal: row.ordinal,
        expected,
        actual: describeHashCell(row.action_hash),
      };
    }
    prevHash = expected;
  }
  return { kind: "intact", head: rows.length === 0 ? null : prevHash, length: rows.length };
}
