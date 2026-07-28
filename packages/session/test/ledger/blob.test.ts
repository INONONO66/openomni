import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { Ledger } from "@openomni/protocol";
import {
  ArtifactBlobIntegrityError,
  ArtifactBlobStore,
  type ArtifactBlobHash,
} from "../../src/ledger/blob.js";
import { createProductionLedgerProjections } from "../../src/ledger/projection.js";
import { createLedgerQuery } from "../../src/ledger/query.js";
import { createLedgerWriter, NativeProjectionCapabilityError } from "../../src/ledger/writer.js";
import { initializeSqliteDatabase } from "../../src/storage/sqlite-schema-lifecycle.js";
import {
  appendBatch,
  createLedgerFixture as createLegacyLedgerFixture,
  event,
  genesis,
  owner,
} from "./fixture.js";

function hash(bytes: Uint8Array): ArtifactBlobHash {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function createLedgerFixture(options: { readonly verifyNativeReferences?: boolean } = {}) {
  if (options.verifyNativeReferences) {
    const db = new Database(":memory:", { strict: true });
    initializeSqliteDatabase(db);
    const projections = createProductionLedgerProjections(db);
    return {
      db,
      writer: createLedgerWriter(db, projections),
      query: createLedgerQuery(db),
      blobs: {
        read: (contentHash: ArtifactBlobHash) => new ArtifactBlobStore(db).read(contentHash),
      },
      projections,
      close: () => db.close(),
    };
  }
  const fixture = createLegacyLedgerFixture({ includeNativeProjectionCapability: true });
  fixture.db.exec(`
    DROP TABLE artifact_blob;
    CREATE TABLE artifact_blob (
      content_hash TEXT PRIMARY KEY NOT NULL,
      byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
      bytes BLOB NOT NULL,
      created_at_db_ms INTEGER NOT NULL CHECK (created_at_db_ms >= 0),
      CHECK (length(bytes) = byte_length)
    ) STRICT;
  `);
  const emptySnapshot = new TextEncoder().encode("{}");
  fixture.db
    .query(
      "INSERT INTO artifact_blob (content_hash, byte_length, bytes, created_at_db_ms) VALUES (?, ?, ?, 0)",
    )
    .run(hash(emptySnapshot), emptySnapshot.byteLength, emptySnapshot);
  return fixture;
}

function firstProjectionCheckpoint(fixture: ReturnType<typeof createLedgerFixture>): number {
  const projection = fixture.projections[0];
  if (!projection) throw new Error("expected native projection capability");
  return projection.checkpoint();
}

function af01Append(contentBytes: Uint8Array) {
  const contentRef = {
    version: "content-blob-ref-v1" as const,
    digest: hash(contentBytes).slice("sha256:".length),
    byteLength: contentBytes.byteLength,
    mediaType: "application/octet-stream",
  };
  const operation = {
    version: "configuration-operation-payload-v1" as const,
    operationId: "AF-01",
    command: "artifact.put_and_reference.v1",
    owner: owner(),
    subjectId: "artifact-1",
    recordVersion: 1,
    occurredAtDbMs: 1,
    artifactId: "artifact-1",
    contentRef,
    title: "Artifact",
  };
  const artifactBytes = new TextEncoder().encode(
    JSON.stringify({
      version: "configuration-artifact-v1",
      operationId: operation.operationId,
      command: operation.command,
      owner: operation.owner,
      subjectId: operation.subjectId,
      recordVersion: operation.recordVersion,
      occurredAtDbMs: operation.occurredAtDbMs,
      payload: operation,
    }),
  );
  const configurationSnapshotRef = {
    version: "content-blob-ref-v1" as const,
    digest: hash(artifactBytes).slice("sha256:".length),
    byteLength: artifactBytes.byteLength,
    mediaType: "application/json",
  };
  const afEvent = Ledger.EventV1.parse({
    version: "ledger-event-v1",
    eventId: "artifact-reference-1",
    eventType: "artifact.referenced.v1",
    eventVersion: 1,
    owner: owner(),
    payload: {
      version: "native-event-payload-v1",
      eventType: "artifact.referenced.v1",
      subjectId: "artifact-1",
      occurredAtDbMs: 1,
      configurationSnapshotRef,
    },
    provenance: {
      version: "native-event-provenance-v1",
      principalId: "principal-a",
      requestId: "af-01",
    },
  });
  return {
    artifactBytes,
    contentRef,
    event: afEvent,
    request: appendBatch({ requestId: "af-01", events: [afEvent] }),
  };
}

describe("dormant artifact blob contract", () => {
  test("inserts, deduplicates, and reads immutable bytes", () => {
    const fixture = createLedgerFixture();
    try {
      const bytes = new TextEncoder().encode("artifact bytes");
      const contentHash = hash(bytes);
      fixture.writer.append(appendBatch({ requestId: "insert", events: [event("insert")] }), {
        artifactBlobs: [{ bytes }, { bytes: bytes.slice(), expectedHash: contentHash }],
      });
      expect(fixture.db.query("SELECT COUNT(*) AS count FROM artifact_blob").get()).toEqual({
        count: 2,
      });
      const stored = fixture.db
        .query("SELECT byte_length, created_at_db_ms FROM artifact_blob WHERE content_hash = ?")
        .get(contentHash) as { readonly byte_length: number; readonly created_at_db_ms: number };
      expect(stored.byte_length).toBe(bytes.byteLength);
      expect(stored.created_at_db_ms).toBeGreaterThanOrEqual(0);
      expect("insert" in new ArtifactBlobStore(fixture.db)).toBe(false);
      expect(fixture.blobs.read(contentHash)).toEqual({
        hash: contentHash,
        bytes,
        size: bytes.byteLength,
      });
    } finally {
      fixture.close();
    }
  });

  test("rejects an expected hash with different bytes before insertion", () => {
    const fixture = createLedgerFixture();
    try {
      const expectedHash = hash(new TextEncoder().encode("expected"));
      expect(() =>
        fixture.writer.append(
          appendBatch({ requestId: "hash-mismatch", events: [event("hash-mismatch")] }),
          { artifactBlobs: [{ bytes: new TextEncoder().encode("different"), expectedHash }] },
        ),
      ).toThrow(ArtifactBlobIntegrityError);
      expect(fixture.blobs.read(expectedHash)).toBeUndefined();
      expect(fixture.query.appendResult("hash-mismatch")).toBeUndefined();
      expect(fixture.query.eventsByLedgerSequence({ throughLedgerSeq: 1 })).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test("rejects colliding content or corrupt byte length without committing the append", () => {
    for (const corruption of ["content", "byte_length"] as const) {
      const fixture = createLedgerFixture();
      try {
        const bytes = new TextEncoder().encode(`canonical-${corruption}`);
        const contentHash = hash(bytes);
        const collision = new TextEncoder().encode("collision");
        const storedBytes = corruption === "content" ? collision : bytes;
        const storedLength =
          corruption === "byte_length" ? storedBytes.byteLength + 1 : storedBytes.byteLength;
        fixture.db.exec("PRAGMA ignore_check_constraints = ON");
        fixture.db
          .query(
            `INSERT INTO artifact_blob (content_hash, byte_length, bytes, created_at_db_ms)
             VALUES (?, ?, ?, 0)`,
          )
          .run(contentHash, storedLength, storedBytes);
        fixture.db.exec("PRAGMA ignore_check_constraints = OFF");
        const requestId = `collision-${corruption}`;

        let rejection: unknown;
        try {
          fixture.writer.append(appendBatch({ requestId, events: [event(requestId)] }), {
            artifactBlobs: [{ bytes, expectedHash: contentHash }],
          });
        } catch (error) {
          rejection = error;
        }
        expect(rejection).toBeInstanceOf(ArtifactBlobIntegrityError);
        const integrityError = rejection as ArtifactBlobIntegrityError;
        if (corruption === "content") {
          expect(integrityError.reason).toBe("content_mismatch");
          expect(integrityError.expectedHash).toBe(contentHash);
          expect(integrityError.actualHash).toBeUndefined();
          expect(integrityError.expectedLength).toBeUndefined();
          expect(integrityError.actualLength).toBeUndefined();
        } else {
          expect(integrityError.reason).toBe("length_mismatch");
          expect(integrityError.expectedHash).toBe(contentHash);
          expect(integrityError.actualHash).toBe(contentHash);
          expect(integrityError.expectedLength).toBe(storedLength);
          expect(integrityError.actualLength).toBe(storedBytes.byteLength);
        }
        expect(fixture.query.appendResult(requestId)).toBeUndefined();
        expect(fixture.query.eventsByLedgerSequence({ throughLedgerSeq: 10 })).toEqual([]);
        expect(fixture.query.head(genesis().owner)).toEqual(genesis());
      } finally {
        fixture.close();
      }
    }
  });

  test("returns missing and rejects corrupted content or length", () => {
    const fixture = createLedgerFixture();
    try {
      const missing = `sha256:${"0".repeat(64)}` as ArtifactBlobHash;
      expect(fixture.blobs.read(missing)).toBeUndefined();

      const bytes = new TextEncoder().encode("original");
      const contentHash = hash(bytes);
      fixture.writer.append(appendBatch({ requestId: "original", events: [event("original")] }), {
        artifactBlobs: [{ bytes, expectedHash: contentHash }],
      });
      fixture.db
        .query("UPDATE artifact_blob SET bytes = ? WHERE content_hash = ?")
        .run(new TextEncoder().encode("tampered"), contentHash);
      expect(() => fixture.blobs.read(contentHash)).toThrow(ArtifactBlobIntegrityError);

      const second = new TextEncoder().encode("length-check");
      const secondHash = hash(second);
      const first = fixture.query.head(owner());
      fixture.writer.append(
        appendBatch({
          requestId: "length-check",
          expectedHead: first,
          events: [event("length-check")],
        }),
        { artifactBlobs: [{ bytes: second, expectedHash: secondHash }] },
      );
      fixture.db.exec("PRAGMA ignore_check_constraints = ON");
      fixture.db
        .query("UPDATE artifact_blob SET byte_length = ? WHERE content_hash = ?")
        .run(1, secondHash);
      fixture.db.exec("PRAGMA ignore_check_constraints = OFF");
      let lengthRejection: unknown;
      try {
        fixture.blobs.read(secondHash);
      } catch (error) {
        lengthRejection = error;
      }
      expect(lengthRejection).toBeInstanceOf(ArtifactBlobIntegrityError);
      expect(lengthRejection).toMatchObject({
        reason: "length_mismatch",
        expectedHash: secondHash,
        actualHash: secondHash,
        expectedLength: 1,
        actualLength: second.byteLength,
      });
    } finally {
      fixture.close();
    }
  });

  test("rolls blob insertion back with a failed ledger append", () => {
    const fixture = createLedgerFixture();
    try {
      fixture.writer.append(appendBatch({ requestId: "seed", events: [event("duplicate")] }));
      const bytes = new TextEncoder().encode("must roll back");
      const contentHash = hash(bytes);
      const ownerB = owner("owner-b");

      expect(() =>
        fixture.writer.append(
          appendBatch({ requestId: "failed", owner: ownerB, events: [event("duplicate", ownerB)] }),
          { artifactBlobs: [{ bytes, expectedHash: contentHash }] },
        ),
      ).toThrow();
      expect(fixture.blobs.read(contentHash)).toBeUndefined();
    } finally {
      fixture.close();
    }
  });

  test("rejects native events when only a name-forged production capability is registered", () => {
    const fixture = createLegacyLedgerFixture({
      projections: [
        {
          name: "native.forged-capability",
          identity: "v1",
          applyCompleteBatch: () => undefined,
        },
      ],
      includeNativeProjectionCapability: false,
    });
    try {
      const prepared = af01Append(new TextEncoder().encode("missing nested content"));
      expect(() => fixture.writer.append(prepared.request)).toThrow(
        NativeProjectionCapabilityError,
      );
      expect(fixture.query.appendResult("af-01")).toBeUndefined();
    } finally {
      fixture.close();
    }
  });

  test("rejects AF-01 when nested content is missing and rolls the append back", () => {
    const fixture = createLedgerFixture({ verifyNativeReferences: true });
    try {
      const prepared = af01Append(new TextEncoder().encode("missing nested content"));
      expect(() =>
        fixture.writer.append(prepared.request, {
          artifactBlobs: [{ bytes: prepared.artifactBytes }],
        }),
      ).toThrow(`Referenced artifact blob sha256:${prepared.contentRef.digest} is missing`);

      expect(fixture.query.appendResult("af-01")).toBeUndefined();
      expect(fixture.query.eventsByLedgerSequence({ throughLedgerSeq: 1 })).toEqual([]);
      expect(fixture.query.head(owner())).toEqual(genesis());
      expect(fixture.db.query("SELECT COUNT(*) AS count FROM artifact_blob").get()).toEqual({
        count: 0,
      });
      expect(firstProjectionCheckpoint(fixture)).toBe(0);
    } finally {
      fixture.close();
    }
  });

  test("rejects AF-01 when nested content bytes are corrupt and rolls new state back", () => {
    const fixture = createLedgerFixture({ verifyNativeReferences: true });
    try {
      const prepared = af01Append(new TextEncoder().encode("canonical nested content"));
      const corrupt = new TextEncoder().encode("corrupt nested content");
      fixture.db
        .query(
          `INSERT INTO artifact_blob (content_hash, byte_length, bytes, created_at_db_ms)
           VALUES (?, ?, ?, 0)`,
        )
        .run(`sha256:${prepared.contentRef.digest}`, corrupt.byteLength, corrupt);

      expect(() =>
        fixture.writer.append(prepared.request, {
          artifactBlobs: [{ bytes: prepared.artifactBytes }],
        }),
      ).toThrow(ArtifactBlobIntegrityError);

      expect(fixture.query.appendResult("af-01")).toBeUndefined();
      expect(fixture.query.eventsByLedgerSequence({ throughLedgerSeq: 1 })).toEqual([]);
      expect(fixture.query.head(owner())).toEqual(genesis());
      expect(fixture.blobs.read(hash(prepared.artifactBytes))).toBeUndefined();
      expect(firstProjectionCheckpoint(fixture)).toBe(0);
    } finally {
      fixture.close();
    }
  });

  test("commits and deduplicates valid AF-01 nested content without rerunning retry writes", () => {
    const fixture = createLedgerFixture({ verifyNativeReferences: true });
    try {
      const contentBytes = new TextEncoder().encode("valid nested content");
      const prepared = af01Append(contentBytes);
      const options = {
        artifactBlobs: [
          { bytes: prepared.artifactBytes },
          { bytes: contentBytes, expectedHash: hash(contentBytes) },
          { bytes: contentBytes.slice(), expectedHash: hash(contentBytes) },
        ],
      };
      const receipt = fixture.writer.append(prepared.request, options);
      expect(fixture.writer.append(prepared.request, options)).toEqual(receipt);

      expect(fixture.query.eventsByLedgerSequence({ throughLedgerSeq: 2 })).toHaveLength(1);
      expect(fixture.db.query("SELECT COUNT(*) AS count FROM artifact_blob").get()).toEqual({
        count: 2,
      });
      expect(fixture.blobs.read(hash(contentBytes))?.bytes).toEqual(contentBytes);
      expect(firstProjectionCheckpoint(fixture)).toBe(1);
    } finally {
      fixture.close();
    }
  });
});
