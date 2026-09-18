import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { ActionSqlRowSafeIntegers, type ActionSqlRow } from "./sqlite-l0-rows";

export const ACTION_HASH_MIGRATION = "0039_action_hash_chain/migration.sql";
export const GENESIS_PREV_HASH = "openomni:l0:genesis:v1";

export function computeActionHash(input: Omit<ActionSqlRow, "action_hash">): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.prev_hash,
        input.id,
        input.parent_id,
        input.session_id,
        input.kind,
        input.intent,
        input.effect,
        input.revert,
        input.irreversible,
        input.encoding_version,
        input.ts,
        input.ordinal,
      ]),
    )
    .digest("hex");
}

export function computeDecisionFactHash(input: {
  key: string;
  type: string;
  data: string;
  timeCreated: number;
}): string {
  return createHash("sha256")
    .update(JSON.stringify([input.key, input.type, input.data, input.timeCreated]))
    .digest("hex");
}

export class ActionChainMigrationError extends Error {
  readonly reason = "non_contiguous_ordinal";

  constructor(readonly sessionId: string) {
    super(`action chain migration refused: ${sessionId}`);
    this.name = "ActionChainMigrationError";
  }
}

export function backfillActionHashes(db: Database): void {
  const rows = ActionSqlRowSafeIntegers.omit({ prev_hash: true, action_hash: true })
    .array()
    .parse(db.query("SELECT * FROM action ORDER BY session_id, ordinal").all());
  let sessionId: string | null = null;
  let ordinal = 0;
  for (const row of rows) {
    if (row.session_id !== sessionId) {
      sessionId = row.session_id;
      ordinal = 0;
    }
    ordinal += 1;
    if (row.ordinal !== ordinal) throw new ActionChainMigrationError(row.session_id);
  }
  sessionId = null;
  let prevHash = GENESIS_PREV_HASH;
  for (const row of rows) {
    if (row.session_id !== sessionId) {
      sessionId = row.session_id;
      prevHash = GENESIS_PREV_HASH;
    }
    const actionHash = computeActionHash({ ...row, prev_hash: prevHash });
    db.query("UPDATE action SET prev_hash = ?, action_hash = ? WHERE id = ?").run(
      prevHash,
      actionHash,
      row.id,
    );
    prevHash = actionHash;
  }
  db.run("CREATE UNIQUE INDEX IF NOT EXISTS action_hash_unique ON action(action_hash)");
}
