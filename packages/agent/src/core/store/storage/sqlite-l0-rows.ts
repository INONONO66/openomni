import { z } from "zod";
import { LedgerInvariant } from "../errors";
import { parseStoredJson, SqliteCount, SqliteEpochMs } from "../json";
import { LedgerAction, LedgerSession, PolicyRow } from "@openomni/protocol";

const actionRowSchema = LedgerAction.Node;

const policyRowSchema = PolicyRow.Row;

export const ActionSqlRow = z.object({
  id: z.string(),
  parent_id: z.string().nullable(),
  session_id: z.string(),
  kind: z.string(),
  intent: z.string(),
  effect: z.string(),
  revert: z.string().nullable(),
  // Hot read path (tree/range decode every row): single-layer checks instead
  // of union + transform + pipe stacks (SqliteCount cost a >20% tree/history
  // bench regression here). The production adapter never enables safeIntegers,
  // so these columns arrive as numbers; an unexpected bigint fails closed.
  irreversible: z.union([z.literal(0), z.literal(1)]),
  encoding_version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  // Mirrors protocol EpochMs: finite, non-negative, fractional allowed.
  ts: z.number().finite().nonnegative(),
  ordinal: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  prev_hash: z.string(),
  action_hash: z.string(),
});

export type ActionSqlRow = z.infer<typeof ActionSqlRow>;

/**
 * Cold migration/verification boundary: archive tooling opens databases with
 * safeIntegers, so INTEGER columns may arrive as bigint and are folded to the
 * same admitted numbers the hot schema accepts.
 */
export const ActionSqlRowSafeIntegers = ActionSqlRow.extend({
  irreversible: SqliteCount.pipe(z.union([z.literal(0), z.literal(1)])),
  encoding_version: SqliteCount,
  ts: SqliteEpochMs,
  ordinal: SqliteCount,
});

export const SessionSqlRow = z.object({
  id: z.string(),
  parent_id: z.string().nullable(),
  role: z.string().nullable(),
  lease_owner: z.string().nullable(),
  lease_fence: z.number(),
  revision: z.number(),
  state: z.string(),
  tools_generation: z.number(),
  system_hash: z.string(),
  policy_generation: z.number(),
});

export type SessionSqlRow = z.infer<typeof SessionSqlRow>;

export const PolicySqlRow = z.object({
  name: z.string(),
  kind: z.string(),
  phase: z.string(),
  match: z.string(),
  verdict: z.string(),
  priority: z.number(),
  generation: z.number(),
  encoding_version: z.number(),
});

export type PolicySqlRow = z.infer<typeof PolicySqlRow>;

export function decodeSession(row: SessionSqlRow): LedgerSession.Row {
  if (row.role === null)
    throw new LedgerInvariant({ operation: "session.decode", message: `session ${row.id} has no L0 role` });
  return LedgerSession.Row.parse({
    id: row.id,
    parentId: row.parent_id,
    role: row.role,
    fenceOwner: row.lease_owner,
    fence: row.lease_fence,
    revision: row.revision,
    state: row.state,
    toolsGeneration: row.tools_generation,
    systemHash: row.system_hash,
    policyGeneration: row.policy_generation,
  });
}

export function decodeAction(row: ActionSqlRow): LedgerAction.Node {
  const common = {
    id: row.id,
    parentId: row.parent_id,
    sessionId: row.session_id,
    kind: row.kind,
    intent: { encodingVersion: row.encoding_version, value: parseStoredJson(row.intent) },
    effect: { encodingVersion: row.encoding_version, value: parseStoredJson(row.effect) },
    ts: row.ts,
    ordinal: row.ordinal,
    prevHash: row.prev_hash,
    actionHash: row.action_hash,
  };
  return actionRowSchema.parse(
    row.revert === null
      ? { ...common, irreversible: row.irreversible === 1 }
      : {
          ...common,
          revert: { encodingVersion: row.encoding_version, value: parseStoredJson(row.revert) },
        },
  );
}

export function decodePolicy(row: PolicySqlRow): PolicyRow.Row {
  return policyRowSchema.parse({
    name: row.name,
    kind: row.kind,
    phase: row.phase,
    match: { encodingVersion: row.encoding_version, value: parseStoredJson(row.match) },
    verdict: { encodingVersion: row.encoding_version, value: parseStoredJson(row.verdict) },
    priority: row.priority,
    generation: row.generation,
  });
}
