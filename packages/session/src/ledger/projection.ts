import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { Actor, AppConnector, Execution, Ledger } from "@openomni/protocol";
import type { ArtifactBlobHash, ArtifactBlobTransaction } from "./blob.js";
import { withArtifactBlobTransaction } from "./blob.js";
import { createLedgerQuery } from "./query.js";

declare const projectionTransactionBrand: unique symbol;

/**
 * A writer-owned, DB-only handle for deterministic projection updates.
 * Projection callbacks must not perform external I/O or other side effects.
 */
export interface ProjectionTransaction {
  readonly [projectionTransactionBrand]: never;
  readonly artifactBlobs: ArtifactBlobTransaction;
}

/** A deterministic projection callback constrained to the writer's current database transaction. */
export interface ProjectionDefinition {
  readonly name: string;
  /** Stable implementation/version identity persisted with every checkpoint. */
  readonly identity: string;
  /** Must complete synchronously and return undefined; asynchronous work cannot join the append. */
  readonly applyCompleteBatch: (
    batch: readonly Ledger.EnvelopeV1[],
    transaction: ProjectionTransaction,
  ) => undefined;
}

export interface LedgerProjection {
  readonly name: string;
  readonly identity: string;
  checkpoint(): number;
}

interface ProjectionRegistration {
  readonly db: Database;
  readonly definition: ProjectionDefinition;
}

const definitions = new WeakMap<LedgerProjection, ProjectionRegistration>();
const nativeReferenceIntegrityProjections = new WeakSet<LedgerProjection>();

/** Internal opaque capability check; projection names never grant native integrity authority. */
export function verifiesNativeBlobReferences(projection: LedgerProjection): boolean {
  return nativeReferenceIntegrityProjections.has(projection);
}

export function createLedgerProjection(
  db: Database,
  definition: ProjectionDefinition,
): LedgerProjection {
  if (!/^[a-z][a-z0-9_.-]*$/.test(definition.name)) {
    throw new TypeError("Projection name must be a stable lowercase identifier");
  }
  if (
    typeof definition.identity !== "string" ||
    definition.identity.length === 0 ||
    definition.identity.trim() !== definition.identity
  ) {
    throw new TypeError("Projection identity must be a non-empty stable identifier");
  }
  if (typeof definition.applyCompleteBatch !== "function") {
    throw new TypeError("Projection must define an applyCompleteBatch callback");
  }
  const registeredDefinition: ProjectionDefinition = Object.freeze({
    name: definition.name,
    identity: definition.identity,
    applyCompleteBatch: definition.applyCompleteBatch,
  });
  const projection: LedgerProjection = Object.freeze({
    name: registeredDefinition.name,
    identity: registeredDefinition.identity,
    checkpoint: () => readCheckpoint(db, registeredDefinition.name, registeredDefinition.identity),
  });
  definitions.set(projection, Object.freeze({ db, definition: registeredDefinition }));
  return projection;
}

/** Internal registration lookup; it grants no write or transaction authority. */
export function projectionDefinition(
  projection: LedgerProjection,
  expectedDb: Database,
): ProjectionRegistration["definition"] {
  const registration = definitions.get(projection);
  if (registration === undefined) {
    throw new TypeError("Projection was not created by createLedgerProjection");
  }
  if (registration.db !== expectedDb) {
    throw new TypeError("Projection belongs to a different database");
  }
  return registration.definition;
}

export class ProjectionCheckpointConflictError extends Error {
  readonly code = "projection_checkpoint_conflict" as const;

  constructor(
    readonly projectionName: string,
    readonly expectedLedgerSeq: number,
    readonly actualLedgerSeq: number,
  ) {
    super(
      `Projection ${projectionName} checkpoint conflict: expected ${expectedLedgerSeq}, received ${actualLedgerSeq}`,
    );
    this.name = "ProjectionCheckpointConflictError";
  }
}

export class ProjectionIdentityMismatchError extends Error {
  readonly code = "projection_identity_mismatch" as const;

  constructor(
    readonly projectionName: string,
    readonly expectedIdentity: string,
    readonly actualIdentity: string,
  ) {
    super(
      `Projection ${projectionName} identity conflict: checkpoint belongs to ${actualIdentity}, not ${expectedIdentity}; explicitly rebuild or reset the projection before changing identity`,
    );
    this.name = "ProjectionIdentityMismatchError";
  }
}

function readCheckpoint(db: Database, projectionName: string, projectionIdentity: string): number {
  const row = db
    .query(
      "SELECT projection_identity, ledger_seq FROM projection_checkpoint WHERE projection_name = ?",
    )
    .get(projectionName) as CheckpointRow | null;
  if (row === null) return 0;
  if (row.projection_identity !== projectionIdentity) {
    throw new ProjectionIdentityMismatchError(
      projectionName,
      projectionIdentity,
      row.projection_identity,
    );
  }
  return row.ledger_seq;
}

interface CheckpointRow {
  readonly projection_name: string;
  readonly projection_identity: string;
  readonly ledger_seq: number;
}

const PRODUCTION_IDENTITY = "native-projection-v1";
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

/** The closed production projection set. Route decisions have a checkpoint-only registration. */
export function createProductionLedgerProjections(db: Database): readonly LedgerProjection[] {
  const names = [
    "session",
    "message",
    "part",
    "surface",
    "artifact-reference",
    "actor-identity",
    "actor-endpoint",
    "blacklist",
    "channel-grant",
    "worker-grant",
    "schedule",
    "connector-installation",
    "work",
    "attempt",
    "wait",
    "dispatch",
    "completion",
    "effect",
    "route",
  ] as const;
  return names.map((family) => {
    const projection = createLedgerProjection(db, {
      name: `native.${family}`,
      identity: PRODUCTION_IDENTITY,
      applyCompleteBatch(batch, transaction) {
        for (const envelope of batch) applyProductionEnvelope(db, family, envelope, transaction);
      },
    });
    nativeReferenceIntegrityProjections.add(projection);
    return projection;
  });
}

export interface CanonicalEnvelopeHashInput {
  readonly event: Ledger.EventV1;
  readonly batchId: string;
  readonly batchIndex: number;
  readonly batchSize: number;
  readonly ownerSeq: number;
  readonly previousEventHash: string;
  readonly requestId: string;
  readonly requestHash: string;
  readonly principalId: string;
}

/** Computes the canonical envelope hash used for both append and authoritative replay verification. */
export function canonicalEnvelopeHash(input: CanonicalEnvelopeHashInput): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        version: "ledger-envelope-v1",
        envelopeVersion: 1,
        event: input.event,
        batchId: input.batchId,
        batchIndex: input.batchIndex,
        batchSize: input.batchSize,
        ownerSeq: input.ownerSeq,
        previousEventHash: input.previousEventHash,
        requestId: input.requestId,
        requestHash: input.requestHash,
        principalId: input.principalId,
      }),
    )
    .digest("hex");
}

function verifyAuthoritativeLedger(db: Database, tail: number): void {
  const heads = new Map<string, { readonly ownerSeq: number; readonly eventHash: string }>();
  let afterLedgerSeq = 0;
  while (afterLedgerSeq < tail) {
    const batches = createLedgerQuery(db).completeBatches({
      afterLedgerSeq,
      throughLedgerSeq: tail,
      limit: 64,
    });
    if (batches.length === 0) {
      throw new Error("Ledger integrity verification could not select the next complete batch");
    }
    for (const batch of batches) {
      for (const envelope of batch) {
        const ownerKey = envelope.event.owner.ownerKey;
        const previous = heads.get(ownerKey) ?? {
          ownerSeq: 0,
          eventHash: Ledger.GENESIS_V1,
        };
        if (envelope.ownerSeq !== previous.ownerSeq + 1) {
          throw new Error(`Ledger owner ${ownerKey} sequence continuity mismatch`);
        }
        if (envelope.previousEventHash !== previous.eventHash) {
          throw new Error(`Ledger owner ${ownerKey} previous hash continuity mismatch`);
        }
        const computedHash = canonicalEnvelopeHash({
          event: envelope.event,
          batchId: envelope.batch.batchId,
          batchIndex: envelope.batch.index,
          batchSize: envelope.batch.size,
          ownerSeq: envelope.ownerSeq,
          previousEventHash: envelope.previousEventHash,
          requestId: envelope.requestId,
          requestHash: envelope.requestHash,
          principalId: envelope.principalId,
        });
        if (envelope.eventHash !== computedHash) {
          throw new Error(`Ledger event ${envelope.event.eventId} content hash mismatch`);
        }
        heads.set(ownerKey, { ownerSeq: envelope.ownerSeq, eventHash: envelope.eventHash });
        afterLedgerSeq = envelope.ledgerSeq;
      }
    }
  }

  const persistedHeads = db
    .query("SELECT owner_key, owner_seq, event_hash FROM ledger_head ORDER BY owner_key")
    .all() as readonly LedgerHeadRow[];
  if (persistedHeads.length !== heads.size) {
    throw new Error("Persisted ledger head owner set mismatch");
  }
  for (const row of persistedHeads) {
    const expected = heads.get(row.owner_key);
    if (
      expected === undefined ||
      row.owner_seq !== expected.ownerSeq ||
      row.event_hash !== expected.eventHash
    ) {
      throw new Error(`Persisted ledger head mismatch for owner ${row.owner_key}`);
    }
  }
}

interface LedgerHeadRow {
  readonly owner_key: string;
  readonly owner_seq: number;
  readonly event_hash: string;
}

/** Restores the closed production set from immutable ledger facts before accepting writes. */
export function rebuildProductionLedgerProjections(
  db: Database,
  projections: readonly LedgerProjection[],
): void {
  // Acquire the write transaction before observing the tail. Otherwise a writer can
  // commit between the tail read and lock acquisition and leave rebuilt checkpoints stale.
  db.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
    const tailRow = db
      .query("SELECT COALESCE(MAX(ledger_seq), 0) AS tail FROM ledger_event")
      .get() as {
      readonly tail: number;
    };
    verifyAuthoritativeLedger(db, tailRow.tail);
    // Checkpoint metadata proves replay position, not projection contents. Rebuild the
    // complete closed set on every open so missing or modified cache rows cannot survive.
    for (const table of PROJECTION_TABLES) db.query(`DELETE FROM ${table}`).run();
    for (const projection of projections) {
      db.query("DELETE FROM projection_checkpoint WHERE projection_name = ?").run(projection.name);
    }
    const definitions = projections.map((projection) => ({
      projection,
      definition: projectionDefinition(projection, db),
    }));
    let afterLedgerSeq = 0;
    while (afterLedgerSeq < tailRow.tail) {
      const batches = createLedgerQuery(db).completeBatches({
        afterLedgerSeq,
        throughLedgerSeq: tailRow.tail,
        limit: 64,
      });
      if (batches.length === 0)
        throw new Error("Ledger replay could not select the next complete batch");
      for (const batch of batches) {
        const last = batch.at(-1);
        if (last === undefined) throw new Error("Ledger replay selected an empty complete batch");
        for (const { projection, definition } of definitions) {
          const result: unknown = withArtifactBlobTransaction(db, (artifactBlobs) =>
            definition.applyCompleteBatch(
              batch,
              Object.freeze({ artifactBlobs }) as ProjectionTransaction,
            ),
          );
          if (result !== undefined) {
            throw new TypeError(
              `Projection ${projection.name} applyCompleteBatch must return undefined synchronously`,
            );
          }
          writeCheckpoint(
            db,
            projection.name,
            projection.identity,
            last.ledgerSeq,
            last.event.payload.occurredAtDbMs,
          );
        }
        afterLedgerSeq = last.ledgerSeq;
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function writeCheckpoint(
  db: Database,
  projectionName: string,
  projectionIdentity: string,
  ledgerSeq: number,
  updatedAtDbMs: number,
): void {
  db.query(
    `INSERT INTO projection_checkpoint
       (projection_name, projection_identity, ledger_seq, updated_at_db_ms)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(projection_name) DO UPDATE SET
       ledger_seq = excluded.ledger_seq,
       updated_at_db_ms = excluded.updated_at_db_ms
     WHERE projection_checkpoint.projection_identity = excluded.projection_identity`,
  ).run(projectionName, projectionIdentity, ledgerSeq, updatedAtDbMs);
}

type ProductionFamily =
  | "session"
  | "message"
  | "part"
  | "surface"
  | "artifact-reference"
  | "actor-identity"
  | "actor-endpoint"
  | "blacklist"
  | "channel-grant"
  | "worker-grant"
  | "schedule"
  | "connector-installation"
  | "work"
  | "attempt"
  | "wait"
  | "dispatch"
  | "completion"
  | "effect"
  | "route";

function applyProductionEnvelope(
  db: Database,
  family: ProductionFamily,
  envelope: Ledger.EnvelopeV1,
  transaction: ProjectionTransaction,
): void {
  const schema = Ledger.NativeEventPayloadSchemasV1[envelope.event.eventType];
  if (schema === undefined) throw new Error(`No payload schema for ${envelope.event.eventType}`);
  const payload = schema.parse(envelope.event.payload) as Ledger.NativeEventPayloadV1;
  if (!belongsToFamily(family, envelope.event.eventType, payload.partId)) return;
  const snapshotState = validateProjectionSnapshot(
    family,
    readSnapshot(family, payload, transaction),
    payload,
    envelope.event.owner.ownerKey,
  );
  const state =
    family === "completion"
      ? completionStateWithAuthoritativeStakes(db, payload, snapshotState, envelope)
      : snapshotState;
  if (family === "route") return;
  if (isConfigurationDeletion(family, envelope.event.eventType)) {
    deleteConfigurationProjection(db, family, payload.subjectId);
    return;
  }
  const common = [
    envelope.event.owner.ownerKey,
    canonicalJson(state),
    envelope.event.eventId,
    envelope.ownerSeq,
    envelope.ledgerSeq,
    envelope.eventHash,
    payload.occurredAtDbMs,
  ] as const;

  switch (family) {
    case "session":
      upsert(
        db,
        "session_projection",
        ["session_id"],
        [requiredPayloadString(payload, "sessionId"), ...common],
      );
      break;
    case "message":
      upsert(
        db,
        "message_projection",
        ["message_id", "session_id"],
        [
          requiredPayloadString(payload, "messageId"),
          requiredPayloadString(payload, "sessionId"),
          ...common,
        ],
      );
      break;
    case "part":
      upsert(
        db,
        "part_projection",
        ["part_id", "session_id", "message_id", "part_ordinal"],
        [
          requiredPayloadString(payload, "partId"),
          requiredPayloadString(payload, "sessionId"),
          requiredPayloadString(payload, "messageId"),
          requiredNonNegativeInteger(state, ["partOrdinal", "ordinal"]),
          ...common,
        ],
      );
      break;
    case "surface":
      assertSurfaceBindingClaim(
        db,
        envelope.event.eventType,
        requiredPayloadString(payload, "surfaceId"),
        requiredPayloadString(payload, "sessionId"),
      );
      upsert(
        db,
        "surface_binding_projection",
        ["surface_key", "session_id"],
        [
          requiredPayloadString(payload, "surfaceId"),
          requiredPayloadString(payload, "sessionId"),
          ...common,
        ],
      );
      break;
    case "artifact-reference":
      upsert(
        db,
        "artifact_reference_projection",
        ["reference_id", "content_hash"],
        [payload.subjectId, requiredNestedStateString(state, ["contentRef", "digest"]), ...common],
      );
      break;
    case "actor-identity":
      upsert(db, "actor_identity_projection", ["actor_id"], [payload.subjectId, ...common]);
      break;
    case "actor-endpoint":
      upsert(
        db,
        "actor_endpoint_projection",
        ["endpoint_id", "actor_id"],
        [payload.subjectId, requiredNestedStateString(state, ["endpoint", "actorId"]), ...common],
      );
      break;
    case "blacklist":
      upsert(db, "blacklist_projection", ["blacklist_id"], [payload.subjectId, ...common]);
      break;
    case "channel-grant":
      requiredNestedStateString(state, ["grant", "surface"]);
      upsert(db, "channel_grant_projection", ["grant_id"], [payload.subjectId, ...common]);
      break;
    case "worker-grant":
      requiredStateString(state, "workerRunId");
      upsert(
        db,
        "worker_grant_projection",
        ["grant_id", "work_id", "attempt_id"],
        [
          requiredPayloadString(payload, "grantId"),
          requiredPayloadString(payload, "workItemId"),
          requiredPayloadString(payload, "attemptId"),
          ...common,
        ],
      );
      break;
    case "schedule":
      upsert(
        db,
        "schedule_projection",
        ["schedule_id"],
        [requiredPayloadString(payload, "scheduleId"), ...common],
      );
      break;
    case "connector-installation":
      upsert(
        db,
        "connector_installation_projection",
        ["installation_id"],
        [payload.subjectId, ...common],
      );
      break;
    case "work":
      upsert(
        db,
        "work_projection",
        ["work_id", "session_id", "parent_work_id"],
        [
          requiredPayloadString(payload, "workItemId"),
          requiredPayloadString(payload, "sessionId"),
          nullableString(state.parentWorkId),
          ...common,
        ],
      );
      break;
    case "attempt":
      upsert(
        db,
        "attempt_projection",
        ["attempt_id", "work_id", "session_id"],
        [
          requiredPayloadString(payload, "attemptId"),
          requiredPayloadString(payload, "workItemId"),
          requiredPayloadString(payload, "sessionId"),
          ...common,
        ],
      );
      break;
    case "wait":
      upsert(
        db,
        "wait_projection",
        ["wait_id", "work_id", "attempt_id", "session_id"],
        [
          requiredPayloadString(payload, "waitId"),
          requiredStateString(state, "workItemId"),
          requiredStateString(state, "attemptId"),
          requiredStateString(state, "sessionId"),
          ...common,
        ],
      );
      break;
    case "dispatch":
      upsert(
        db,
        "dispatch_projection",
        ["dispatch_id", "source_owner_key", "destination_owner_key"],
        [
          requiredPayloadString(payload, "dispatchId"),
          requiredOwnerKey(payload.sourceOwner, "sourceOwner"),
          requiredOwnerKey(payload.destinationOwner, "destinationOwner"),
          ...common,
        ],
      );
      break;
    case "completion":
      assertCompletionArtifactProgression(db, payload, state);
      upsert(
        db,
        "completion_projection",
        ["completion_id", "work_id", "attempt_id"],
        [
          requiredPayloadString(payload, "candidateId"),
          requiredPayloadString(payload, "workItemId"),
          requiredStateString(state, "attemptId"),
          ...common,
        ],
      );
      break;
    case "effect":
      upsert(
        db,
        "effect_projection",
        ["effect_id", "workspace_id", "work_id", "attempt_id"],
        [
          requiredPayloadString(payload, "effectId"),
          requiredStateString(state, "workspaceId"),
          requiredPayloadString(payload, "workItemId"),
          requiredPayloadString(payload, "attemptId"),
          ...common,
        ],
      );
      break;
  }
}

function isConfigurationDeletion(family: ProductionFamily, eventType: string): boolean {
  if (family === "actor-identity") return eventType === "actor.identity_retired.v1";
  if (family === "actor-endpoint") return eventType === "actor.endpoint_unbound.v1";
  if (family === "blacklist") {
    return (
      eventType === "authority.blacklist_revoked.v1" ||
      eventType === "authority.blacklist_expired.v1"
    );
  }
  if (family === "channel-grant") return eventType === "authority.channel_grant_revoked.v1";
  if (family === "connector-installation") return eventType === "connector.uninstalled.v1";
  return false;
}

function deleteConfigurationProjection(
  db: Database,
  family: ProductionFamily,
  subjectId: string,
): void {
  switch (family) {
    case "actor-identity":
      db.query("DELETE FROM actor_identity_projection WHERE actor_id = ?").run(subjectId);
      return;
    case "actor-endpoint":
      db.query("DELETE FROM actor_endpoint_projection WHERE endpoint_id = ?").run(subjectId);
      return;
    case "blacklist":
      db.query("DELETE FROM blacklist_projection WHERE blacklist_id = ?").run(subjectId);
      return;
    case "channel-grant":
      db.query("DELETE FROM channel_grant_projection WHERE grant_id = ?").run(subjectId);
      return;
    case "connector-installation":
      db.query("DELETE FROM connector_installation_projection WHERE installation_id = ?").run(
        subjectId,
      );
      return;
    default:
      throw new Error(`Projection ${family} does not support configuration deletion`);
  }
}

function belongsToFamily(
  family: ProductionFamily,
  eventType: string,
  partId?: string | null,
): boolean {
  if (family === "session") return eventType.startsWith("session.");
  if (family === "surface") return eventType.startsWith("surface.");
  if (family === "message") return eventType.startsWith("message.");
  if (family === "part") return eventType.startsWith("message.") && partId != null;
  if (family === "route") return eventType.startsWith("kernel.route.");
  if (family === "dispatch") return eventType.startsWith("dispatch.");
  if (family === "work") return eventType.startsWith("work.");
  if (family === "completion") return eventType.startsWith("completion.");
  if (family === "attempt") return eventType.startsWith("attempt.");
  if (family === "wait") return eventType.startsWith("wait.");
  if (family === "worker-grant") return eventType.startsWith("grant.");
  if (family === "schedule") return eventType.startsWith("schedule.");
  if (family === "effect") return eventType.startsWith("effect.");
  if (family === "artifact-reference") return eventType.startsWith("artifact.");
  if (family === "actor-identity") return eventType.startsWith("actor.identity_");
  if (family === "actor-endpoint") return eventType.startsWith("actor.endpoint_");
  if (family === "blacklist") return eventType.startsWith("authority.blacklist_");
  if (family === "channel-grant") return eventType.startsWith("authority.channel_grant_");
  return eventType.startsWith("connector.");
}

function readSnapshot(
  family: ProductionFamily,
  payload: Ledger.NativeEventPayloadV1,
  transaction: ProjectionTransaction,
): Record<string, unknown> {
  const parsedByDigest = new Map<string, Record<string, unknown>>();
  for (const [key, value] of Object.entries(payload)) {
    const refs =
      key === "verdictArtifactRefs" && Array.isArray(value)
        ? value.filter(isContentBlobRef)
        : key.endsWith("Ref") && isContentBlobRef(value)
          ? [value]
          : [];
    for (const ref of refs) {
      if (parsedByDigest.has(ref.digest)) continue;
      parsedByDigest.set(ref.digest, parseSnapshotRef(ref, transaction));
    }
  }

  const ref = snapshotRefForFamily(family, payload);
  if (ref === undefined || ref === null) {
    throw new Error(`Projection ${family} requires a canonical snapshot reference`);
  }
  return parsedByDigest.get(ref.digest) ?? parseSnapshotRef(ref, transaction);
}

interface ContentBlobRef {
  readonly version: "content-blob-ref-v1";
  readonly digest: string;
  readonly byteLength: number;
}

function isContentBlobRef(value: unknown): value is ContentBlobRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === "content-blob-ref-v1" &&
    typeof record.digest === "string" &&
    typeof record.byteLength === "number"
  );
}

function snapshotRefForFamily(
  family: ProductionFamily,
  payload: Ledger.NativeEventPayloadV1,
): ContentBlobRef | null | undefined {
  switch (family) {
    case "session":
      return payload.sessionSnapshotRef;
    case "message":
      return payload.messageSnapshotRef;
    case "part":
      return payload.partSnapshotRef;
    case "surface":
      return payload.surfaceSnapshotRef;
    case "route":
      return payload.routeSnapshotRef;
    case "dispatch":
      return payload.dispatchSnapshotRef;
    case "work":
      return payload.workSnapshotRef;
    case "completion":
      return payload.completionSnapshotRef;
    case "attempt":
      return payload.attemptSnapshotRef;
    case "wait":
      return payload.waitSnapshotRef;
    case "worker-grant":
      return payload.grantSnapshotRef;
    case "schedule":
      return payload.scheduleSnapshotRef;
    case "effect":
      return isContentBlobRef(payload.effectSettlementRef)
        ? payload.effectSettlementRef
        : undefined;
    default:
      return payload.configurationSnapshotRef;
  }
}

function parseSnapshotRef(
  ref: ContentBlobRef,
  transaction: ProjectionTransaction,
): Record<string, unknown> {
  const hash = `sha256:${ref.digest}` as ArtifactBlobHash;
  const blob = transaction.artifactBlobs.read(hash);
  if (blob === undefined) throw new Error(`Referenced artifact blob ${hash} is missing`);
  if (blob.size !== ref.byteLength) {
    throw new Error(`Referenced artifact blob ${hash} has an unexpected byte length`);
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(blob.bytes);
  } catch {
    throw new Error(`Referenced artifact blob ${hash} is not valid UTF-8`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Referenced artifact blob ${hash} is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Referenced artifact blob ${hash} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}
const CONFIGURATION_FAMILIES = new Set<ProductionFamily>([
  "artifact-reference",
  "actor-identity",
  "actor-endpoint",
  "blacklist",
  "channel-grant",
  "connector-installation",
]);

const CONFIGURATION_EVENT_BY_OPERATION: Readonly<Record<string, string>> = Object.freeze({
  "AF-01": "artifact.referenced.v1",
  "AI-01": "actor.identity_registered.v1",
  "AI-02": "actor.identity_revised.v1",
  "AI-03": "actor.identity_retired.v1",
  "AE-01": "actor.endpoint_bound.v1",
  "AE-02": "actor.endpoint_rebound.v1",
  "AE-03": "actor.endpoint_unbound.v1",
  "BL-01": "authority.blacklist_created.v1",
  "BL-02": "authority.blacklist_revised.v1",
  "BL-03": "authority.blacklist_revoked.v1",
  "BL-04": "authority.blacklist_expired.v1",
  "CG-01": "authority.channel_grant_created.v1",
  "CG-02": "authority.channel_grant_revised.v1",
  "CG-03": "authority.channel_grant_revoked.v1",
  "CI-01": "connector.installation_registered.v1",
  "CI-02": "connector.definition_revised.v1",
  "CI-03": "connector.consent_requested.v1",
  "CI-04": "connector.consent_granted.v1",
  "CI-05": "connector.verification_requested.v1",
  "CI-06": "connector.verified.v1",
  "CI-07": "connector.verification_failed.v1",
  "CI-08": "connector.disabled.v1",
  "CI-09": "connector.uninstalled.v1",
});

function validateProjectionSnapshot(
  family: ProductionFamily,
  snapshot: Record<string, unknown>,
  payload: Ledger.NativeEventPayloadV1,
  ownerKey: string,
): Record<string, unknown> {
  if (CONFIGURATION_FAMILIES.has(family))
    return validateConfigurationSnapshot(family, snapshot, payload, ownerKey);
  const expectedVersion = `${family}-projection-state-v1`;
  const keys = Object.keys(snapshot).sort();
  if (keys.length !== 2 || keys[0] !== "state" || keys[1] !== "version") {
    throw new Error(`Projection ${family} snapshot must be a closed versioned state envelope`);
  }
  if (snapshot.version !== expectedVersion) {
    throw new Error(`Projection ${family} snapshot has invalid version`);
  }
  const state = snapshot.state;
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    throw new Error(`Projection ${family} snapshot state must be an object`);
  }
  const record = state as Record<string, unknown>;
  crossCheckProjectionIdentity(family, record, payload);
  validateAuthoritativeArtifactRefs(family, record, payload);
  return record;
}

function validateAuthoritativeArtifactRefs(
  family: ProductionFamily,
  state: Record<string, unknown>,
  payload: Ledger.NativeEventPayloadV1,
): void {
  if (family === "completion") {
    if (
      canonicalJson(state.candidateArtifactRef) !== canonicalJson(payload.candidateArtifactRef) ||
      canonicalJson(state.verdictArtifactRef) !== canonicalJson(payload.verdictArtifactRef) ||
      canonicalJson(state.admissionDecisionArtifactRef) !==
        canonicalJson(payload.admissionDecisionArtifactRef) ||
      canonicalJson(state.verdictArtifactRefs) !== canonicalJson(payload.verdictArtifactRefs)
    ) {
      throw new Error("Projection completion snapshot artifact refs do not match event facts");
    }
    const candidateRef = payload.candidateArtifactRef;
    const verdictRefs = payload.verdictArtifactRefs;
    if (
      candidateRef === undefined ||
      candidateRef.digest !== payload.candidateId ||
      verdictRefs === undefined ||
      new Set(verdictRefs.map((ref) => ref.digest)).size !== verdictRefs.length
    ) {
      throw new Error("Projection completion artifact refs are not immutable and exact");
    }
    const semanticVerdictRefs = state.verdictRefs;
    if (
      state.candidateRef !== payload.candidateId ||
      !Array.isArray(semanticVerdictRefs) ||
      semanticVerdictRefs.length !== verdictRefs.length ||
      semanticVerdictRefs.some((ref, index) => ref !== verdictRefs[index]?.digest)
    ) {
      throw new Error("Projection completion semantic refs do not match authoritative artifacts");
    }
    if (
      payload.eventType === "completion.candidate.submitted.v1" &&
      (verdictRefs.length !== 0 ||
        payload.verdictArtifactRef !== null ||
        payload.admissionDecisionArtifactRef !== null ||
        state.status !== "candidate" ||
        state.decisionRef !== null)
    ) {
      throw new Error("Completion candidate event has terminal artifact refs");
    }
    if (
      payload.eventType === "completion.claim_verdict_recorded.v1" &&
      (payload.verdictArtifactRef === undefined ||
        payload.verdictArtifactRef === null ||
        payload.admissionDecisionArtifactRef !== null ||
        verdictRefs.at(-1)?.digest !== payload.verdictArtifactRef.digest ||
        state.status !== "candidate" ||
        state.decisionRef !== null)
    ) {
      throw new Error("Completion verdict event is missing its exact terminal verdict ref");
    }
    if (
      payload.eventType === "completion.decision_recorded.v1" &&
      (payload.verdictArtifactRef !== null ||
        payload.admissionDecisionArtifactRef === undefined ||
        payload.admissionDecisionArtifactRef === null ||
        state.status !== "admitted" ||
        state.decisionRef !== payload.admissionDecisionArtifactRef.digest)
    ) {
      throw new Error("Completion admission event is missing its canonical decision ref");
    }
  }
  if (family === "dispatch") {
    if (
      canonicalJson(state.destinationReceiptRef) !== canonicalJson(payload.destinationReceiptRef) ||
      canonicalJson(state.definiteFailureProofRef) !==
        canonicalJson(payload.definiteFailureProofRef)
    ) {
      throw new Error("Projection dispatch proof refs do not match event facts");
    }
    if (
      payload.eventType === "dispatch.delivered.v1" &&
      (payload.destinationReceiptRef === null || payload.definiteFailureProofRef !== null)
    ) {
      throw new Error("Delivered dispatch is missing its exact destination receipt ref");
    }
    if (
      payload.eventType === "dispatch.failed.v1" &&
      (payload.destinationReceiptRef !== null || payload.definiteFailureProofRef === null)
    ) {
      throw new Error("Definitely failed dispatch is missing its sanitized proof ref");
    }
  }
}

function completionStateWithAuthoritativeStakes(
  db: Database,
  payload: Ledger.NativeEventPayloadV1,
  snapshotState: Record<string, unknown>,
  envelope: Ledger.EnvelopeV1,
): Record<string, unknown> {
  if (envelope.event.eventType === "completion.candidate.submitted.v1") {
    return {
      ...snapshotState,
      stakesAsOfLedgerSeq: envelope.ledgerSeq,
      stakesAsOfDbMs: envelope.committedAtDbMs,
    };
  }
  const candidateId = requiredPayloadString(payload, "candidateId");
  const prior = db
    .query<CompletionArtifactStateRow, [string]>(
      "SELECT state_json FROM completion_projection WHERE completion_id = ?",
    )
    .get(candidateId);
  if (prior === null) return snapshotState;
  let priorState: Record<string, unknown>;
  try {
    const decoded: unknown = JSON.parse(prior.state_json);
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new Error("Completion projection state must be an object");
    }
    priorState = decoded as Record<string, unknown>;
  } catch {
    throw new Error("Prior completion artifact projection is malformed");
  }
  return {
    ...snapshotState,
    stakesAsOfLedgerSeq: priorState.stakesAsOfLedgerSeq,
    stakesAsOfDbMs: priorState.stakesAsOfDbMs,
  };
}

interface CompletionArtifactStateRow {
  readonly state_json: string;
}

function assertCompletionArtifactProgression(
  db: Database,
  payload: Ledger.NativeEventPayloadV1,
  state: Record<string, unknown>,
): void {
  const candidateId = requiredPayloadString(payload, "candidateId");
  const prior = db
    .query<CompletionArtifactStateRow, [string]>(
      "SELECT state_json FROM completion_projection WHERE completion_id = ?",
    )
    .get(candidateId);
  if (payload.eventType === "completion.candidate.submitted.v1") {
    if (prior !== null) throw new Error("Completion candidate artifact is immutable");
    return;
  }
  if (prior === null) throw new Error("Completion artifact event precedes its candidate");
  let priorState: Record<string, unknown>;
  try {
    const decoded: unknown = JSON.parse(prior.state_json);
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded))
      throw new Error("Completion projection state must be an object");
    priorState = decoded as Record<string, unknown>;
  } catch {
    throw new Error("Prior completion artifact projection is malformed");
  }
  if (
    canonicalJson(priorState.candidateArtifactRef) !== canonicalJson(state.candidateArtifactRef) ||
    priorState.stakesAsOfLedgerSeq !== state.stakesAsOfLedgerSeq ||
    priorState.stakesAsOfDbMs !== state.stakesAsOfDbMs
  ) {
    throw new Error("Completion candidate identity or stakes boundary changed");
  }
  const priorRefs = priorState.verdictArtifactRefs;
  const nextRefs = state.verdictArtifactRefs;
  if (!Array.isArray(priorRefs) || !Array.isArray(nextRefs)) {
    throw new Error("Completion verdict artifact coverage is malformed");
  }
  const expectedLength =
    payload.eventType === "completion.claim_verdict_recorded.v1"
      ? priorRefs.length + 1
      : priorRefs.length;
  if (
    nextRefs.length !== expectedLength ||
    priorRefs.some((ref, index) => canonicalJson(ref) !== canonicalJson(nextRefs[index]))
  ) {
    throw new Error("Completion verdict artifact coverage is not append-only and exact");
  }
}

function validateConfigurationSnapshot(
  family: ProductionFamily,
  snapshot: Record<string, unknown>,
  payload: Ledger.NativeEventPayloadV1,
  ownerKey: string,
): Record<string, unknown> {
  const keys = Object.keys(snapshot).sort();
  const expected = [
    "command",
    "occurredAtDbMs",
    "operationId",
    "owner",
    "payload",
    "recordVersion",
    "subjectId",
    "version",
  ];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(`Projection ${family} configuration artifact is not closed`);
  }
  if (snapshot.version !== "configuration-artifact-v1") {
    throw new Error(`Projection ${family} configuration artifact has invalid version`);
  }
  if (
    snapshot.subjectId !== payload.subjectId ||
    snapshot.occurredAtDbMs !== payload.occurredAtDbMs
  ) {
    throw new Error(`Projection ${family} configuration artifact identity mismatch`);
  }
  const owner = snapshot.owner;
  if (
    owner === null ||
    typeof owner !== "object" ||
    Array.isArray(owner) ||
    (owner as Record<string, unknown>).ownerKey !== ownerKey ||
    (owner as Record<string, unknown>).version !== "ledger-owner-v1" ||
    Object.keys(owner as Record<string, unknown>).length !== 2
  ) {
    throw new Error(`Projection ${family} configuration artifact owner mismatch`);
  }
  const artifactPayload = snapshot.payload;
  if (
    artifactPayload === null ||
    typeof artifactPayload !== "object" ||
    Array.isArray(artifactPayload)
  ) {
    throw new Error(`Projection ${family} configuration artifact payload must be an object`);
  }
  const record = artifactPayload as Record<string, unknown>;
  validateConfigurationArtifactPayload(record, snapshot, ownerKey);
  if (canonicalJson(owner) !== canonicalJson(record.owner)) {
    throw new Error(`Projection ${family} configuration artifact owner facts disagree`);
  }
  if (!configurationOperationMatchesFamily(family, snapshot.operationId, payload.eventType)) {
    throw new Error(`Projection ${family} configuration artifact belongs to another family`);
  }
  if (
    record.subjectId !== payload.subjectId ||
    record.occurredAtDbMs !== payload.occurredAtDbMs ||
    record.recordVersion !== snapshot.recordVersion ||
    record.operationId !== snapshot.operationId ||
    record.command !== snapshot.command
  ) {
    throw new Error(`Projection ${family} configuration artifact payload mismatch`);
  }
  crossCheckProjectionIdentity(family, record, payload);
  return record;
}

function configurationOperationMatchesFamily(
  family: ProductionFamily,
  operationId: unknown,
  eventType: string,
): boolean {
  if (typeof operationId !== "string") return false;
  if (CONFIGURATION_EVENT_BY_OPERATION[operationId] !== eventType) return false;
  if (family === "artifact-reference") return operationId.startsWith("AF-");
  if (family === "actor-identity") return operationId.startsWith("AI-");
  if (family === "actor-endpoint") return operationId.startsWith("AE-");
  if (family === "blacklist") return operationId.startsWith("BL-");
  if (family === "channel-grant") return operationId.startsWith("CG-");
  return operationId.startsWith("CI-");
}

function validateConfigurationArtifactPayload(
  record: Record<string, unknown>,
  artifact: Record<string, unknown>,
  ownerKey: string,
): void {
  const operationId = artifact.operationId;
  if (typeof operationId !== "string")
    throw new Error("Configuration artifact requires operationId");
  const base = [
    "command",
    "occurredAtDbMs",
    "operationId",
    "owner",
    "recordVersion",
    "subjectId",
    "version",
  ];
  const extra =
    operationId === "AF-01"
      ? ["artifactId", "contentRef", "title"]
      : operationId === "AI-01" || operationId === "AI-02"
        ? ["identity"]
        : operationId === "AE-01" || operationId === "AE-02"
          ? ["endpoint"]
          : operationId === "BL-01" || operationId === "BL-02"
            ? ["entry"]
            : operationId === "CG-01" || operationId === "CG-02"
              ? ["grant"]
              : operationId.startsWith("CI-") && operationId !== "CI-09"
                ? ["installation", ...(record.effect === undefined ? [] : ["effect"])]
                : [];
  const expected = [...base, ...extra].sort();
  const actual = Object.keys(record).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("Configuration artifact payload is not closed for its operation");
  }
  const catalog = Execution.ConfigurationOperationCatalogV1.find(({ id }) => id === operationId);
  if (operationId === "AF-01") {
    Execution.ContentBlobRefV1.parse(record.contentRef);
    if (
      record.artifactId !== record.subjectId ||
      typeof record.title !== "string" ||
      record.title.length === 0
    )
      throw new Error("Configuration artifact reference facts are invalid");
  } else if (operationId === "AI-01" || operationId === "AI-02") {
    const identity = Actor.Identity.strict().parse(record.identity);
    if (identity.id !== record.subjectId) throw new Error("Configuration actor identity mismatch");
  } else if (operationId === "AE-01" || operationId === "AE-02") {
    const endpoint = Actor.Endpoint.strict().parse(record.endpoint);
    if (endpoint.id !== record.subjectId) throw new Error("Configuration actor endpoint mismatch");
  } else if (operationId === "BL-01" || operationId === "BL-02") {
    const entry = Actor.BlacklistEntry.strict().parse(record.entry);
    if (entry.id !== record.subjectId) throw new Error("Configuration blacklist identity mismatch");
  } else if (operationId === "CG-01" || operationId === "CG-02") {
    const grant = Actor.ChannelGrant.strict().parse(record.grant);
    if (grant.id !== record.subjectId)
      throw new Error("Configuration channel grant identity mismatch");
  } else if (operationId.startsWith("CI-") && operationId !== "CI-09") {
    const installation = AppConnector.Installation.parse(record.installation);
    if (installation.id !== record.subjectId)
      throw new Error("Configuration connector installation identity mismatch");
    if (record.effect !== undefined) Ledger.EffectRefV1.parse(record.effect);
  }
  if (
    catalog === undefined ||
    record.version !== "configuration-operation-payload-v1" ||
    record.command !== catalog.command ||
    artifact.command !== catalog.command ||
    !Number.isInteger(record.recordVersion) ||
    (record.recordVersion as number) <= 0 ||
    !Number.isInteger(record.occurredAtDbMs) ||
    (record.occurredAtDbMs as number) < 0
  ) {
    throw new Error("Configuration artifact payload has invalid versioned facts");
  }
  const owner = record.owner;
  if (
    owner === null ||
    typeof owner !== "object" ||
    Array.isArray(owner) ||
    (owner as Record<string, unknown>).version !== "ledger-owner-v1" ||
    (owner as Record<string, unknown>).ownerKey !== ownerKey ||
    Object.keys(owner as Record<string, unknown>).length !== 2
  ) {
    throw new Error("Configuration artifact payload owner mismatch");
  }
}

function crossCheckProjectionIdentity(
  family: ProductionFamily,
  state: Record<string, unknown>,
  payload: Ledger.NativeEventPayloadV1,
): void {
  const checks: readonly [string, unknown][] =
    family === "session"
      ? [["id", payload.sessionId]]
      : family === "message"
        ? [
            ["id", payload.messageId],
            ["sessionId", payload.sessionId],
          ]
        : family === "part"
          ? [["id", payload.partId]]
          : family === "surface"
            ? [
                ["surfaceKey", payload.surfaceId],
                ["sessionId", payload.sessionId],
              ]
            : family === "dispatch"
              ? [["dispatchId", payload.dispatchId]]
              : family === "work"
                ? [
                    ["id", payload.workItemId],
                    ["sessionId", payload.sessionId],
                  ]
                : family === "attempt"
                  ? [
                      ["attemptId", payload.attemptId],
                      ["workItemId", payload.workItemId],
                      ["sessionId", payload.sessionId],
                    ]
                  : family === "wait"
                    ? [["waitId", payload.waitId]]
                    : family === "worker-grant"
                      ? [["grantId", payload.grantId]]
                      : family === "schedule"
                        ? [["scheduleId", payload.scheduleId]]
                        : family === "completion"
                          ? [
                              ["candidateId", payload.candidateId],
                              ["workItemId", payload.workItemId],
                            ]
                          : family === "effect"
                            ? [
                                ["effectId", payload.effectId],
                                ["workItemId", payload.workItemId],
                                ["attemptId", payload.attemptId],
                              ]
                            : family === "route"
                              ? [["routeId", payload.routeId]]
                              : [["subjectId", payload.subjectId]];
  for (const [field, expected] of checks) {
    if (expected === undefined || state[field] !== expected) {
      throw new Error(`Projection ${family} snapshot ${field} does not match event facts`);
    }
  }
}

function assertSurfaceBindingClaim(
  db: Database,
  eventType: string,
  surfaceKey: string,
  sessionId: string,
): void {
  if (eventType !== "surface.bound.v1") return;
  const existing = db
    .query("SELECT session_id FROM surface_binding_projection WHERE surface_key = ?")
    .get(surfaceKey) as { readonly session_id: string } | null;
  if (existing !== null && existing.session_id !== sessionId) {
    throw new SurfaceBindingProjectionConflictError(surfaceKey, sessionId, existing.session_id);
  }
}

class SurfaceBindingProjectionConflictError extends Error {
  readonly code = "head_conflict" as const;

  constructor(
    readonly surfaceKey: string,
    readonly claimedSessionId: string,
    readonly existingSessionId: string,
  ) {
    super("Surface binding is already claimed by another session");
    this.name = "SurfaceBindingProjectionConflictError";
  }
}

function upsert(
  db: Database,
  table: string,
  leadingColumns: readonly string[],
  values: readonly ProjectionValue[],
): void {
  const columns = [
    ...leadingColumns,
    "owner_key",
    "state_json",
    "source_event_id",
    "source_owner_seq",
    "source_ledger_seq",
    "source_owner_hash",
    "updated_at_db_ms",
  ];
  const update = columns
    .filter((column) => column !== leadingColumns[0])
    .map((column) => `${column} = excluded.${column}`)
    .join(", ");
  db.query(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})
     ON CONFLICT(${leadingColumns[0]}) DO UPDATE SET ${update}`,
  ).run(...values);
}

type ProjectionValue = string | number | bigint | boolean | Uint8Array | null;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function requiredNonNegativeInteger(
  state: Record<string, unknown>,
  keys: readonly string[],
): number {
  for (const key of keys) {
    const value = state[key];
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  }
  throw new Error(`Projection snapshot requires non-negative integer ${keys.join(" or ")}`);
}

function requiredPayloadString(payload: Ledger.NativeEventPayloadV1, key: string): string {
  const value = Reflect.get(payload, key);
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Native event payload ${key} must be a non-empty string`);
  }
  return value;
}

function requiredOwnerKey(owner: Ledger.OwnerV1 | undefined, key: string): string {
  if (!owner) throw new TypeError(`Native event payload ${key} must be present`);
  return owner.ownerKey;
}
function requiredStateString(state: Record<string, unknown>, key: string): string {
  const value = state[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Projection snapshot requires non-empty string ${key}`);
  }
  return value;
}

function requiredNestedStateString(
  state: Record<string, unknown>,
  path: readonly string[],
): string {
  let value: unknown = state;
  for (const key of path) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Projection snapshot requires non-empty string ${path.join(".")}`);
    }
    value = (value as Record<string, unknown>)[key];
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Projection snapshot requires non-empty string ${path.join(".")}`);
  }
  return value;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
