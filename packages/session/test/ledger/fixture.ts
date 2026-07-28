import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { Ledger } from "@openomni/protocol";
import { readArtifactBlob } from "../../src/ledger/blob.js";
import {
  createLedgerProjection,
  createProductionLedgerProjections,
  type ProjectionDefinition,
} from "../../src/ledger/projection.js";
import { createLedgerQuery } from "../../src/ledger/query.js";
import { createLedgerWriter } from "../../src/ledger/writer.js";
import { initializeSqliteDatabase } from "../../src/storage/sqlite-schema-lifecycle.js";

export const HASH_A = "a".repeat(64);
export const HASH_B = "b".repeat(64);
export const HASH_C = "c".repeat(64);
export function projectionSnapshot(family: string, state: Record<string, unknown>) {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ version: `${family}-projection-state-v1`, state }),
  );
  return {
    bytes,
    ref: {
      version: "content-blob-ref-v1" as const,
      digest: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
      mediaType: "application/json",
    },
  };
}

export function createLedgerFixture(
  options: {
    readonly projections?: readonly ProjectionDefinition[];
    readonly includeNativeProjectionCapability?: boolean;
  } = {},
) {
  const db = new Database(":memory:", { strict: true });
  if (options.includeNativeProjectionCapability === true) {
    initializeSqliteDatabase(db);
    db.query(
      "INSERT INTO artifact_blob (content_hash, byte_length, bytes, created_at_db_ms) VALUES (?, ?, ?, 0)",
    ).run(
      `sha256:${EMPTY_BLOB_REF.digest}`,
      EMPTY_BLOB_REF.byteLength,
      new TextEncoder().encode("{}"),
    );
    const projections = (options.projections ?? []).map((definition) =>
      createLedgerProjection(db, definition),
    );
    const nativeProjection = createProductionLedgerProjections(db).at(-1);
    if (nativeProjection === undefined) {
      throw new Error("Production ledger projections must include the native route projection");
    }
    projections.push(nativeProjection);
    return {
      db,
      writer: createLedgerWriter(db, projections),
      query: createLedgerQuery(db),
      blobs: { read: (hash: Parameters<typeof readArtifactBlob>[1]) => readArtifactBlob(db, hash) },
      projections,
      close: () => db.close(),
    };
  }
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE ledger_head (
      owner_key TEXT PRIMARY KEY NOT NULL,
      owner_seq INTEGER NOT NULL CHECK (owner_seq > 0),
      event_hash TEXT NOT NULL CHECK (length(event_hash) = 64)
    ) STRICT;

    CREATE TABLE ledger_request (
      request_id TEXT PRIMARY KEY NOT NULL,
      request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
      principal_id TEXT NOT NULL,
      owner_key TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      option_manifest_json TEXT NOT NULL CHECK (json_valid(option_manifest_json)),
      receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
      first_ledger_seq INTEGER NOT NULL CHECK (first_ledger_seq > 0),
      last_ledger_seq INTEGER NOT NULL CHECK (last_ledger_seq >= first_ledger_seq),
      UNIQUE (owner_key, batch_id)
    ) STRICT;

    CREATE TABLE ledger_event (
      ledger_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      owner_key TEXT NOT NULL,
      owner_seq INTEGER NOT NULL CHECK (owner_seq > 0),
      previous_hash TEXT NOT NULL,
      content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
      event_version INTEGER NOT NULL CHECK (event_version = 1),
      envelope_version INTEGER NOT NULL CHECK (envelope_version = 1),
      event_type TEXT NOT NULL,
      canonical_payload TEXT NOT NULL CHECK (json_valid(canonical_payload)),
      canonical_provenance TEXT NOT NULL CHECK (json_valid(canonical_provenance)),
      batch_id TEXT NOT NULL,
      batch_index INTEGER NOT NULL CHECK (batch_index >= 0),
      batch_size INTEGER NOT NULL CHECK (batch_size BETWEEN 1 AND 64 AND batch_index < batch_size),
      request_id TEXT NOT NULL,
      request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
      principal_id TEXT NOT NULL,
      committed_at_db_ms INTEGER NOT NULL CHECK (committed_at_db_ms >= 0),
      UNIQUE (owner_key, owner_seq),
      UNIQUE (owner_key, batch_id, batch_index),
      UNIQUE (request_id, batch_index)
    ) STRICT;

    CREATE TABLE projection_checkpoint (
      projection_name TEXT PRIMARY KEY NOT NULL,
      projection_identity TEXT NOT NULL,
      ledger_seq INTEGER NOT NULL CHECK (ledger_seq >= 0),
      updated_at_db_ms INTEGER NOT NULL CHECK (updated_at_db_ms >= 0)
    ) STRICT;

    CREATE TABLE artifact_blob (
      content_hash TEXT PRIMARY KEY NOT NULL,
      content BLOB NOT NULL,
      byte_length INTEGER NOT NULL CHECK (byte_length >= 0)
    ) STRICT;
  `);
  const projections = (options.projections ?? []).map((definition) =>
    createLedgerProjection(db, definition),
  );

  return {
    db,
    writer: createLedgerWriter(db, projections),
    query: createLedgerQuery(db),
    blobs: { read: (hash: Parameters<typeof readArtifactBlob>[1]) => readArtifactBlob(db, hash) },
    projections,
    close: () => db.close(),
  };
}

export function owner(ownerKey = "owner-a"): Ledger.OwnerRef {
  return Ledger.OwnerV1.parse({ version: "ledger-owner-v1", ownerKey });
}

export function genesis(ownerRef = owner()): Ledger.Head {
  return Ledger.HeadV1.parse({
    version: "ledger-head-v1",
    owner: ownerRef,
    ownerSeq: 0,
    eventHash: Ledger.GENESIS_V1,
  });
}

const EMPTY_BLOB_REF = Object.freeze({
  version: "content-blob-ref-v1" as const,
  digest: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
  byteLength: 2,
  mediaType: "application/json",
});
export function event(eventId: string, ownerRef = owner()): Ledger.EventV1 {
  return Ledger.EventV1.parse({
    version: "ledger-event-v1",
    eventId,
    eventType: "session.opened.v1",
    eventVersion: 1,
    owner: ownerRef,
    payload: {
      version: "native-event-payload-v1",
      eventType: "session.opened.v1",
      subjectId: eventId,
      occurredAtDbMs: 1,
      sessionId: eventId,
      parentSessionId: "root",
      model: { provider: "test", id: "test-model" },
      sessionSnapshotRef: EMPTY_BLOB_REF,
    },
    provenance: {
      version: "native-event-provenance-v1",
      principalId: "principal-a",
      requestId: `event-request-${eventId}`,
    },
  });
}

export function appendBatch(input: {
  requestId: string;
  events: readonly Ledger.EventV1[];
  owner?: Ledger.OwnerRef;
  expectedHead?: Ledger.Head;
  requestHash?: string;
  principalId?: string;
  batchId?: string;
}): Ledger.AppendBatch {
  const ownerRef = input.owner ?? owner();
  const principalId = input.principalId ?? "principal-a";
  const events = input.events.map((item) => ({
    ...item,
    provenance: {
      ...item.provenance,
      principalId,
      requestId: input.requestId,
    },
  }));
  return Ledger.AppendBatch.parse({
    version: "ledger-append-batch-request-v1",
    requestId: input.requestId,
    requestHash: input.requestHash ?? HASH_A,
    principalId,
    expectedHead: input.expectedHead ?? genesis(ownerRef),
    batch: {
      version: "ledger-batch-v1",
      batchId: input.batchId ?? `batch-${input.requestId}`,
      owner: ownerRef,
      events,
    },
  });
}
