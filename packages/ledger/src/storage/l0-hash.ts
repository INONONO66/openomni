import { createHash } from "node:crypto";
import type { ActionSqlRow } from "./sqlite-l0-rows";

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
