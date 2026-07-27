import type { Database } from "bun:sqlite";
import { Ledger } from "@openomni/protocol";

export interface LedgerSequenceRange {
  readonly afterLedgerSeq?: number;
  readonly throughLedgerSeq: number;
  readonly limit?: number;
}

export interface OwnerSequenceRange {
  readonly afterOwnerSeq?: number;
  readonly throughOwnerSeq: number;
  readonly limit?: number;
}

export type ProjectionJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ProjectionJsonValue[]
  | ProjectionJsonObject;
export interface ProjectionJsonObject {
  readonly [key: string]: ProjectionJsonValue;
}

export interface ProjectionSourceRefs {
  readonly ownerKey: string;
  readonly state: ProjectionJsonObject;
  readonly sourceEventId: string;
  readonly sourceOwnerSeq: number;
  readonly sourceLedgerSeq: number;
  readonly sourceOwnerHash: string;
  readonly asOfLedgerSeq: number;
  readonly updatedAtDbMs: number;
}

export interface SessionProjection extends ProjectionSourceRefs {
  readonly sessionId: string;
}
export interface MessageProjection extends ProjectionSourceRefs {
  readonly messageId: string;
  readonly sessionId: string;
}
export interface PartProjection extends ProjectionSourceRefs {
  readonly partId: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly partOrdinal: number;
}
export interface SurfaceBindingProjection extends ProjectionSourceRefs {
  readonly surfaceId: string;
  readonly sessionId: string;
}
export interface ArtifactReferenceProjection extends ProjectionSourceRefs {
  readonly referenceId: string;
  readonly contentHash: string;
}
export interface ActorIdentityProjection extends ProjectionSourceRefs {
  readonly actorId: string;
}
export interface ActorEndpointProjection extends ProjectionSourceRefs {
  readonly endpointId: string;
  readonly actorId: string;
}
export interface BlacklistProjection extends ProjectionSourceRefs {
  readonly blacklistId: string;
}
export interface ChannelGrantProjection extends ProjectionSourceRefs {
  readonly grantId: string;
}
export interface WorkerGrantProjection extends ProjectionSourceRefs {
  readonly grantId: string;
  readonly workItemId: string;
  readonly attemptId: string;
}
export interface ScheduleProjection extends ProjectionSourceRefs {
  readonly scheduleId: string;
}
export interface ConnectorInstallationProjection extends ProjectionSourceRefs {
  readonly installationId: string;
}
export interface WorkProjection extends ProjectionSourceRefs {
  readonly workItemId: string;
  readonly sessionId: string;
  readonly parentWorkItemId: string | null;
}
export interface AttemptProjection extends ProjectionSourceRefs {
  readonly attemptId: string;
  readonly workItemId: string;
  readonly sessionId: string;
}
export interface WaitProjection extends ProjectionSourceRefs {
  readonly waitId: string;
  readonly workItemId: string;
  readonly attemptId: string;
  readonly sessionId: string;
}
export interface DispatchProjection extends ProjectionSourceRefs {
  readonly dispatchId: string;
  readonly sourceOwnerKey: string;
  readonly destinationOwnerKey: string;
}
export interface CompletionProjection extends ProjectionSourceRefs {
  readonly candidateId: string;
  readonly workItemId: string;
  readonly attemptId: string;
}
export interface EffectProjection extends ProjectionSourceRefs {
  readonly effectId: string;
  readonly workspaceId: string;
  readonly workItemId: string;
  readonly attemptId: string;
}

export interface LedgerQuery {
  head(owner: Ledger.OwnerRef): Ledger.Head;
  eventAt(ledgerSeq: number): Ledger.EnvelopeV1 | undefined;
  eventsByLedgerSequence(range: LedgerSequenceRange): readonly Ledger.EnvelopeV1[];
  eventsByOwnerSequence(
    owner: Ledger.OwnerRef,
    range: OwnerSequenceRange,
  ): readonly Ledger.EnvelopeV1[];
  appendResult(requestId: string): Ledger.AppendResult | undefined;
  completeBatches(range: LedgerSequenceRange): readonly (readonly Ledger.EnvelopeV1[])[];
  session(sessionId: string): SessionProjection | undefined;
  message(messageId: string): MessageProjection | undefined;
  messagesBySession(sessionId: string): readonly MessageProjection[];
  interruptedMessages(): readonly MessageProjection[];
  part(partId: string): PartProjection | undefined;
  partsByMessage(messageId: string): readonly PartProjection[];
  surfaceBinding(surfaceId: string): SurfaceBindingProjection | undefined;
  surfaceBindingsBySession(sessionId: string): readonly SurfaceBindingProjection[];
  artifactReference(contentHash: string): ArtifactReferenceProjection | undefined;
  actorIdentity(actorId: string): ActorIdentityProjection | undefined;
  actorEndpoint(endpointId: string): ActorEndpointProjection | undefined;
  actorEndpointsByActor(actorId: string): readonly ActorEndpointProjection[];
  blacklistEntries(): readonly BlacklistProjection[];
  channelGrant(channelId: string): ChannelGrantProjection | undefined;
  workerGrant(workerRunId: string): WorkerGrantProjection | undefined;
  workerGrantsByAttempt(attemptId: string): readonly WorkerGrantProjection[];
  schedule(scheduleId: string): ScheduleProjection | undefined;
  dueSchedules(atDbMs: number, limit: number): readonly ScheduleProjection[];
  activeSchedules(): readonly ScheduleProjection[];
  connectorInstallation(installationId: string): ConnectorInstallationProjection | undefined;
  work(workItemId: string): WorkProjection | undefined;
  worksBySession(sessionId: string): readonly WorkProjection[];
  childWorks(parentWorkItemId: string): readonly WorkProjection[];
  openWorks(): readonly WorkProjection[];
  attempt(attemptId: string): AttemptProjection | undefined;
  attemptByRunId(runId: string): AttemptProjection | undefined;
  attemptsByWork(workItemId: string): readonly AttemptProjection[];
  attemptsBySession(sessionId: string): readonly AttemptProjection[];
  interruptedAttempts(): readonly AttemptProjection[];
  wait(waitId: string): WaitProjection | undefined;
  waitCandidates(endpointId?: string, channelId?: string): readonly WaitProjection[];
  waitsByAttempt(attemptId: string): readonly WaitProjection[];
  waitsBySession(sessionId: string): readonly WaitProjection[];
  dispatch(dispatchId: string): DispatchProjection | undefined;
  pendingDispatches(destinationOwnerKey?: string, limit?: number): readonly DispatchProjection[];
  dispatchesByDestination(destinationOwnerKey: string): readonly DispatchProjection[];
  completion(candidateId: string): CompletionProjection | undefined;
  completionsByWork(workItemId: string): readonly CompletionProjection[];
  effect(effectId: string): EffectProjection | undefined;
  unsettledEffects(limit: number): readonly EffectProjection[];
  effectsByWorkspace(workspaceId: string): readonly EffectProjection[];
  effectsByAttempt(attemptId: string): readonly EffectProjection[];
}

export function createLedgerQuery(db: Database): LedgerQuery {
  return new SqliteLedgerQuery(db);
}

export class LedgerQueryCapabilityClosedError extends Error {
  readonly code = "ledger_query_capability_closed" as const;

  constructor() {
    super("Ledger query capability is no longer active");
    this.name = "LedgerQueryCapabilityClosedError";
  }
}

export interface ScopedLedgerQuery {
  readonly capability: LedgerQuery;
  invalidate(): void;
}

/** Creates a query face that can be explicitly expired without exposing its database. */
export function createScopedLedgerQuery(query: LedgerQuery): ScopedLedgerQuery {
  let active = true;
  const use = <T>(operation: () => T): T => {
    if (!active) throw new LedgerQueryCapabilityClosedError();
    return operation();
  };
  const capability = Object.freeze<LedgerQuery>({
    head: (owner: Ledger.OwnerRef) => use(() => query.head(owner)),
    eventAt: (ledgerSeq: number) => use(() => query.eventAt(ledgerSeq)),
    eventsByLedgerSequence: (range: LedgerSequenceRange) =>
      use(() => query.eventsByLedgerSequence(range)),
    eventsByOwnerSequence: (owner: Ledger.OwnerRef, range: OwnerSequenceRange) =>
      use(() => query.eventsByOwnerSequence(owner, range)),
    appendResult: (requestId: string) => use(() => query.appendResult(requestId)),
    completeBatches: (range: LedgerSequenceRange) => use(() => query.completeBatches(range)),
    session: (id) => use(() => query.session(id)),
    message: (id) => use(() => query.message(id)),
    messagesBySession: (id) => use(() => query.messagesBySession(id)),
    interruptedMessages: () => use(() => query.interruptedMessages()),
    part: (id) => use(() => query.part(id)),
    partsByMessage: (id) => use(() => query.partsByMessage(id)),
    surfaceBinding: (id) => use(() => query.surfaceBinding(id)),
    surfaceBindingsBySession: (id) => use(() => query.surfaceBindingsBySession(id)),
    artifactReference: (hash) => use(() => query.artifactReference(hash)),
    actorIdentity: (id) => use(() => query.actorIdentity(id)),
    actorEndpoint: (id) => use(() => query.actorEndpoint(id)),
    actorEndpointsByActor: (id) => use(() => query.actorEndpointsByActor(id)),
    blacklistEntries: () => use(() => query.blacklistEntries()),
    channelGrant: (id) => use(() => query.channelGrant(id)),
    workerGrant: (id) => use(() => query.workerGrant(id)),
    workerGrantsByAttempt: (id) => use(() => query.workerGrantsByAttempt(id)),
    schedule: (id) => use(() => query.schedule(id)),
    dueSchedules: (atDbMs, limit) => use(() => query.dueSchedules(atDbMs, limit)),
    activeSchedules: () => use(() => query.activeSchedules()),
    connectorInstallation: (id) => use(() => query.connectorInstallation(id)),
    work: (id) => use(() => query.work(id)),
    worksBySession: (id) => use(() => query.worksBySession(id)),
    childWorks: (id) => use(() => query.childWorks(id)),
    openWorks: () => use(() => query.openWorks()),
    attempt: (id) => use(() => query.attempt(id)),
    attemptByRunId: (id) => use(() => query.attemptByRunId(id)),
    attemptsByWork: (id) => use(() => query.attemptsByWork(id)),
    attemptsBySession: (id) => use(() => query.attemptsBySession(id)),
    interruptedAttempts: () => use(() => query.interruptedAttempts()),
    wait: (id) => use(() => query.wait(id)),
    waitCandidates: (endpointId, channelId) =>
      use(() => query.waitCandidates(endpointId, channelId)),
    waitsByAttempt: (id) => use(() => query.waitsByAttempt(id)),
    waitsBySession: (id) => use(() => query.waitsBySession(id)),
    dispatch: (id) => use(() => query.dispatch(id)),
    pendingDispatches: (owner, limit) => use(() => query.pendingDispatches(owner, limit)),
    dispatchesByDestination: (owner) => use(() => query.dispatchesByDestination(owner)),
    completion: (id) => use(() => query.completion(id)),
    completionsByWork: (id) => use(() => query.completionsByWork(id)),
    effect: (id) => use(() => query.effect(id)),
    unsettledEffects: (limit) => use(() => query.unsettledEffects(limit)),
    effectsByWorkspace: (id) => use(() => query.effectsByWorkspace(id)),
    effectsByAttempt: (id) => use(() => query.effectsByAttempt(id)),
  });
  return {
    capability,
    invalidate() {
      active = false;
    },
  };
}

class SqliteLedgerQuery implements LedgerQuery {
  constructor(private readonly db: Database) {}

  head(owner: Ledger.OwnerRef): Ledger.Head {
    const row = this.db
      .query("SELECT owner_seq, event_hash FROM ledger_head WHERE owner_key = ?")
      .get(owner.ownerKey) as HeadRow | null;
    return {
      version: "ledger-head-v1",
      owner,
      ownerSeq: row?.owner_seq ?? 0,
      eventHash: row?.event_hash ?? Ledger.GENESIS_V1,
    };
  }

  eventAt(ledgerSeq: number): Ledger.EnvelopeV1 | undefined {
    const row = this.db
      .query(`${EVENT_SELECT} WHERE ledger_seq = ?`)
      .get(ledgerSeq) as EventRow | null;
    return row === null ? undefined : toEnvelope(row);
  }

  eventsByLedgerSequence(range: LedgerSequenceRange): readonly Ledger.EnvelopeV1[] {
    assertRange(range.afterLedgerSeq ?? 0, range.throughLedgerSeq);
    const rows = this.db
      .query(
        `${EVENT_SELECT}
         WHERE ledger_seq > ? AND ledger_seq <= ?
         ORDER BY ledger_seq ASC
         LIMIT ?`,
      )
      .all(
        range.afterLedgerSeq ?? 0,
        range.throughLedgerSeq,
        positiveLimit(range.limit),
      ) as EventRow[];
    return rows.map(toEnvelope);
  }

  eventsByOwnerSequence(
    owner: Ledger.OwnerRef,
    range: OwnerSequenceRange,
  ): readonly Ledger.EnvelopeV1[] {
    assertRange(range.afterOwnerSeq ?? 0, range.throughOwnerSeq);
    const rows = this.db
      .query(
        `${EVENT_SELECT}
         WHERE owner_key = ? AND owner_seq > ? AND owner_seq <= ?
         ORDER BY owner_seq ASC
         LIMIT ?`,
      )
      .all(
        owner.ownerKey,
        range.afterOwnerSeq ?? 0,
        range.throughOwnerSeq,
        positiveLimit(range.limit),
      ) as EventRow[];
    return rows.map(toEnvelope);
  }

  appendResult(requestId: string): Ledger.AppendResult | undefined {
    const row = this.db
      .query("SELECT receipt_json FROM ledger_request WHERE request_id = ?")
      .get(requestId) as ReceiptRow | null;
    return row === null ? undefined : Ledger.AppendResult.parse(JSON.parse(row.receipt_json));
  }

  completeBatches(range: LedgerSequenceRange): readonly (readonly Ledger.EnvelopeV1[])[] {
    assertRange(range.afterLedgerSeq ?? 0, range.throughLedgerSeq);
    const batchLimit = positiveLimit(range.limit);
    const rows = this.db
      .query(
        `${EVENT_SELECT}
         WHERE ledger_seq > ? AND ledger_seq <= ?
         ORDER BY ledger_seq ASC
         LIMIT ?`,
      )
      .all(
        range.afterLedgerSeq ?? 0,
        range.throughLedgerSeq,
        Math.min(Number.MAX_SAFE_INTEGER, batchLimit * MAX_BATCH_SIZE),
      ) as EventRow[];

    const complete: Ledger.EnvelopeV1[][] = [];
    let offset = 0;
    while (offset < rows.length && complete.length < batchLimit) {
      const first = rows[offset];
      if (first === undefined) throw new Error("Ledger batch selection offset is out of bounds");
      const batch: EventRow[] = [];
      while (offset < rows.length) {
        const row = rows[offset];
        if (
          row === undefined ||
          row.owner_key !== first.owner_key ||
          row.batch_id !== first.batch_id ||
          row.request_id !== first.request_id
        ) {
          break;
        }
        batch.push(row);
        offset += 1;
      }
      if (
        batch.length !== first.batch_size ||
        batch.some(
          (row, index) =>
            row.owner_key !== first.owner_key ||
            row.batch_id !== first.batch_id ||
            row.batch_size !== first.batch_size ||
            row.batch_index !== index ||
            row.request_id !== first.request_id ||
            row.request_hash !== first.request_hash ||
            row.principal_id !== first.principal_id,
        )
      ) {
        break;
      }
      complete.push(batch.map(toEnvelope));
    }
    return complete;
  }

  session(sessionId: string): SessionProjection | undefined {
    return this.one("session_projection", "session_id = ?", [sessionId], parseSession);
  }
  message(messageId: string): MessageProjection | undefined {
    return this.one("message_projection", "message_id = ?", [messageId], parseMessage);
  }
  messagesBySession(sessionId: string): readonly MessageProjection[] {
    return this.many("message_projection", "session_id = ?", [sessionId], parseMessage);
  }

  interruptedMessages(): readonly MessageProjection[] {
    return this.many(
      "message_projection",
      "json_extract(state_json, '$.status') = 'streaming'",
      [],
      parseMessage,
    );
  }
  part(partId: string): PartProjection | undefined {
    return this.one("part_projection", "part_id = ?", [partId], parsePart);
  }
  partsByMessage(messageId: string): readonly PartProjection[] {
    return this.many("part_projection", "message_id = ?", [messageId], parsePart, "part_ordinal");
  }
  surfaceBinding(surfaceId: string): SurfaceBindingProjection | undefined {
    return this.one("surface_binding_projection", "surface_key = ?", [surfaceId], parseSurface);
  }
  surfaceBindingsBySession(sessionId: string): readonly SurfaceBindingProjection[] {
    return this.many("surface_binding_projection", "session_id = ?", [sessionId], parseSurface);
  }
  artifactReference(contentHash: string): ArtifactReferenceProjection | undefined {
    return this.one(
      "artifact_reference_projection",
      "content_hash = ?",
      [contentHash],
      parseArtifact,
    );
  }
  actorIdentity(actorId: string): ActorIdentityProjection | undefined {
    return this.one("actor_identity_projection", "actor_id = ?", [actorId], parseActorIdentity);
  }
  actorEndpoint(endpointId: string): ActorEndpointProjection | undefined {
    return this.one(
      "actor_endpoint_projection",
      "endpoint_id = ?",
      [endpointId],
      parseActorEndpoint,
    );
  }
  actorEndpointsByActor(actorId: string): readonly ActorEndpointProjection[] {
    return this.many("actor_endpoint_projection", "actor_id = ?", [actorId], parseActorEndpoint);
  }
  blacklistEntries(): readonly BlacklistProjection[] {
    return this.many("blacklist_projection", undefined, [], parseBlacklist);
  }
  channelGrant(channelId: string): ChannelGrantProjection | undefined {
    return this.one(
      "channel_grant_projection",
      "json_extract(state_json, '$.channelId') = ?",
      [channelId],
      parseChannelGrant,
      "source_ledger_seq DESC, grant_id ASC",
    );
  }
  workerGrant(workerRunId: string): WorkerGrantProjection | undefined {
    return this.one(
      "worker_grant_projection",
      "json_extract(state_json, '$.workerRunId') = ?",
      [workerRunId],
      parseWorkerGrant,
      "source_ledger_seq DESC, grant_id ASC",
    );
  }
  workerGrantsByAttempt(attemptId: string): readonly WorkerGrantProjection[] {
    return this.many("worker_grant_projection", "attempt_id = ?", [attemptId], parseWorkerGrant);
  }
  schedule(scheduleId: string): ScheduleProjection | undefined {
    return this.one("schedule_projection", "schedule_id = ?", [scheduleId], parseSchedule);
  }
  dueSchedules(atDbMs: number, limit: number): readonly ScheduleProjection[] {
    nonNegativeInteger(atDbMs, "Schedule due time");
    const bounded = positiveLimit(limit);
    return this.many(
      "schedule_projection",
      "json_extract(state_json, '$.status') = 'active' AND json_extract(state_json, '$.nextFireAtDbMs') <= ?",
      [atDbMs],
      parseSchedule,
      "json_extract(state_json, '$.nextFireAtDbMs'), source_ledger_seq",
      bounded,
    );
  }

  activeSchedules(): readonly ScheduleProjection[] {
    return this.many(
      "schedule_projection",
      "json_extract(state_json, '$.status') = 'active'",
      [],
      parseSchedule,
    );
  }
  connectorInstallation(installationId: string): ConnectorInstallationProjection | undefined {
    return this.one(
      "connector_installation_projection",
      "installation_id = ?",
      [installationId],
      parseConnector,
    );
  }
  work(workItemId: string): WorkProjection | undefined {
    return this.one("work_projection", "work_id = ?", [workItemId], parseWork);
  }
  worksBySession(sessionId: string): readonly WorkProjection[] {
    return this.many("work_projection", "session_id = ?", [sessionId], parseWork);
  }
  childWorks(parentWorkItemId: string): readonly WorkProjection[] {
    return this.many("work_projection", "parent_work_id = ?", [parentWorkItemId], parseWork);
  }

  openWorks(): readonly WorkProjection[] {
    return this.many(
      "work_projection",
      "json_type(state_json, '$.status') = 'text' AND json_extract(state_json, '$.status') NOT IN ('completed', 'failed', 'cancelled', 'archived')",
      [],
      parseWork,
    );
  }
  attempt(attemptId: string): AttemptProjection | undefined {
    return this.one("attempt_projection", "attempt_id = ?", [attemptId], parseAttempt);
  }
  attemptByRunId(runId: string): AttemptProjection | undefined {
    return this.one(
      "attempt_projection",
      "json_extract(state_json, '$.runId') = ?",
      [runId],
      parseAttempt,
    );
  }
  attemptsByWork(workItemId: string): readonly AttemptProjection[] {
    return this.many("attempt_projection", "work_id = ?", [workItemId], parseAttempt);
  }
  attemptsBySession(sessionId: string): readonly AttemptProjection[] {
    return this.many("attempt_projection", "session_id = ?", [sessionId], parseAttempt);
  }

  interruptedAttempts(): readonly AttemptProjection[] {
    return this.many(
      "attempt_projection",
      "json_extract(state_json, '$.status') IN ('starting', 'running', 'waiting')",
      [],
      parseAttempt,
    );
  }
  wait(waitId: string): WaitProjection | undefined {
    return this.one("wait_projection", "wait_id = ?", [waitId], parseWait);
  }
  waitCandidates(endpointId?: string, channelId?: string): readonly WaitProjection[] {
    const clauses = ["json_extract(state_json, '$.status') = 'open'"];
    const values: SqlValue[] = [];
    if (endpointId !== undefined) {
      clauses.push("json_extract(state_json, '$.opened.endpointId') = ?");
      values.push(endpointId);
    }
    if (channelId !== undefined) {
      clauses.push("json_extract(state_json, '$.opened.channelId') = ?");
      values.push(channelId);
    }
    return this.many("wait_projection", clauses.join(" AND "), values, parseWait);
  }
  waitsByAttempt(attemptId: string): readonly WaitProjection[] {
    return this.many("wait_projection", "attempt_id = ?", [attemptId], parseWait);
  }
  waitsBySession(sessionId: string): readonly WaitProjection[] {
    return this.many("wait_projection", "session_id = ?", [sessionId], parseWait);
  }
  dispatch(dispatchId: string): DispatchProjection | undefined {
    return this.one("dispatch_projection", "dispatch_id = ?", [dispatchId], parseDispatch);
  }
  pendingDispatches(destinationOwnerKey?: string, limit = 1_000): readonly DispatchProjection[] {
    const clauses = ["json_extract(state_json, '$.settlement') = 'pending'"];
    const values: SqlValue[] = [];
    if (destinationOwnerKey !== undefined) {
      clauses.push("destination_owner_key = ?");
      values.push(destinationOwnerKey);
    }
    return this.many(
      "dispatch_projection",
      clauses.join(" AND "),
      values,
      parseDispatch,
      "source_ledger_seq",
      positiveLimit(limit),
    );
  }
  dispatchesByDestination(destinationOwnerKey: string): readonly DispatchProjection[] {
    return this.many(
      "dispatch_projection",
      "destination_owner_key = ?",
      [destinationOwnerKey],
      parseDispatch,
    );
  }
  completion(candidateId: string): CompletionProjection | undefined {
    return this.one("completion_projection", "completion_id = ?", [candidateId], parseCompletion);
  }
  completionsByWork(workItemId: string): readonly CompletionProjection[] {
    return this.many("completion_projection", "work_id = ?", [workItemId], parseCompletion);
  }
  effect(effectId: string): EffectProjection | undefined {
    return this.one("effect_projection", "effect_id = ?", [effectId], parseEffect);
  }
  unsettledEffects(limit: number): readonly EffectProjection[] {
    return this.many(
      "effect_projection",
      "json_extract(state_json, '$.settlement') = 'pending'",
      [],
      parseEffect,
      "source_ledger_seq",
      positiveLimit(limit),
    );
  }
  effectsByWorkspace(workspaceId: string): readonly EffectProjection[] {
    return this.many("effect_projection", "workspace_id = ?", [workspaceId], parseEffect);
  }
  effectsByAttempt(attemptId: string): readonly EffectProjection[] {
    return this.many("effect_projection", "attempt_id = ?", [attemptId], parseEffect);
  }

  private one<T>(
    table: ProjectionTable,
    where: string,
    values: readonly SqlValue[],
    parse: ProjectionParser<T>,
    orderBy?: string,
  ): T | undefined {
    const orderClause = orderBy === undefined ? "" : ` ORDER BY ${orderBy}`;
    const row = this.db.query(`SELECT * FROM ${table} WHERE ${where}${orderClause}`).get(...values);
    return row === null ? undefined : parse(assertRow(row), this.projectionTail());
  }

  private many<T>(
    table: ProjectionTable,
    where: string | undefined,
    values: readonly SqlValue[],
    parse: ProjectionParser<T>,
    orderBy = "source_ledger_seq",
    limit?: number,
  ): readonly T[] {
    const clause = where === undefined ? "" : ` WHERE ${where}`;
    const limitClause = limit === undefined ? "" : " LIMIT ?";
    const parameters = limit === undefined ? values : [...values, limit];
    const rows = this.db
      .query(`SELECT * FROM ${table}${clause} ORDER BY ${orderBy} ASC${limitClause}`)
      .all(...parameters);
    const asOfLedgerSeq = this.projectionTail();
    return Object.freeze(rows.map((row) => parse(assertRow(row), asOfLedgerSeq)));
  }

  private projectionTail(): number {
    const row = assertRow(
      this.db.query("SELECT COALESCE(MAX(ledger_seq), 0) AS tail FROM ledger_event").get(),
    );
    return requiredInteger(row, "tail", 0);
  }
}

const PROJECTION_TABLES = [
  "session_projection",
  "message_projection",
  "part_projection",
  "surface_binding_projection",
  "artifact_reference_projection",
  "actor_identity_projection",
  "actor_endpoint_projection",
  "blacklist_projection",
  "channel_grant_projection",
  "worker_grant_projection",
  "schedule_projection",
  "connector_installation_projection",
  "work_projection",
  "attempt_projection",
  "wait_projection",
  "dispatch_projection",
  "completion_projection",
  "effect_projection",
] as const;
type ProjectionTable = (typeof PROJECTION_TABLES)[number];

type SqlValue = string | number;
type ProjectionRow = Readonly<Record<string, unknown>>;
type ProjectionParser<T> = (row: ProjectionRow, asOfLedgerSeq: number) => T;

function parseSession(row: ProjectionRow, asOf: number): SessionProjection {
  return freezeRecord({ sessionId: requiredString(row, "session_id"), ...parseCommon(row, asOf) });
}
function parseMessage(row: ProjectionRow, asOf: number): MessageProjection {
  return freezeRecord({
    messageId: requiredString(row, "message_id"),
    sessionId: requiredString(row, "session_id"),
    ...parseCommon(row, asOf),
  });
}
function parsePart(row: ProjectionRow, asOf: number): PartProjection {
  return freezeRecord({
    partId: requiredString(row, "part_id"),
    sessionId: requiredString(row, "session_id"),
    messageId: requiredString(row, "message_id"),
    partOrdinal: requiredInteger(row, "part_ordinal", 0),
    ...parseCommon(row, asOf),
  });
}
function parseSurface(row: ProjectionRow, asOf: number): SurfaceBindingProjection {
  return freezeRecord({
    surfaceId: requiredString(row, "surface_key"),
    sessionId: requiredString(row, "session_id"),
    ...parseCommon(row, asOf),
  });
}
function parseArtifact(row: ProjectionRow, asOf: number): ArtifactReferenceProjection {
  return freezeRecord({
    referenceId: requiredString(row, "reference_id"),
    contentHash: requiredString(row, "content_hash"),
    ...parseCommon(row, asOf),
  });
}
function parseActorIdentity(row: ProjectionRow, asOf: number): ActorIdentityProjection {
  return freezeRecord({ actorId: requiredString(row, "actor_id"), ...parseCommon(row, asOf) });
}
function parseActorEndpoint(row: ProjectionRow, asOf: number): ActorEndpointProjection {
  return freezeRecord({
    endpointId: requiredString(row, "endpoint_id"),
    actorId: requiredString(row, "actor_id"),
    ...parseCommon(row, asOf),
  });
}
function parseBlacklist(row: ProjectionRow, asOf: number): BlacklistProjection {
  return freezeRecord({
    blacklistId: requiredString(row, "blacklist_id"),
    ...parseCommon(row, asOf),
  });
}
function parseChannelGrant(row: ProjectionRow, asOf: number): ChannelGrantProjection {
  return freezeRecord({ grantId: requiredString(row, "grant_id"), ...parseCommon(row, asOf) });
}
function parseWorkerGrant(row: ProjectionRow, asOf: number): WorkerGrantProjection {
  return freezeRecord({
    grantId: requiredString(row, "grant_id"),
    workItemId: requiredString(row, "work_id"),
    attemptId: requiredString(row, "attempt_id"),
    ...parseCommon(row, asOf),
  });
}
function parseSchedule(row: ProjectionRow, asOf: number): ScheduleProjection {
  return freezeRecord({
    scheduleId: requiredString(row, "schedule_id"),
    ...parseCommon(row, asOf),
  });
}
function parseConnector(row: ProjectionRow, asOf: number): ConnectorInstallationProjection {
  return freezeRecord({
    installationId: requiredString(row, "installation_id"),
    ...parseCommon(row, asOf),
  });
}
function parseWork(row: ProjectionRow, asOf: number): WorkProjection {
  return freezeRecord({
    workItemId: requiredString(row, "work_id"),
    sessionId: requiredString(row, "session_id"),
    parentWorkItemId: optionalString(row, "parent_work_id"),
    ...parseCommon(row, asOf),
  });
}
function parseAttempt(row: ProjectionRow, asOf: number): AttemptProjection {
  return freezeRecord({
    attemptId: requiredString(row, "attempt_id"),
    workItemId: requiredString(row, "work_id"),
    sessionId: requiredString(row, "session_id"),
    ...parseCommon(row, asOf),
  });
}
function parseWait(row: ProjectionRow, asOf: number): WaitProjection {
  return freezeRecord({
    waitId: requiredString(row, "wait_id"),
    workItemId: requiredString(row, "work_id"),
    attemptId: requiredString(row, "attempt_id"),
    sessionId: requiredString(row, "session_id"),
    ...parseCommon(row, asOf),
  });
}
function parseDispatch(row: ProjectionRow, asOf: number): DispatchProjection {
  return freezeRecord({
    dispatchId: requiredString(row, "dispatch_id"),
    sourceOwnerKey: requiredString(row, "source_owner_key"),
    destinationOwnerKey: requiredString(row, "destination_owner_key"),
    ...parseCommon(row, asOf),
  });
}
function parseCompletion(row: ProjectionRow, asOf: number): CompletionProjection {
  return freezeRecord({
    candidateId: requiredString(row, "completion_id"),
    workItemId: requiredString(row, "work_id"),
    attemptId: requiredString(row, "attempt_id"),
    ...parseCommon(row, asOf),
  });
}
function parseEffect(row: ProjectionRow, asOf: number): EffectProjection {
  return freezeRecord({
    effectId: requiredString(row, "effect_id"),
    workspaceId: requiredString(row, "workspace_id"),
    workItemId: requiredString(row, "work_id"),
    attemptId: requiredString(row, "attempt_id"),
    ...parseCommon(row, asOf),
  });
}

function parseCommon(row: ProjectionRow, asOfLedgerSeq: number): ProjectionSourceRefs {
  const stateJson = requiredString(row, "state_json");
  let state: unknown;
  try {
    state = JSON.parse(stateJson);
  } catch {
    throw new TypeError("Projection state_json is invalid JSON");
  }
  if (!isJsonObject(state)) throw new TypeError("Projection state must be a JSON object");
  const sourceOwnerHash = requiredString(row, "source_owner_hash");
  if (!/^[0-9a-f]{64}$/.test(sourceOwnerHash))
    throw new TypeError("Projection source_owner_hash is invalid");
  return Object.freeze({
    ownerKey: requiredString(row, "owner_key"),
    state: deepFreezeJson(state),
    sourceEventId: requiredString(row, "source_event_id"),
    sourceOwnerSeq: requiredInteger(row, "source_owner_seq", 1),
    sourceLedgerSeq: requiredInteger(row, "source_ledger_seq", 1),
    sourceOwnerHash,
    asOfLedgerSeq: nonNegativeInteger(asOfLedgerSeq, "Projection as-of sequence"),
    updatedAtDbMs: requiredInteger(row, "updated_at_db_ms", 0),
  });
}

function assertRow(value: unknown): ProjectionRow {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Projection query returned an invalid row");
  return value as ProjectionRow;
}
function requiredString(row: ProjectionRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string" || value.length === 0)
    throw new TypeError(`Projection column ${column} must be a non-empty string`);
  return value;
}
function optionalString(row: ProjectionRow, column: string): string | null {
  const value = row[column];
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0)
    throw new TypeError(`Projection column ${column} must be null or a non-empty string`);
  return value;
}
function requiredInteger(row: ProjectionRow, column: string, minimum: number): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum)
    throw new TypeError(`Projection column ${column} must be a safe integer >= ${minimum}`);
  return value;
}
function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${label} must be a non-negative safe integer`);
  return value;
}
function isJsonObject(value: unknown): value is ProjectionJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) && isJsonValue(value);
}
function isJsonValue(value: unknown): value is ProjectionJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object" && Object.values(value).every(isJsonValue);
}
function freezeRecord<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}
function deepFreezeJson<T extends ProjectionJsonValue>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreezeJson(nested);
  return Object.freeze(value);
}
const MAX_BATCH_SIZE = 64;

const EVENT_SELECT = `SELECT
  ledger_seq, event_id, owner_key, owner_seq, previous_hash, content_hash,
  event_version, event_type, canonical_payload, canonical_provenance,
  batch_id, batch_index, batch_size, request_id, request_hash, principal_id,
  committed_at_db_ms
FROM ledger_event`;

function toEnvelope(row: EventRow): Ledger.EnvelopeV1 {
  return Ledger.EnvelopeV1.parse({
    version: "ledger-envelope-v1",
    envelopeVersion: 1,
    ledgerSeq: row.ledger_seq,
    ownerSeq: row.owner_seq,
    previousEventHash: row.previous_hash,
    eventHash: row.content_hash,
    event: {
      version: "ledger-event-v1",
      eventId: row.event_id,
      eventType: row.event_type,
      eventVersion: row.event_version,
      owner: { version: "ledger-owner-v1", ownerKey: row.owner_key },
      payload: JSON.parse(row.canonical_payload) as Ledger.EventV1["payload"],
      provenance: JSON.parse(row.canonical_provenance) as Ledger.EventV1["provenance"],
    },
    batch: {
      version: "ledger-batch-position-v1",
      batchId: row.batch_id,
      index: row.batch_index,
      size: row.batch_size,
    },
    requestId: row.request_id,
    requestHash: row.request_hash,
    principalId: row.principal_id,
    committedAtDbMs: row.committed_at_db_ms,
  });
}

function assertRange(after: number, through: number): void {
  if (
    !Number.isSafeInteger(after) ||
    !Number.isSafeInteger(through) ||
    after < 0 ||
    through < after
  ) {
    throw new RangeError("Ledger sequence bounds must be safe, non-negative, and ordered");
  }
}

function positiveLimit(limit: number | undefined): number {
  const value = limit ?? 1_000;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("Ledger query limit must be a positive safe integer");
  }
  return value;
}

interface HeadRow {
  readonly owner_seq: number;
  readonly event_hash: string;
}
interface ReceiptRow {
  readonly receipt_json: string;
}
interface EventRow {
  readonly ledger_seq: number;
  readonly event_id: string;
  readonly owner_key: string;
  readonly owner_seq: number;
  readonly previous_hash: string;
  readonly content_hash: string;
  readonly event_version: number;
  readonly event_type: string;
  readonly canonical_payload: string;
  readonly canonical_provenance: string;
  readonly batch_id: string;
  readonly batch_index: number;
  readonly batch_size: number;
  readonly request_id: string;
  readonly request_hash: string;
  readonly principal_id: string;
  readonly committed_at_db_ms: number;
}
