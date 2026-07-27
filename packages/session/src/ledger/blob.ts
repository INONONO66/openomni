import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

export type ArtifactBlobHash = `sha256:${string}`;

export interface ArtifactBlob {
  readonly hash: ArtifactBlobHash;
  readonly bytes: Uint8Array;
  readonly size: number;
}

export interface InsertArtifactBlobInput {
  readonly bytes: Uint8Array;
  readonly expectedHash?: ArtifactBlobHash;
}

export interface ArtifactBlobIdentity {
  readonly hash: ArtifactBlobHash;
  readonly byteLength: number;
}

declare const artifactBlobTransactionBrand: unique symbol;

/** Blob access constrained to a writer-owned append transaction. */
export interface ArtifactBlobTransaction {
  readonly [artifactBlobTransactionBrand]: never;
  insert(input: InsertArtifactBlobInput): ArtifactBlobHash;
  read(hash: ArtifactBlobHash): ArtifactBlob | undefined;
}

export class ProjectionTransactionClosedError extends Error {
  readonly code = "projection_transaction_closed" as const;

  constructor() {
    super("Projection transaction capability is no longer active");
    this.name = "ProjectionTransactionClosedError";
  }
}

interface ScopedArtifactBlobTransaction {
  readonly capability: ArtifactBlobTransaction;
  invalidate(): void;
}

/** Internal callback scope; the capability is invalid as soon as the callback returns or throws. */
export function withArtifactBlobTransaction<T>(
  db: Database,
  callback: (capability: ArtifactBlobTransaction) => T,
): T {
  const scoped = createScopedArtifactBlobTransaction(db);
  try {
    return callback(scoped.capability);
  } finally {
    scoped.invalidate();
  }
}

function createScopedArtifactBlobTransaction(db: Database): ScopedArtifactBlobTransaction {
  let active = true;
  const assertActive = (): void => {
    if (!active) throw new ProjectionTransactionClosedError();
  };
  const capability = Object.freeze({
    insert(input: InsertArtifactBlobInput) {
      assertActive();
      return insertArtifactBlob(db, input);
    },
    read(hash: ArtifactBlobHash) {
      assertActive();
      return readArtifactBlob(db, hash);
    },
  }) as ArtifactBlobTransaction;
  return {
    capability,
    invalidate() {
      active = false;
    },
  };
}

export class ArtifactBlobIntegrityError extends Error {
  readonly code = "artifact_blob_integrity" as const;
  readonly reason: "hash_mismatch" | "length_mismatch" | "content_mismatch";
  readonly expectedHash?: string;
  readonly actualHash?: string;
  readonly expectedLength?: number;
  readonly actualLength?: number;

  constructor(
    detail:
      | {
          readonly reason: "hash_mismatch";
          readonly expectedHash: string;
          readonly actualHash: string;
        }
      | {
          readonly reason: "length_mismatch";
          readonly expectedHash: string;
          readonly actualHash: string;
          readonly expectedLength: number;
          readonly actualLength: number;
        }
      | {
          readonly reason: "content_mismatch";
          readonly expectedHash: string;
        },
  ) {
    const message =
      detail.reason === "hash_mismatch"
        ? `Artifact blob hash mismatch: expected ${detail.expectedHash}, received ${detail.actualHash}`
        : detail.reason === "length_mismatch"
          ? `Artifact blob length mismatch: expected ${detail.expectedLength}, received ${detail.actualLength}`
          : `Artifact blob content collision for ${detail.expectedHash}`;
    super(message);
    this.name = "ArtifactBlobIntegrityError";
    this.reason = detail.reason;
    this.expectedHash = detail.expectedHash;
    if (detail.reason === "hash_mismatch") {
      this.actualHash = detail.actualHash;
    } else if (detail.reason === "length_mismatch") {
      this.actualHash = detail.actualHash;
      this.expectedLength = detail.expectedLength;
      this.actualLength = detail.actualLength;
    }
  }
}

export class ArtifactBlobStore {
  constructor(private readonly db: Database) {}

  read(hash: ArtifactBlobHash): ArtifactBlob | undefined {
    return readArtifactBlob(this.db, hash);
  }
}

export function artifactBlobIdentity(input: InsertArtifactBlobInput): ArtifactBlobIdentity {
  const hash = digest(input.bytes);
  if (input.expectedHash !== undefined && input.expectedHash !== hash) {
    throw new ArtifactBlobIntegrityError({
      reason: "hash_mismatch",
      expectedHash: input.expectedHash,
      actualHash: hash,
    });
  }
  return { hash, byteLength: input.bytes.byteLength };
}

/** Writer-internal insertion primitive; callers must already own the append transaction. */
export function insertArtifactBlob(db: Database, input: InsertArtifactBlobInput): ArtifactBlobHash {
  const { hash } = artifactBlobIdentity(input);

  db.query(
    `INSERT INTO artifact_blob (content_hash, byte_length, bytes, created_at_db_ms)
     VALUES (?, ?, ?, CAST(unixepoch('subsec') * 1000 AS INTEGER))
     ON CONFLICT(content_hash) DO NOTHING`,
  ).run(hash, input.bytes.byteLength, input.bytes);

  const stored = db
    .query("SELECT bytes, byte_length FROM artifact_blob WHERE content_hash = ?")
    .get(hash) as BlobRow | null;
  if (stored === null) throw new Error(`Artifact blob insert did not persist ${hash}`);
  if (!bytesEqual(asBytes(stored.bytes), input.bytes)) {
    throw new ArtifactBlobIntegrityError({ reason: "content_mismatch", expectedHash: hash });
  }
  verifyStoredBlob(hash, stored);
  return hash;
}

export function readArtifactBlob(db: Database, hash: ArtifactBlobHash): ArtifactBlob | undefined {
  const row = db
    .query(
      `SELECT bytes, byte_length
       FROM artifact_blob
       WHERE content_hash = ?`,
    )
    .get(hash) as BlobRow | null;
  if (row === null) return undefined;

  return verifyStoredBlob(hash, row);
}

function digest(bytes: Uint8Array): ArtifactBlobHash {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function verifyStoredBlob(expectedHash: ArtifactBlobHash, row: BlobRow): ArtifactBlob {
  const bytes = asBytes(row.bytes);
  const actualHash = digest(bytes);
  if (actualHash !== expectedHash) {
    throw new ArtifactBlobIntegrityError({
      reason: "hash_mismatch",
      expectedHash,
      actualHash,
    });
  }
  if (row.byte_length !== bytes.byteLength) {
    throw new ArtifactBlobIntegrityError({
      reason: "length_mismatch",
      expectedHash,
      actualHash,
      expectedLength: row.byte_length,
      actualLength: bytes.byteLength,
    });
  }
  return { hash: expectedHash, bytes, size: bytes.byteLength };
}

function asBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

interface BlobRow {
  readonly bytes: Uint8Array | ArrayBuffer;
  readonly byte_length: number;
}
