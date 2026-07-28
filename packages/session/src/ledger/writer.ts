import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { Execution, Ledger } from "@openomni/protocol";
import {
  artifactBlobIdentity,
  type ArtifactBlobHash,
  type InsertArtifactBlobInput,
  insertArtifactBlob,
  readArtifactBlob,
  withArtifactBlobTransaction,
} from "./blob.js";
import {
  type LedgerProjection,
  canonicalEnvelopeHash,
  ProjectionCheckpointConflictError,
  type ProjectionTransaction,
  projectionDefinition,
  verifiesNativeBlobReferences,
  writeCheckpoint,
} from "./projection.js";
import { createLedgerQuery } from "./query.js";

export interface AppendOptions {
  readonly artifactBlobs?: readonly InsertArtifactBlobInput[];
}

export interface LedgerWriter {
  append(batch: Ledger.AppendBatch, options?: AppendOptions): Ledger.AppendResult;
}

export class LedgerWriteError extends Error {
  constructor(readonly detail: Ledger.AppendError) {
    super(
      detail.code === "head_conflict" ? "Ledger owner head conflict" : "Ledger request mismatch",
    );
    this.name = "LedgerWriteError";
  }
}

export class LedgerAppendOptionsMismatchError extends Error {
  readonly code = "ledger_append_options_mismatch" as const;
  readonly reason = "manifest_mismatch" as const;

  constructor(
    readonly requestId: string,
    readonly expectedManifestHash: string,
    readonly actualManifestHash: string,
  ) {
    super(`Ledger request ${requestId} append options do not match the original request`);
    this.name = "LedgerAppendOptionsMismatchError";
  }
}

export class LedgerSchemaError extends Error {
  readonly code = "ledger_schema_invalid" as const;

  constructor(readonly missingColumns: readonly string[]) {
    super(`Ledger schema is missing required columns: ${missingColumns.join(", ")}`);
    this.name = "LedgerSchemaError";
  }
}

export class NativeProjectionCapabilityError extends Error {
  readonly code = "native_projection_capability_missing" as const;

  constructor() {
    super("Native events require the closed production projection capability");
    this.name = "NativeProjectionCapabilityError";
  }
}

export function createLedgerWriter(
  db: Database,
  projections: readonly LedgerProjection[],
): LedgerWriter {
  return new SynchronousLedgerWriter(db, projections);
}

class SynchronousLedgerWriter implements LedgerWriter {
  private readonly projections: readonly PreparedProjection[];
  private readonly verifiesNativeBlobReferences: boolean;

  constructor(
    private readonly db: Database,
    projections: readonly LedgerProjection[],
  ) {
    assertRequiredSchema(this.db);
    this.projections = this.prepareProjections(projections);
    this.verifiesNativeBlobReferences = projections.some(verifiesNativeBlobReferences);
  }

  append(input: Ledger.AppendBatch, options: AppendOptions = {}): Ledger.AppendResult {
    const request = Ledger.AppendBatch.parse(input);
    const preparedOptions = this.prepareOptions(options);
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const receipt = this.appendInTransaction(request, preparedOptions);
      this.db.exec("COMMIT");
      return receipt;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private appendInTransaction(
    request: Ledger.AppendBatch,
    options: PreparedAppendOptions,
  ): Ledger.AppendResult {
    const duplicate = this.db
      .query(
        `SELECT request_hash, principal_id, receipt_json, option_manifest_json
         FROM ledger_request
         WHERE request_id = ?`,
      )
      .get(request.requestId) as RequestRow | null;
    if (duplicate !== null) {
      if (
        duplicate.request_hash !== request.requestHash ||
        duplicate.principal_id !== request.principalId
      ) {
        throw new LedgerWriteError({
          version: "ledger-error-v1",
          code: "idempotency_mismatch",
          requestId: request.requestId,
          expectedRequestHash: duplicate.request_hash,
          actualRequestHash: request.requestHash,
          expectedPrincipalId: duplicate.principal_id,
          actualPrincipalId: request.principalId,
        });
      }
      if (duplicate.option_manifest_json !== options.manifestJson) {
        throw new LedgerAppendOptionsMismatchError(
          request.requestId,
          sha256(duplicate.option_manifest_json),
          options.manifestHash,
        );
      }
      return Ledger.AppendResult.parse(JSON.parse(duplicate.receipt_json));
    }

    const ownerKey = request.batch.owner.ownerKey;
    const actualHead = this.readHead(request.batch.owner);
    if (!headsEqual(request.expectedHead, actualHead)) {
      throw new LedgerWriteError({
        version: "ledger-error-v1",
        code: "head_conflict",
        owner: request.batch.owner,
        expectedHead: request.expectedHead,
        actualHead,
      });
    }

    const previousLedgerTail = this.currentLedgerTail();

    const hasNativeEvents = request.batch.events.some(
      ({ eventType }) => Ledger.NativeEventPayloadSchemasV1[eventType] !== undefined,
    );
    if (hasNativeEvents && !this.verifiesNativeBlobReferences) {
      throw new NativeProjectionCapabilityError();
    }
    for (const blob of options.artifactBlobs) {
      insertArtifactBlob(this.db, blob);
    }
    if (hasNativeEvents) this.verifyReferencedBlobs(request);

    let previousEventHash = actualHead.eventHash;
    let ownerSeq = actualHead.ownerSeq;
    let firstLedgerSeq: number | undefined;
    let lastLedgerSeq: number | undefined;
    const batchSize = request.batch.events.length;

    for (const [batchIndex, event] of request.batch.events.entries()) {
      ownerSeq += 1;
      const canonicalPayload = canonicalJson(event.payload);
      const canonicalProvenance = canonicalJson(event.provenance);
      const eventHash = canonicalEnvelopeHash({
        event,
        batchId: request.batch.batchId,
        batchIndex,
        batchSize,
        ownerSeq,
        previousEventHash,
        requestId: request.requestId,
        requestHash: request.requestHash,
        principalId: request.principalId,
      });
      const row = this.db
        .query(
          `INSERT INTO ledger_event
             (event_id, owner_key, owner_seq, previous_hash, content_hash,
              event_version, envelope_version, event_type, canonical_payload,
              canonical_provenance, batch_id, batch_index, batch_size,
              request_id, request_hash, principal_id, committed_at_db_ms)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                   CAST(unixepoch('subsec') * 1000 AS INTEGER))
           RETURNING ledger_seq`,
        )
        .get(
          event.eventId,
          ownerKey,
          ownerSeq,
          previousEventHash,
          eventHash,
          event.eventVersion,
          event.eventType,
          canonicalPayload,
          canonicalProvenance,
          request.batch.batchId,
          batchIndex,
          batchSize,
          request.requestId,
          request.requestHash,
          request.principalId,
        ) as InsertedEventRow;
      firstLedgerSeq ??= row.ledger_seq;
      lastLedgerSeq = row.ledger_seq;
      previousEventHash = eventHash;
    }

    const head: Ledger.Head = {
      version: "ledger-head-v1",
      owner: request.batch.owner,
      ownerSeq,
      eventHash: previousEventHash,
    };
    this.db
      .query(
        `INSERT INTO ledger_head (owner_key, owner_seq, event_hash)
         VALUES (?, ?, ?)
         ON CONFLICT(owner_key) DO UPDATE SET
           owner_seq = excluded.owner_seq,
           event_hash = excluded.event_hash`,
      )
      .run(ownerKey, ownerSeq, previousEventHash);

    const receiptWithoutHash = {
      version: "ledger-append-receipt-v1" as const,
      requestId: request.requestId,
      requestHash: request.requestHash,
      principalId: request.principalId,
      owner: request.batch.owner,
      previousHead: actualHead,
      head,
      firstLedgerSeq: required(firstLedgerSeq),
      lastLedgerSeq: required(lastLedgerSeq),
      eventIds: request.batch.events.map((event) => event.eventId),
    };
    const receipt = Ledger.AppendResult.parse({
      ...receiptWithoutHash,
      receiptHash: sha256(canonicalJson(receiptWithoutHash)),
    });
    this.db
      .query(
        `INSERT INTO ledger_request
           (request_id, request_hash, principal_id, owner_key, batch_id,
            option_manifest_json, receipt_json, first_ledger_seq, last_ledger_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        request.requestId,
        request.requestHash,
        request.principalId,
        ownerKey,
        request.batch.batchId,
        options.manifestJson,
        canonicalJson(receipt),
        receipt.firstLedgerSeq,
        receipt.lastLedgerSeq,
      );

    this.applyProjections(previousLedgerTail, receipt.lastLedgerSeq, receipt.eventIds);

    return receipt;
  }

  private prepareOptions(options: AppendOptions): PreparedAppendOptions {
    const artifactBlobs = options.artifactBlobs ?? [];
    const blobManifest = artifactBlobs.map(artifactBlobIdentity);
    const manifestJson = canonicalJson({
      artifactBlobs: blobManifest,
      projections: this.projections.map(({ name, identity }) => ({ name, identity })),
    });
    return {
      artifactBlobs,
      manifestJson,
      manifestHash: sha256(manifestJson),
    };
  }

  private prepareProjections(
    projections: readonly LedgerProjection[],
  ): readonly PreparedProjection[] {
    const names = new Set<string>();
    return projections.map((projection): PreparedProjection => {
      const definition = projectionDefinition(projection, this.db);
      if (projection.name !== definition.name || projection.identity !== definition.identity) {
        throw new TypeError("Projection identity does not match its registered definition");
      }
      if (names.has(definition.name)) {
        throw new TypeError(`Projection ${definition.name} was registered more than once`);
      }
      names.add(definition.name);
      return {
        name: definition.name,
        identity: definition.identity,
        checkpoint: projection.checkpoint,
        applyCompleteBatch: definition.applyCompleteBatch,
      };
    });
  }

  private readHead(owner: Ledger.OwnerRef): Ledger.Head {
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

  private applyProjections(
    previousLedgerTail: number,
    lastLedgerSeq: number,
    eventIds: readonly string[],
  ): void {
    const registrations = this.projections;
    if (registrations.length === 0) return;
    for (const { name, checkpoint } of registrations) {
      const observed = checkpoint();
      if (observed !== previousLedgerTail) {
        throw new ProjectionCheckpointConflictError(name, previousLedgerTail, observed);
      }
    }

    const [batch, unexpectedBatch] = createLedgerQuery(this.db).completeBatches({
      afterLedgerSeq: previousLedgerTail,
      throughLedgerSeq: lastLedgerSeq,
      limit: 2,
    });
    if (
      batch === undefined ||
      unexpectedBatch !== undefined ||
      batch.length !== eventIds.length ||
      batch.some((envelope, index) => envelope.event.eventId !== eventIds[index])
    ) {
      throw new Error("Appended ledger batch could not be selected as one complete ordered batch");
    }
    const lastEnvelope = batch.at(-1);
    if (!lastEnvelope) throw new Error("Appended ledger batch cannot be empty");

    for (const { name, identity, applyCompleteBatch } of registrations) {
      const result: unknown = withArtifactBlobTransaction(this.db, (artifactBlobs) => {
        const transaction = Object.freeze({ artifactBlobs }) as ProjectionTransaction;
        return applyCompleteBatch(batch, transaction);
      });
      if (result !== undefined) {
        throw new TypeError(
          `Projection ${name} applyCompleteBatch must return undefined synchronously`,
        );
      }
      writeCheckpoint(
        this.db,
        name,
        identity,
        lastLedgerSeq,
        lastEnvelope.event.payload.occurredAtDbMs,
      );
    }
  }

  private verifyReferencedBlobs(request: Ledger.AppendBatch): void {
    for (const event of request.batch.events) {
      const refs = contentBlobRefsForEvent(event);
      for (const ref of refs) verifyContentBlobRef(this.db, ref);

      if (event.eventType !== "artifact.referenced.v1") continue;
      const configurationRef = event.payload.configurationSnapshotRef;
      if (!isContentBlobRef(configurationRef)) {
        throw new Error("AF-01 event requires a configuration artifact reference");
      }
      const configurationBlob = verifyContentBlobRef(this.db, configurationRef);
      const contentRef = af01ContentRef(configurationBlob.bytes);
      verifyContentBlobRef(this.db, contentRef);
    }
  }

  private currentLedgerTail(): number {
    const row = this.db.query("SELECT MAX(ledger_seq) AS ledger_seq FROM ledger_event").get() as {
      readonly ledger_seq: number | null;
    };
    return row.ledger_seq ?? 0;
  }
}

function headsEqual(expected: Ledger.Head, actual: Ledger.Head): boolean {
  return (
    expected.owner.ownerKey === actual.owner.ownerKey &&
    expected.ownerSeq === actual.ownerSeq &&
    expected.eventHash === actual.eventHash
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError("Ledger canonical JSON cannot encode undefined");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function required(value: number | undefined): number {
  if (value === undefined) throw new Error("Ledger batches must contain at least one event");
  return value;
}

function assertRequiredSchema(db: Database): void {
  const required = new Map([
    ["ledger_request", ["option_manifest_json"]],
    ["projection_checkpoint", ["projection_identity"]],
  ]);
  const missing: string[] = [];
  for (const [table, columnNames] of required) {
    const columns = db.query(`PRAGMA table_info(${table})`).all() as SchemaColumnRow[];
    for (const columnName of columnNames) {
      const column = columns.find((candidate) => candidate.name === columnName);
      if (column === undefined || column.notnull !== 1) {
        missing.push(`${table}.${columnName} NOT NULL`);
      }
    }
  }
  if (missing.length > 0) throw new LedgerSchemaError(missing);
}

interface SchemaColumnRow {
  readonly name: string;
  readonly notnull: number;
}

interface RequestRow {
  readonly request_hash: string;
  readonly principal_id: string;
  readonly receipt_json: string;
  readonly option_manifest_json: string;
}

interface PreparedProjection {
  readonly name: string;
  readonly identity: string;
  readonly checkpoint: () => number;
  readonly applyCompleteBatch: ProjectionDefinitionCallback;
}

type ProjectionDefinitionCallback = ReturnType<typeof projectionDefinition>["applyCompleteBatch"];

interface PreparedAppendOptions {
  readonly artifactBlobs: readonly InsertArtifactBlobInput[];
  readonly manifestJson: string;
  readonly manifestHash: string;
}

interface HeadRow {
  readonly owner_seq: number;
  readonly event_hash: string;
}

interface InsertedEventRow {
  readonly ledger_seq: number;
}

interface ContentBlobRef {
  readonly version: "content-blob-ref-v1";
  readonly digest: string;
  readonly byteLength: number;
  readonly mediaType: string;
}

const CONTENT_BLOB_REF_FIELDS = Object.freeze([
  "sessionSnapshotRef",
  "surfaceSnapshotRef",
  "messageSnapshotRef",
  "partSnapshotRef",
  "authoritySnapshotRef",
  "routeSnapshotRef",
  "dispatchSnapshotRef",
  "workSnapshotRef",
  "runBindingRef",
  "completionSnapshotRef",
  "environmentSnapshotRef",
  "attemptSnapshotRef",
  "waitSnapshotRef",
  "grantScopeRef",
  "grantSnapshotRef",
  "scheduleSnapshotRef",
  "effectScopeRef",
  "effectSettlementRef",
  "configurationSnapshotRef",
] as const);

function contentBlobRefsForEvent(event: Ledger.EventV1): readonly ContentBlobRef[] {
  const refs: ContentBlobRef[] = [];
  for (const field of CONTENT_BLOB_REF_FIELDS) {
    const value = Reflect.get(event.payload, field);
    if (value === undefined || value === null) continue;
    if (!isContentBlobRef(value)) {
      throw new Error(`Native event ${event.eventType} has an invalid ${field}`);
    }
    refs.push(value);
  }
  return refs;
}

function verifyContentBlobRef(db: Database, ref: ContentBlobRef) {
  const hash = `sha256:${ref.digest}` as ArtifactBlobHash;
  const blob = readArtifactBlob(db, hash);
  if (blob === undefined) throw new Error(`Referenced artifact blob ${hash} is missing`);
  if (blob.size !== ref.byteLength) {
    throw new Error(`Referenced artifact blob ${hash} has an unexpected byte length`);
  }
  return blob;
}

function af01ContentRef(bytes: Uint8Array): ContentBlobRef {
  let artifact: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    artifact = JSON.parse(text);
  } catch {
    throw new Error("AF-01 configuration artifact is not valid UTF-8 JSON");
  }
  if (
    !isClosedRecord(artifact, [
      "command",
      "occurredAtDbMs",
      "operationId",
      "owner",
      "payload",
      "recordVersion",
      "subjectId",
      "version",
    ])
  ) {
    throw new Error("AF-01 configuration artifact is not a closed object");
  }
  if (artifact.version !== "configuration-artifact-v1" || artifact.operationId !== "AF-01") {
    throw new Error("AF-01 configuration artifact has an invalid identity");
  }
  if (
    !isClosedRecord(artifact.payload, [
      "artifactId",
      "command",
      "contentRef",
      "occurredAtDbMs",
      "operationId",
      "owner",
      "recordVersion",
      "subjectId",
      "title",
      "version",
    ])
  ) {
    throw new Error("AF-01 configuration artifact payload is not closed");
  }
  return Execution.ContentBlobRefV1.parse(artifact.payload.contentRef);
}

function isClosedRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

function isContentBlobRef(value: unknown): value is ContentBlobRef {
  if (!isClosedRecord(value, ["byteLength", "digest", "mediaType", "version"])) return false;
  return (
    value.version === "content-blob-ref-v1" &&
    typeof value.digest === "string" &&
    typeof value.byteLength === "number" &&
    typeof value.mediaType === "string"
  );
}
