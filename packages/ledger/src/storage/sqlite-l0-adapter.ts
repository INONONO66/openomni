import type { Database } from "bun:sqlite";
import {
  Alarm,
  Deadline,
  Inbox,
  LedgerAction,
  LedgerSession,
  PolicyRow,
  L0Observation,
  type ObservationSink,
  type Storage as ProtocolStorage,
} from "@openomni/protocol";
import { alarmAppend, inboxAppend } from "./l0-action-builders.js";

const actionRowSchema = LedgerAction.Node;
const inboxRowSchema = Inbox.Row;
const alarmRowSchema = Alarm.Row;
const policyRowSchema = PolicyRow.Row;

interface ActionSqlRow {
  id: string;
  parent_id: string | null;
  session_id: string;
  kind: string;
  intent: string;
  effect: string;
  revert: string | null;
  irreversible: number;
  encoding_version: number;
  ts: number;
  ordinal: number;
}

interface SessionSqlRow {
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

interface InboxSqlRow {
  id: string;
  session_id: string;
  kind: string;
  content: string;
  origin: string;
  status: string;
  consumed_by: string | null;
  consumed_at: number | null;
  time_created: number;
  ordinal: number;
  encoding_version: number;
}

interface AlarmSqlRow {
  id: string;
  session_id: string;
  kind: string;
  fire_at: number;
  spec: string | null;
  status: string;
  time_created: number;
  time_updated: number;
  encoding_version: number;
}

interface PolicySqlRow {
  name: string;
  kind: string;
  phase: string;
  match: string;
  verdict: string;
  priority: number;
  generation: number;
  encoding_version: number;
}

export interface SqliteL0Adapters {
  sessions: ProtocolStorage.SessionLedgerSubAdapter;
  actions: ProtocolStorage.ActionSubAdapter;
  inbox: ProtocolStorage.InboxSubAdapter;
  alarms: ProtocolStorage.AlarmSubAdapter;
  policies: ProtocolStorage.PolicyRowSubAdapter;
}

export function createSqliteL0Adapters(
  db: Database,
  transaction: <T>(operation: () => T) => T,
  observationSink: ObservationSink,
): SqliteL0Adapters {
  const sessions = createSessions(db, transaction, observationSink);
  const actions = createActions(db, transaction, observationSink);
  const inbox = createInbox(db, transaction, observationSink);
  return {
    sessions,
    actions,
    inbox,
    alarms: createAlarms(db, transaction, observationSink),
    policies: createPolicies(db),
  };
}

function createSessions(
  db: Database,
  transaction: <T>(operation: () => T) => T,
  observationSink: ObservationSink,
): ProtocolStorage.SessionLedgerSubAdapter {
  return {
    create(row) {
      return transaction(() => insertSession(db, LedgerSession.Row.parse(row)));
    },
    materialize(input) {
      const parsed = LedgerSession.Materialize.parse(input);
      if (
        parsed.initialAction.sessionId !== parsed.row.id ||
        parsed.initialAction.kind !== "session.configure" ||
        parsed.initialAction.parentId !== null ||
        parsed.row.revision !== 0
      ) {
        return undefined;
      }
      const result = transaction(() => {
        if (!insertSession(db, parsed.row)) {
          const existing = selectSessionSql(db, parsed.row.id);
          if (existing === undefined) return undefined;
          if (existing.role !== null) {
            return { created: false as const, row: decodeSession(existing) };
          }
          const promoted = db
            .query(
              `UPDATE session SET parent_id = ?, role = ?, lease_owner = ?, lease_fence = ?,
                 lease_expires_at = ?, state = ?, tools_generation = ?, system_hash = ?,
                 policy_generation = ?
               WHERE id = ? AND role IS NULL AND revision = 0`,
            )
            .run(
              parsed.row.parentId,
              parsed.row.role,
              parsed.row.leaseOwner,
              parsed.row.leaseFence,
              parsed.row.leaseExpiresAt,
              parsed.row.state,
              parsed.row.toolsGeneration,
              parsed.row.systemHash,
              parsed.row.policyGeneration,
              parsed.row.id,
            );
          if (promoted.changes !== 1) return undefined;
        }
        const receipt = appendAction(db, parsed.initialAction, 0);
        if (receipt === undefined) throw new Error("initial session configuration was refused");
        const row = selectSession(db, parsed.row.id);
        if (row === undefined) throw new Error("materialized session disappeared");
        return { created: true as const, row, receipt };
      });
      if (result?.created === true) publishCommitted(observationSink, result.receipt);
      return result;
    },
    get: (id) => selectSession(db, id),
    list() {
      const rows = db
        .query(`${sessionSelect} WHERE role IS NOT NULL ORDER BY id`)
        .all() as SessionSqlRow[];
      return rows.map(decodeSession);
    },
    acquireLease(input) {
      const request = LedgerSession.AcquireLease.parse(input);
      return transaction(() => {
        const current = selectSession(db, request.sessionId);
        if (current === undefined) return undefined;
        if (current.leaseFence !== request.expectedFence) {
          return {
            ok: false as const,
            reason: "stale" as const,
            currentFence: current.leaseFence,
          };
        }
        if (
          current.leaseOwner !== null &&
          current.leaseOwner !== request.owner &&
          current.leaseExpiresAt !== null &&
          !Deadline.isExpired(request.now, current.leaseExpiresAt)
        ) {
          return {
            ok: false as const,
            reason: "held" as const,
            holder: current.leaseOwner,
            expiresAt: current.leaseExpiresAt,
          };
        }
        const fence = current.leaseFence + 1;
        const updated = db
          .query(
            `UPDATE session SET lease_owner = ?, lease_fence = ?, lease_expires_at = ?
             WHERE id = ? AND lease_fence = ? AND role IS NOT NULL
               AND (lease_owner IS NULL OR lease_owner = ? OR lease_expires_at <= ?)`,
          )
          .run(
            request.owner,
            fence,
            request.expiresAt,
            request.sessionId,
            request.expectedFence,
            request.owner,
            request.now,
          );
        if (updated.changes !== 1) {
          const latest = selectSession(db, request.sessionId);
          if (latest === undefined) return undefined;
          return {
            ok: false as const,
            reason: "stale" as const,
            currentFence: latest.leaseFence,
          };
        }
        return { ok: true as const, fence };
      });
    },
    renewLease(input) {
      const request = LedgerSession.RenewLease.parse(input);
      return transaction(
        () =>
          db
            .query(
              `UPDATE session SET lease_expires_at = ?
               WHERE id = ? AND lease_owner = ? AND lease_fence = ?
                 AND lease_expires_at > ? AND role IS NOT NULL`,
            )
            .run(request.expiresAt, request.sessionId, request.owner, request.fence, request.now)
            .changes === 1,
      );
    },
    commit(input) {
      const request = LedgerSession.Commit.parse(input);
      let outcome: LedgerSession.CommitResult | undefined;
      try {
        outcome = transaction(() => commitSession(db, request));
      } catch (error) {
        if (error instanceof SessionCommitRefused) outcome = error.result;
        else throw error;
      }
      if (outcome?.ok === true) {
        for (const receipt of outcome.receipts) publishCommitted(observationSink, receipt);
      }
      return outcome;
    },
  };
}

const sessionSelect = `SELECT id, parent_id, role, lease_owner, lease_fence,
  lease_expires_at, revision, state, tools_generation, system_hash, policy_generation FROM session`;

function insertSession(db: Database, row: LedgerSession.Row): boolean {
  const result = db
    .query(
      `INSERT INTO session (
         id, data, time_created, time_updated, parent_id, role, lease_owner,
         lease_fence, lease_expires_at, revision, state, tools_generation,
         system_hash, policy_generation
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(
      row.id,
      JSON.stringify(l0SessionInfo(row)),
      0,
      0,
      row.parentId,
      row.role,
      row.leaseOwner,
      row.leaseFence,
      row.leaseExpiresAt,
      row.revision,
      row.state,
      row.toolsGeneration,
      row.systemHash,
      row.policyGeneration,
    );
  return result.changes === 1;
}

function selectSessionSql(db: Database, id: string): SessionSqlRow | undefined {
  const row = db.query(`${sessionSelect} WHERE id = ?`).get(id) as SessionSqlRow | null;
  return row === null ? undefined : row;
}

function selectSession(db: Database, id: string): LedgerSession.Row | undefined {
  const row = selectSessionSql(db, id);
  return row === undefined ? undefined : decodeSession(row);
}

function createActions(
  db: Database,
  transaction: <T>(operation: () => T) => T,
  observationSink: ObservationSink,
): ProtocolStorage.ActionSubAdapter {
  return {
    append(input, expectedRevision) {
      const parsed = LedgerAction.Append.parse(input);
      const receipt = transaction(() => appendAction(db, parsed, expectedRevision));
      if (receipt !== undefined) publishCommitted(observationSink, receipt);
      return receipt;
    },
    tree(sessionId) {
      const rows = db
        .query(
          `SELECT id, parent_id, session_id, kind, intent, effect, revert,
                  irreversible, encoding_version, ts, ordinal
           FROM action WHERE session_id = ? ORDER BY ordinal`,
        )
        .all(sessionId) as ActionSqlRow[];
      return rows.map(decodeAction);
    },
  };
}

function appendAction(
  db: Database,
  action: LedgerAction.Append,
  expectedRevision: number,
): LedgerAction.Receipt | undefined {
  if (actionExists(db, action.id)) return undefined;
  if (!parentBelongsToSession(db, action.parentId, action.sessionId)) return undefined;
  const revision = expectedRevision + 1;
  const updated = db
    .query(
      `UPDATE session SET revision = ?
       WHERE id = ? AND revision = ? AND role IS NOT NULL`,
    )
    .run(revision, action.sessionId, expectedRevision);
  if (updated.changes !== 1) return undefined;
  const revert = "revert" in action ? action.revert : undefined;
  db.query(
    `INSERT INTO action (
         id, parent_id, session_id, kind, intent, effect, revert, irreversible,
         encoding_version, ts, ordinal
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    action.id,
    action.parentId,
    action.sessionId,
    action.kind,
    JSON.stringify(action.intent.value),
    JSON.stringify(action.effect.value),
    revert === undefined ? null : JSON.stringify(revert.value),
    "irreversible" in action ? 1 : 0,
    action.intent.encodingVersion,
    action.ts,
    revision,
  );
  const node = LedgerAction.Node.parse({ ...action, ordinal: revision });
  return { action: node, revision };
}

class SessionCommitRefused extends Error {
  constructor(readonly result: LedgerSession.CommitResult) {
    super("session commit refused");
    this.name = "SessionCommitRefused";
  }
}

function commitSession(
  db: Database,
  request: LedgerSession.Commit,
): LedgerSession.CommitResult | undefined {
  const current = selectSession(db, request.sessionId);
  if (current === undefined) return undefined;
  if (
    current.leaseOwner !== request.owner ||
    current.leaseFence !== request.fence ||
    current.leaseExpiresAt === null ||
    Deadline.isExpired(request.now, current.leaseExpiresAt)
  ) {
    return refusedSessionCommit("stale", current);
  }
  if (current.revision !== request.expectedRevision) {
    return refusedSessionCommit("revision", current);
  }
  if (!validActionBatch(db, request.actions, request.sessionId)) {
    return refusedSessionCommit("revision", current);
  }
  if (!canConsumeInbox(db, request)) {
    return refusedSessionCommit("inbox", current);
  }

  const receipts: LedgerAction.Receipt[] = [];
  let revision = current.revision;
  for (const action of request.actions) {
    const receipt = appendAction(db, action, revision);
    if (receipt === undefined) {
      throw new SessionCommitRefused(refusedSessionCommit("revision", current));
    }
    receipts.push(receipt);
    revision = receipt.revision;
  }
  for (const id of request.consumeInboxIds) {
    const consumed = db
      .query(
        `UPDATE inbox SET status = 'consumed', consumed_by = ?, consumed_at = ?
         WHERE id = ? AND session_id = ? AND status = 'pending'`,
      )
      .run(request.owner, request.now, id, request.sessionId);
    if (consumed.changes !== 1) {
      throw new SessionCommitRefused(refusedSessionCommit("inbox", current));
    }
  }

  const generation = request.generation ?? current;
  const updated = db
    .query(
      `UPDATE session SET state = ?, tools_generation = ?, system_hash = ?,
         policy_generation = ?, lease_owner = ?, lease_expires_at = ?
       WHERE id = ? AND lease_owner = ? AND lease_fence = ? AND revision = ?
         AND lease_expires_at > ? AND role IS NOT NULL`,
    )
    .run(
      request.state,
      generation.toolsGeneration,
      generation.systemHash,
      generation.policyGeneration,
      request.releaseLease ? null : request.owner,
      request.releaseLease ? null : current.leaseExpiresAt,
      request.sessionId,
      request.owner,
      request.fence,
      revision,
      request.now,
    );
  if (updated.changes !== 1) {
    throw new SessionCommitRefused(refusedSessionCommit("stale", current));
  }
  const row = selectSession(db, request.sessionId);
  if (row === undefined) throw new Error("committed session disappeared");
  return { ok: true, row, receipts };
}

function validActionBatch(
  db: Database,
  actions: readonly LedgerAction.Append[],
  sessionId: string,
): boolean {
  const ids = new Set<string>();
  for (const action of actions) {
    if (action.sessionId !== sessionId || ids.has(action.id) || actionExists(db, action.id)) {
      return false;
    }
    if (
      action.parentId !== null &&
      !ids.has(action.parentId) &&
      !parentBelongsToSession(db, action.parentId, sessionId)
    ) {
      return false;
    }
    ids.add(action.id);
  }
  return true;
}

function canConsumeInbox(db: Database, request: LedgerSession.Commit): boolean {
  if (new Set(request.consumeInboxIds).size !== request.consumeInboxIds.length) return false;
  for (const id of request.consumeInboxIds) {
    const row = db.query("SELECT session_id, status FROM inbox WHERE id = ?").get(id) as {
      session_id: string;
      status: string;
    } | null;
    if (row?.session_id !== request.sessionId || row.status !== "pending") return false;
  }
  return true;
}

function refusedSessionCommit(
  reason: "stale" | "revision" | "inbox",
  current: LedgerSession.Row,
): LedgerSession.CommitResult {
  return {
    ok: false,
    reason,
    currentFence: current.leaseFence,
    currentRevision: current.revision,
  };
}

function actionExists(db: Database, id: string): boolean {
  return db.query("SELECT 1 FROM action WHERE id = ?").get(id) !== null;
}

function parentBelongsToSession(db: Database, parentId: string | null, sessionId: string): boolean {
  if (parentId === null) return true;
  const row = db.query("SELECT session_id FROM action WHERE id = ?").get(parentId) as {
    session_id: string;
  } | null;
  return row?.session_id === sessionId;
}

function createInbox(
  db: Database,
  transaction: <T>(operation: () => T) => T,
  observationSink: ObservationSink,
): ProtocolStorage.InboxSubAdapter {
  return {
    commit(input) {
      const row = Inbox.Commit.parse(input);
      const result = transaction(() => {
        const session = db
          .query("SELECT revision FROM session WHERE id = ?")
          .get(row.sessionId) as {
          revision: number;
        } | null;
        if (session === null) return undefined;
        const receipt = appendAction(db, inboxAppend(row), session.revision);
        if (receipt === undefined) return undefined;
        const ordinalRow = db
          .query("SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM inbox WHERE session_id = ?")
          .get(row.sessionId) as { ordinal: number };
        const committed = Inbox.Row.parse({
          id: row.id,
          sessionId: row.sessionId,
          kind: row.kind,
          content: row.content,
          origin: row.origin,
          status: "pending",
          consumedBy: null,
          consumedAt: null,
          createdAt: row.createdAt,
          ordinal: ordinalRow.ordinal,
        });
        db.query(
          `INSERT INTO inbox (
             id, session_id, kind, content, origin, encoding_version, status,
             consumed_by, consumed_at, time_created, ordinal
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          committed.id,
          committed.sessionId,
          committed.kind,
          committed.content,
          JSON.stringify(committed.origin.value),
          committed.origin.encodingVersion,
          committed.status,
          committed.consumedBy,
          committed.consumedAt,
          committed.createdAt,
          committed.ordinal,
        );
        return { committed, receipt };
      });
      if (result === undefined) return undefined;
      publishCommitted(observationSink, result.receipt);
      return result.committed;
    },
    list(sessionId, status) {
      const rows = (
        status === undefined
          ? db.query("SELECT * FROM inbox WHERE session_id = ? ORDER BY ordinal").all(sessionId)
          : db
              .query("SELECT * FROM inbox WHERE session_id = ? AND status = ? ORDER BY ordinal")
              .all(sessionId, status)
      ) as InboxSqlRow[];
      return rows.map(decodeInbox);
    },
  };
}

function createAlarms(
  db: Database,
  transaction: <T>(operation: () => T) => T,
  observationSink: ObservationSink,
): ProtocolStorage.AlarmSubAdapter {
  return {
    arm(input) {
      const parsed = Alarm.Arm.parse(input);
      const result = transaction(() => {
        const session = db
          .query("SELECT revision FROM session WHERE id = ? AND role IS NOT NULL")
          .get(parsed.sessionId) as { revision: number } | null;
        if (session === null) return undefined;
        const receipt = appendAction(db, alarmAppend(parsed), session.revision);
        if (receipt === undefined) return undefined;
        const row = Alarm.Row.parse({
          ...parsed,
          status: "armed",
          createdAt: parsed.fireAt,
          updatedAt: parsed.fireAt,
        });
        db.query(
          `INSERT INTO alarm (
             id, session_id, kind, fire_at, spec, encoding_version, status,
             time_created, time_updated
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          row.id,
          row.sessionId,
          row.kind,
          row.fireAt,
          row.spec === undefined ? null : JSON.stringify(row.spec.value),
          row.spec?.encodingVersion ?? 1,
          row.status,
          row.createdAt,
          row.updatedAt,
        );
        return { receipt, row };
      });
      if (result === undefined) return undefined;
      publishCommitted(observationSink, result.receipt);
      return result.row;
    },
    cancel(id, updatedAt) {
      const result = db
        .query(
          "UPDATE alarm SET status = 'cancelled', time_updated = ? WHERE id = ? AND status = 'armed'",
        )
        .run(updatedAt, id);
      if (result.changes !== 1) return undefined;
      const row = db.query("SELECT * FROM alarm WHERE id = ?").get(id) as AlarmSqlRow;
      return decodeAlarm(row);
    },
    due(at) {
      const rows = db
        .query("SELECT * FROM alarm WHERE status = 'armed' AND fire_at <= ? ORDER BY fire_at, id")
        .all(at) as AlarmSqlRow[];
      return rows.map(decodeAlarm);
    },
  };
}

function createPolicies(db: Database): ProtocolStorage.PolicyRowSubAdapter {
  return {
    append(input) {
      const row = PolicyRow.Row.parse(input);
      const result = db
        .query(
          `INSERT INTO policy (
             name, kind, phase, match, verdict, encoding_version, priority, generation
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        )
        .run(
          row.name,
          row.kind,
          row.phase,
          JSON.stringify(row.match.value),
          JSON.stringify(row.verdict.value),
          row.match.encodingVersion,
          row.priority,
          row.generation,
        );
      return result.changes === 1;
    },
    rows(generation) {
      const rows = (
        generation === undefined
          ? db
              .query("SELECT * FROM policy ORDER BY generation, priority DESC, name, kind, phase")
              .all()
          : db
              .query(
                "SELECT * FROM policy WHERE generation = ? ORDER BY priority DESC, name, kind, phase",
              )
              .all(generation)
      ) as PolicySqlRow[];
      return rows.map(decodePolicy);
    },
  };
}

function publishCommitted(sink: ObservationSink, receipt: LedgerAction.Receipt): void {
  try {
    sink.publish(L0Observation.ActionCommittedEvent, {
      id: receipt.action.id,
      sessionId: receipt.action.sessionId,
      revision: receipt.revision,
      kind: receipt.action.kind,
    });
  } catch {
    // Observation is explicitly lossy and cannot alter a committed result.
  }
}

function l0SessionInfo(row: LedgerSession.Row) {
  return {
    id: row.id,
    title: row.id,
    model: { providerID: "l0", modelID: "l0" },
    time: { created: 0, updated: 0 },
    spawnDepth: row.parentId === null ? 0 : 1,
    agent: { id: row.role },
    ...(row.parentId === null ? {} : { parentSessionId: row.parentId }),
  };
}

function decodeSession(row: SessionSqlRow): LedgerSession.Row {
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

function decodeAction(row: ActionSqlRow): LedgerAction.Node {
  const common = {
    id: row.id,
    parentId: row.parent_id,
    sessionId: row.session_id,
    kind: row.kind,
    intent: { encodingVersion: row.encoding_version, value: JSON.parse(row.intent) },
    effect: { encodingVersion: row.encoding_version, value: JSON.parse(row.effect) },
    ts: row.ts,
    ordinal: row.ordinal,
  };
  return actionRowSchema.parse(
    row.revert === null
      ? { ...common, irreversible: row.irreversible === 1 }
      : {
          ...common,
          revert: { encodingVersion: row.encoding_version, value: JSON.parse(row.revert) },
        },
  );
}

function decodeInbox(row: InboxSqlRow): Inbox.Row {
  return inboxRowSchema.parse({
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    content: row.content,
    origin: { encodingVersion: row.encoding_version, value: JSON.parse(row.origin) },
    status: row.status,
    consumedBy: row.consumed_by,
    consumedAt: row.consumed_at,
    createdAt: row.time_created,
    ordinal: row.ordinal,
  });
}

function decodeAlarm(row: AlarmSqlRow): Alarm.Row {
  return alarmRowSchema.parse({
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    fireAt: row.fire_at,
    ...(row.spec === null
      ? {}
      : { spec: { encodingVersion: row.encoding_version, value: JSON.parse(row.spec) } }),
    status: row.status,
    createdAt: row.time_created,
    updatedAt: row.time_updated,
  });
}

function decodePolicy(row: PolicySqlRow): PolicyRow.Row {
  return policyRowSchema.parse({
    name: row.name,
    kind: row.kind,
    phase: row.phase,
    match: { encodingVersion: row.encoding_version, value: JSON.parse(row.match) },
    verdict: { encodingVersion: row.encoding_version, value: JSON.parse(row.verdict) },
    priority: row.priority,
    generation: row.generation,
  });
}
