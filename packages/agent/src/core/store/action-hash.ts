import { createHash } from "node:crypto";
import type { ActionSqlRow } from "./storage/sqlite-l0-rows.js";

export const GENESIS_PREV_HASH = "openomni:l0:genesis:v1";

/** Canonical l0 chain hash over the committed action row (leaf module so the
 * session-file kernel and the SQLite write plane share it without a cycle). */
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
