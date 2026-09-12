import { z } from "zod";
import { parseStoredJson } from "./sqlite-json-data";
import { Alarm, Inbox, LedgerAction, LedgerSession, PolicyRow } from "@openomni/protocol";

const actionRowSchema = LedgerAction.Node;

const inboxRowSchema = Inbox.Row;

const alarmRowSchema = Alarm.Row;

const policyRowSchema = PolicyRow.Row;

export const ActionSqlRow = z.object({
  id: z.string(),
  parent_id: z.string().nullable(),
  session_id: z.string(),
  kind: z.string(),
  intent: z.string(),
  effect: z.string(),
  revert: z.string().nullable(),
  irreversible: z.union([z.literal(0), z.literal(1)]),
  encoding_version: z.number(),
  ts: z.number(),
  ordinal: z.number(),
});

export type ActionSqlRow = z.infer<typeof ActionSqlRow>;

/** SQLite column shape; decodeSession validates the canonical row once on read. */
export interface SessionSqlRow {
  id: string;
  parent_id: string | null;
  role: string | null;
  lease_owner: string | null;
  lease_fence: number;
  lease_expires_at: number | null;
  revision: number;
  state: string;
  tools_generation: number;
  system_hash: string;
  policy_generation: number;
}

export const InboxSqlRow = z.object({
  id: z.string(),
  session_id: z.string(),
  kind: z.string(),
  content: z.string(),
  origin: z.string(),
  status: z.string(),
  consumed_by: z.string().nullable(),
  consumed_at: z.number().nullable(),
  time_created: z.number(),
  ordinal: z.number(),
  encoding_version: z.number(),
});

export type InboxSqlRow = z.infer<typeof InboxSqlRow>;

export const AlarmSqlRow = z.object({
  epoch: z.number(),
  fence: z.number(),
  last_batch: z.string().nullable(),
  notifications: z.number(),
  id: z.string(),
  session_id: z.string(),
  kind: z.string(),
  fire_at: z.number(),
  spec: z.string().nullable(),
  status: z.string(),
  time_created: z.number(),
  time_updated: z.number(),
  encoding_version: z.number(),
});

export type AlarmSqlRow = z.infer<typeof AlarmSqlRow>;

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
  if (row.role === null) throw new Error(`session ${row.id} has no L0 role`);
  return LedgerSession.Row.parse({
    id: row.id,
    parentId: row.parent_id,
    role: row.role,
    leaseOwner: row.lease_owner,
    leaseFence: row.lease_fence,
    leaseExpiresAt: row.lease_expires_at,
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

export function decodeInbox(row: InboxSqlRow): Inbox.Row {
  return inboxRowSchema.parse({
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    content: row.content,
    origin: { encodingVersion: row.encoding_version, value: parseStoredJson(row.origin) },
    status: row.status,
    consumedBy: row.consumed_by,
    consumedAt: row.consumed_at,
    createdAt: row.time_created,
    ordinal: row.ordinal,
  });
}

export function decodeAlarm(row: AlarmSqlRow): Alarm.Row {
  return alarmRowSchema.parse({
    epoch: row.epoch,
    fence: row.fence,
    lastBatch: row.last_batch,
    notifications: row.notifications,
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    fireAt: row.fire_at,
    ...(row.spec === null
      ? {}
      : { spec: { encodingVersion: row.encoding_version, value: parseStoredJson(row.spec) } }),
    status: row.status,
    createdAt: row.time_created,
    updatedAt: row.time_updated,
  });
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
