import type { Database } from "bun:sqlite";
import {
  Alarm,
  Inbox,
  LedgerAction,
  LedgerSession,
  PolicyRow,
  L0Observation,
  type ObservationSink,
  type Storage as ProtocolStorage,
} from "@openomni/protocol";

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
}

interface InboxSqlRow {
  id: string;
  session_id: string;
  kind: string;
  content: string;
  origin: string;
  status: string;
  claimed_by: string | null;
  claimed_at: number | null;
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
  const sessions = createSessions(db);
  const actions = createActions(db, transaction, observationSink);
  const inbox = createInbox(db, transaction);
  return {
    sessions,
    actions,
    inbox,
    alarms: createAlarms(db),
    policies: createPolicies(db),
  };
}

function createSessions(db: Database): ProtocolStorage.SessionLedgerSubAdapter {
  return {
    create(row) {
      const parsed = LedgerSession.Row.parse(row);
      const result = db
        .query(
          `INSERT INTO session (
             id, data, time_created, time_updated, parent_id, role, lease_owner,
             lease_fence, lease_expires_at, revision, state
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
        )
        .run(
          parsed.id,
          JSON.stringify(l0SessionInfo(parsed)),
          0,
          0,
          parsed.parentId,
          parsed.role,
          parsed.leaseOwner,
          parsed.leaseFence,
          parsed.leaseExpiresAt,
          parsed.revision,
          parsed.state,
        );
      return result.changes === 1;
    },
    get(id) {
      const row = db
        .query(
          `SELECT id, parent_id, role, lease_owner, lease_fence,
                  lease_expires_at, revision, state
           FROM session WHERE id = ?`,
        )
        .get(id) as SessionSqlRow | null;
      return row === null ? undefined : decodeSession(row);
    },
    list() {
      const rows = db
        .query(
          `SELECT id, parent_id, role, lease_owner, lease_fence,
                  lease_expires_at, revision, state
           FROM session WHERE role IS NOT NULL ORDER BY id`,
        )
        .all() as SessionSqlRow[];
      return rows.map(decodeSession);
    },
  };
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

function parentBelongsToSession(
  db: Database,
  parentId: string | null,
  sessionId: string,
): boolean {
  if (parentId === null) return true;
  const row = db.query("SELECT session_id FROM action WHERE id = ?").get(parentId) as {
    session_id: string;
  } | null;
  return row?.session_id === sessionId;
}

function createInbox(
  db: Database,
  transaction: <T>(operation: () => T) => T,
): ProtocolStorage.InboxSubAdapter {
  return {
    commit(input) {
      const row = Inbox.Commit.parse(input);
      return transaction(() => {
        const session = db.query("SELECT revision FROM session WHERE id = ?").get(row.sessionId) as {
          revision: number;
        } | null;
        if (session === null) return undefined;
        const receipt = appendAction(
          db,
          LedgerAction.Append.parse({
            id: row.id,
            parentId: null,
            sessionId: row.sessionId,
            kind: "prompt",
            intent: row.origin,
            effect: {
              encodingVersion: 1,
              value: { inboxKind: row.kind, content: row.content },
            },
            irreversible: true,
            ts: row.createdAt,
          }),
          session.revision,
        );
        if (receipt === undefined) return undefined;
        const ordinalRow = db
          .query("SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM inbox WHERE session_id = ?")
          .get(row.sessionId) as { ordinal: number };
        const committed = Inbox.Row.parse({
          ...row,
          status: "pending",
          claimedBy: null,
          claimedAt: null,
          ordinal: ordinalRow.ordinal,
        });
        db.query(
          `INSERT INTO inbox (
             id, session_id, kind, content, origin, encoding_version, status,
             claimed_by, claimed_at, time_created, ordinal
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          committed.id,
          committed.sessionId,
          committed.kind,
          committed.content,
          JSON.stringify(committed.origin.value),
          committed.origin.encodingVersion,
          committed.status,
          committed.claimedBy,
          committed.claimedAt,
          committed.createdAt,
          committed.ordinal,
        );
        return committed;
      });
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
    claim(sessionId, claimant, claimedAt) {
      return transaction(() => {
        const rows = db
          .query("SELECT * FROM inbox WHERE session_id = ? AND status = 'pending' ORDER BY ordinal")
          .all(sessionId) as InboxSqlRow[];
        if (rows.length === 0) return [];
        db.query(
          `UPDATE inbox SET status = 'claimed', claimed_by = ?, claimed_at = ?
           WHERE session_id = ? AND status = 'pending'`,
        ).run(claimant, claimedAt, sessionId);
        return rows.map((row) =>
          inboxRowSchema.parse({
            ...decodeInbox(row),
            status: "claimed",
            claimedBy: claimant,
            claimedAt,
          }),
        );
      });
    },
  };
}

function createAlarms(db: Database): ProtocolStorage.AlarmSubAdapter {
  return {
    arm(input) {
      const parsed = Alarm.Arm.parse(input);
      const row = Alarm.Row.parse({
        ...parsed,
        status: "armed",
        createdAt: parsed.fireAt,
        updatedAt: parsed.fireAt,
      });
      const result = db
        .query(
          `INSERT INTO alarm (
             id, session_id, kind, fire_at, spec, encoding_version, status,
             time_created, time_updated
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
        )
        .run(
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
      return result.changes === 1 ? row : undefined;
    },
    cancel(id, updatedAt) {
      const result = db
        .query("UPDATE alarm SET status = 'cancelled', time_updated = ? WHERE id = ? AND status = 'armed'")
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
          ? db.query("SELECT * FROM policy ORDER BY generation, priority DESC, name, kind, phase").all()
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
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
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
