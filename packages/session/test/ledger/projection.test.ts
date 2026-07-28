import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { Execution, Ledger } from "@openomni/protocol";
import * as LedgerBarrel from "../../src/ledger/index.js";
import { type ArtifactBlobHash, ProjectionTransactionClosedError } from "../../src/ledger/blob.js";
import {
  createLedgerProjection,
  createProductionLedgerProjections,
  ProjectionCheckpointConflictError,
  type ProjectionDefinition,
  ProjectionIdentityMismatchError,
  type ProjectionTransaction,
  rebuildProductionLedgerProjections,
} from "../../src/ledger/projection.js";
import { createLedgerQuery } from "../../src/ledger/query.js";
import { createLedgerWriter, LedgerAppendOptionsMismatchError } from "../../src/ledger/writer.js";
import { initializeSqliteDatabase } from "../../src/storage/sqlite-schema-lifecycle.js";
import {
  appendBatch,
  createLedgerFixture as createLegacyLedgerFixture,
  genesis,
} from "./fixture.js";

const ROUTE_SNAPSHOT_BYTES = new TextEncoder().encode(
  JSON.stringify({ version: "route-projection-state-v1", state: { routeId: "route-a" } }),
);
const ROUTE_SNAPSHOT_REF = {
  version: "content-blob-ref-v1" as const,
  digest: createHash("sha256").update(ROUTE_SNAPSHOT_BYTES).digest("hex"),
  byteLength: ROUTE_SNAPSHOT_BYTES.byteLength,
  mediaType: "application/json",
};

function required<T>(value: T | undefined, context: string): T {
  if (value === undefined) throw new Error(`Expected ${context}`);
  return value;
}
function createLedgerFixture(options: Parameters<typeof createLegacyLedgerFixture>[0] = {}) {
  const fixture = createLegacyLedgerFixture({
    ...options,
    includeNativeProjectionCapability: true,
  });
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
  fixture.db
    .query(
      "INSERT INTO artifact_blob (content_hash, byte_length, bytes, created_at_db_ms) VALUES (?, 0, ?, 0)",
    )
    .run(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      new Uint8Array(),
    );
  fixture.db
    .query(
      "INSERT INTO artifact_blob (content_hash, byte_length, bytes, created_at_db_ms) VALUES (?, ?, ?, 0)",
    )
    .run(
      `sha256:${ROUTE_SNAPSHOT_REF.digest}`,
      ROUTE_SNAPSHOT_REF.byteLength,
      ROUTE_SNAPSHOT_BYTES,
    );
  return fixture;
}

function event(eventId: string, ownerRef = genesis().owner): Ledger.EventV1 {
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
      occurredAtDbMs: 0,
      sessionId: eventId,
      parentSessionId: null,
      model: { provider: "test", id: "test" },
      sessionSnapshotRef: {
        version: "content-blob-ref-v1",
        digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        byteLength: 0,
        mediaType: "application/json",
      },
    },
    provenance: {
      version: "native-event-provenance-v1",
      principalId: "principal-a",
      requestId: `event-request-${eventId}`,
    },
  });
}

function routeEvent(eventId: string, ownerRef = genesis().owner): Ledger.EventV1 {
  const routeRef = ROUTE_SNAPSHOT_REF;
  return Ledger.EventV1.parse({
    version: "ledger-event-v1",
    eventId,
    eventType: "kernel.route.decided.v1",
    eventVersion: 1,
    owner: ownerRef,
    payload: {
      version: "native-event-payload-v1",
      eventType: "kernel.route.decided.v1",
      subjectId: eventId,
      occurredAtDbMs: 0,
      sessionId: "session-a",
      surfaceId: "surface-a",
      messageId: "message-a",
      routeId: eventId,
      routeDecision: "accept",
      authoritySnapshotRef: routeRef,
      routeSnapshotRef: routeRef,
    },
    provenance: {
      version: "native-event-provenance-v1",
      principalId: "principal-a",
      requestId: `event-request-${eventId}`,
    },
  });
}
describe("dormant ledger projection contract", () => {
  test("keeps internal and obsolete projection exports out of the public barrel", () => {
    expect("projectionDefinition" in LedgerBarrel).toBe(false);
    expect("ProjectionIdentityConflictError" in LedgerBarrel).toBe(false);
  });

  test("returns the original receipt for an exact option retry without rerunning registered projections", () => {
    let callbacks = 0;
    const fixture = createLedgerFixture({
      projections: [
        {
          name: "test.retry",
          identity: "test.retry.v1",
          applyCompleteBatch: () => {
            callbacks += 1;
            return undefined;
          },
        },
      ],
    });
    try {
      const projection = required(fixture.projections[0], "retry projection");
      const bytes = new TextEncoder().encode("retry blob");
      const request = appendBatch({ requestId: "retry-options", events: [event("retry-options")] });

      const first = fixture.writer.append(request, { artifactBlobs: [{ bytes }] });
      const retry = fixture.writer.append(request, {
        artifactBlobs: [{ bytes: bytes.slice() }],
      });

      expect(retry).toEqual(first);
      expect(callbacks).toBe(1);
      expect(projection.checkpoint()).toBe(first.lastLedgerSeq);
      expect(fixture.query.eventsByLedgerSequence({ throughLedgerSeq: 10 })).toHaveLength(1);
      const manifestRow = fixture.db
        .query("SELECT option_manifest_json FROM ledger_request WHERE request_id = ?")
        .get(request.requestId) as { readonly option_manifest_json: string };
      expect(JSON.parse(manifestRow.option_manifest_json)).toEqual({
        artifactBlobs: [
          {
            hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
            byteLength: bytes.byteLength,
          },
        ],
        projections: [
          { name: projection.name, identity: projection.identity },
          { name: "native.route", identity: "native-projection-v1" },
        ],
      });
    } finally {
      fixture.close();
    }
  });

  test("rejects a retry with different blob options before rerunning registered projections", () => {
    const callbacks: string[] = [];
    const fixture = createLedgerFixture({
      projections: [
        {
          name: "test.retry-blob",
          identity: "v1",
          applyCompleteBatch: () => {
            callbacks.push("first");
            return undefined;
          },
        },
      ],
    });
    try {
      const projection = required(fixture.projections[0], "retry blob projection");
      const firstBytes = new TextEncoder().encode("first blob");
      const changedBytes = new TextEncoder().encode("changed blob");
      const request = appendBatch({
        requestId: "retry-different-blob",
        events: [event("retry-different-blob")],
      });
      const receipt = fixture.writer.append(request, {
        artifactBlobs: [{ bytes: firstBytes }],
      });

      let rejection: unknown;
      try {
        fixture.writer.append(request, { artifactBlobs: [{ bytes: changedBytes }] });
      } catch (error) {
        rejection = error;
      }

      expect(rejection).toBeInstanceOf(LedgerAppendOptionsMismatchError);
      expect(rejection).toMatchObject({
        code: "ledger_append_options_mismatch",
        requestId: request.requestId,
        reason: "manifest_mismatch",
      });
      const mismatch = rejection as LedgerAppendOptionsMismatchError;
      expect(mismatch.expectedManifestHash).toHaveLength(64);
      expect(mismatch.actualManifestHash).toHaveLength(64);
      expect(mismatch.actualManifestHash).not.toBe(mismatch.expectedManifestHash);
      expect(callbacks).toEqual(["first"]);
      expect(projection.checkpoint()).toBe(receipt.lastLedgerSeq);
      expect(fixture.query.eventsByLedgerSequence({ throughLedgerSeq: 10 })).toHaveLength(1);
      const changedHash: ArtifactBlobHash = `sha256:${createHash("sha256").update(changedBytes).digest("hex")}`;
      expect(fixture.blobs.read(changedHash)).toBeUndefined();
    } finally {
      fixture.close();
    }
  });

  test("rejects ledger event and head tampering before replacing authoritative projection caches", () => {
    const cases = [
      {
        name: "payload",
        tamper(db: Database) {
          const row = db.query("SELECT canonical_payload FROM ledger_event").get() as {
            canonical_payload: string;
          };
          const payload = JSON.parse(row.canonical_payload) as Record<string, unknown>;
          db.query("UPDATE ledger_event SET canonical_payload = ?").run(
            JSON.stringify({ ...payload, occurredAtDbMs: 1 }),
          );
        },
        expected: "content hash mismatch",
      },
      {
        name: "content hash",
        tamper(db: Database) {
          db.query("UPDATE ledger_event SET content_hash = ?").run("b".repeat(64));
        },
        expected: "content hash mismatch",
      },
      {
        name: "previous hash",
        tamper(db: Database) {
          db.query("UPDATE ledger_event SET previous_hash = ?").run("b".repeat(64));
        },
        expected: "GENESIS_V1 must precede only owner sequence 1",
      },
      {
        name: "owner sequence",
        tamper(db: Database) {
          db.query("UPDATE ledger_event SET owner_seq = 2").run();
        },
        expected: "GENESIS_V1 must precede only owner sequence 1",
      },
      {
        name: "persisted head",
        tamper(db: Database) {
          db.query("UPDATE ledger_head SET event_hash = ?").run("b".repeat(64));
        },
        expected: "Persisted ledger head mismatch",
      },
    ] as const;

    for (const scenario of cases) {
      const fixture = createLedgerFixture({ includeNativeProjectionCapability: true });
      try {
        const receipt = fixture.writer.append(
          appendBatch({ requestId: `integrity-${scenario.name}`, events: [routeEvent("route-a")] }),
        );
        fixture.db
          .query(
            `INSERT INTO session_projection
               (session_id, owner_key, state_json, source_event_id, source_owner_seq,
                source_ledger_seq, source_owner_hash, updated_at_db_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "cached-session",
            receipt.owner.ownerKey,
            JSON.stringify({ cached: true }),
            receipt.eventIds[0],
            receipt.head.ownerSeq,
            receipt.lastLedgerSeq,
            receipt.head.eventHash,
            0,
          );
        const cached = fixture.db
          .query("SELECT * FROM session_projection WHERE session_id = ?")
          .get("cached-session");

        scenario.tamper(fixture.db);
        const projections = createProductionLedgerProjections(fixture.db);
        expect(() => rebuildProductionLedgerProjections(fixture.db, projections)).toThrow(
          scenario.expected,
        );
        expect(
          fixture.db
            .query("SELECT * FROM session_projection WHERE session_id = ?")
            .get("cached-session"),
        ).toEqual(cached);
        expect(required(fixture.projections[0], "native projection").checkpoint()).toBe(
          receipt.lastLedgerSeq,
        );
      } finally {
        fixture.close();
      }
    }
  });

  test("rejects a projection from another database when binding the writer", () => {
    const fixtureA = createLedgerFixture();
    const fixtureB = createLedgerFixture();
    try {
      let callbacks = 0;
      const foreignProjection = createLedgerProjection(fixtureA.db, {
        name: "test.foreign-database",
        identity: "v1",
        applyCompleteBatch: () => {
          callbacks += 1;
          return undefined;
        },
      });

      expect(() => createLedgerWriter(fixtureB.db, [foreignProjection])).toThrow(
        "Projection belongs to a different database",
      );
      expect(callbacks).toBe(0);
      expect(foreignProjection.checkpoint()).toBe(0);
      expect(fixtureB.query.eventsByLedgerSequence({ throughLedgerSeq: 10 })).toEqual([]);
    } finally {
      fixtureA.close();
      fixtureB.close();
    }
  });

  test("applies registered projections when append options omit them and across legal sequence gaps", () => {
    const applied: Array<Array<[number, number, number, string]>> = [];
    const fixture = createLedgerFixture({
      projections: [
        {
          name: "test.global-gaps",
          identity: "v1",
          applyCompleteBatch: (batch) => {
            applied.push(
              batch.map((item): [number, number, number, string] => [
                item.ledgerSeq,
                item.batch.index,
                item.batch.size,
                item.event.eventId,
              ]),
            );
            return undefined;
          },
        },
      ],
    });
    try {
      const projection = required(fixture.projections[0], "global gaps projection");
      const first = fixture.writer.append(
        appendBatch({ requestId: "first", events: [event("first-a"), event("first-b")] }),
      );
      fixture.db.query("UPDATE sqlite_sequence SET seq = ? WHERE name = ?").run(5, "ledger_event");
      const second = fixture.writer.append(
        appendBatch({
          requestId: "second",
          expectedHead: first.head,
          events: [event("second-a"), event("second-b")],
        }),
        { artifactBlobs: [] },
      );

      expect([
        first.firstLedgerSeq,
        first.lastLedgerSeq,
        second.firstLedgerSeq,
        second.lastLedgerSeq,
      ]).toEqual([1, 2, 6, 7]);
      expect(applied).toEqual([
        [
          [1, 0, 2, "first-a"],
          [2, 1, 2, "first-b"],
        ],
        [
          [6, 0, 2, "second-a"],
          [7, 1, 2, "second-b"],
        ],
      ]);
      expect(projection.checkpoint()).toBe(7);
    } finally {
      fixture.close();
    }
  });

  test("rejects resume after an unregistered writer omitted a projection until explicit rebuild", () => {
    let projectionDb: Database;
    const fixture = createLedgerFixture({
      projections: [
        {
          name: "test.omitted-writer",
          identity: "v1",
          applyCompleteBatch: (batch) => {
            for (const envelope of batch) {
              projectionDb
                .query("INSERT INTO test_projection_value (event_id) VALUES (?)")
                .run(envelope.event.eventId);
            }
            return undefined;
          },
        },
      ],
    });
    projectionDb = fixture.db;
    try {
      fixture.db.exec("CREATE TABLE test_projection_value (event_id TEXT PRIMARY KEY) STRICT");
      const projection = required(fixture.projections[0], "omitted writer projection");
      const first = fixture.writer.append(
        appendBatch({ requestId: "projected", events: [event("projected")] }),
      );
      const omittedWriter = createLedgerWriter(fixture.db, [
        required(fixture.projections.at(-1), "native projection"),
      ]);
      const omitted = omittedWriter.append(
        appendBatch({
          requestId: "omitted",
          expectedHead: first.head,
          events: [event("omitted")],
        }),
      );

      expect(() =>
        fixture.writer.append(
          appendBatch({
            requestId: "premature-resume",
            expectedHead: omitted.head,
            events: [event("premature-resume")],
          }),
        ),
      ).toThrow(ProjectionCheckpointConflictError);
      expect(fixture.query.appendResult("premature-resume")).toBeUndefined();
      expect(fixture.query.head(genesis().owner)).toEqual(omitted.head);
      expect(projection.checkpoint()).toBe(first.lastLedgerSeq);
      expect(
        fixture.db.query("SELECT event_id FROM test_projection_value ORDER BY event_id").all(),
      ).toEqual([{ event_id: "projected" }]);

      fixture.db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        fixture.db.query("INSERT INTO test_projection_value (event_id) VALUES (?)").run("omitted");
        fixture.db
          .query(
            `UPDATE projection_checkpoint
             SET ledger_seq = ?, updated_at_db_ms = 0
             WHERE projection_name = ? AND projection_identity = ?`,
          )
          .run(omitted.lastLedgerSeq, projection.name, projection.identity);
        fixture.db.exec("COMMIT");
      } catch (error) {
        fixture.db.exec("ROLLBACK");
        throw error;
      }

      const resumed = fixture.writer.append(
        appendBatch({
          requestId: "resumed",
          expectedHead: omitted.head,
          events: [event("resumed")],
        }),
      );
      expect(projection.checkpoint()).toBe(resumed.lastLedgerSeq);
      expect(
        fixture.db.query("SELECT event_id FROM test_projection_value ORDER BY event_id").all(),
      ).toEqual([{ event_id: "omitted" }, { event_id: "projected" }, { event_id: "resumed" }]);
    } finally {
      fixture.close();
    }
  });

  test("rejects projection identity rotation until its state and checkpoint are explicitly rebuilt", () => {
    const fixture = createLedgerFixture({
      projections: [
        {
          name: "test.rotation",
          identity: "v1",
          applyCompleteBatch: () => undefined,
        },
      ],
    });
    try {
      const first = fixture.writer.append(
        appendBatch({ requestId: "rotation-v1", events: [event("rotation-v1")] }),
      );
      const replacement = createLedgerProjection(fixture.db, {
        name: "test.rotation",
        identity: "v2",
        applyCompleteBatch: () => undefined,
      });

      const replacementWriter = createLedgerWriter(fixture.db, [
        replacement,
        required(fixture.projections.at(-1), "native projection"),
      ]);
      expect(() =>
        replacementWriter.append(
          appendBatch({
            requestId: "rotation-rejected",
            expectedHead: first.head,
            events: [event("rotation-rejected")],
          }),
        ),
      ).toThrow(ProjectionIdentityMismatchError);
      expect(fixture.query.appendResult("rotation-rejected")).toBeUndefined();
      expect(required(fixture.projections[0], "rotated projection").checkpoint()).toBe(
        first.lastLedgerSeq,
      );

      fixture.db
        .query(
          `UPDATE projection_checkpoint
           SET projection_identity = ?, ledger_seq = ?, updated_at_db_ms = 0
           WHERE projection_name = ?`,
        )
        .run(replacement.identity, first.lastLedgerSeq, replacement.name);
      const rebuiltWriter = createLedgerWriter(fixture.db, [
        replacement,
        required(fixture.projections.at(-1), "native projection"),
      ]);
      const second = rebuiltWriter.append(
        appendBatch({
          requestId: "rotation-v2",
          expectedHead: first.head,
          events: [event("rotation-v2")],
        }),
      );
      expect(replacement.checkpoint()).toBe(second.lastLedgerSeq);
    } finally {
      fixture.close();
    }
  });

  test("invalidates a retained projection transaction after a successful append", () => {
    let retained: ProjectionTransaction | undefined;
    const fixture = createLedgerFixture({
      projections: [
        {
          name: "test.closed-success",
          identity: "v1",
          applyCompleteBatch: (_batch, transaction) => {
            retained = transaction;
            return undefined;
          },
        },
      ],
    });
    try {
      fixture.writer.append(
        appendBatch({ requestId: "closed-success", events: [event("closed-success")] }),
      );
      const bytes = new TextEncoder().encode("too late");
      const contentHash =
        `sha256:${createHash("sha256").update(bytes).digest("hex")}` as ArtifactBlobHash;
      expect(() =>
        required(retained, "retained projection transaction").artifactBlobs.read(contentHash),
      ).toThrow(ProjectionTransactionClosedError);
      expect(() =>
        required(retained, "retained projection transaction").artifactBlobs.insert({ bytes }),
      ).toThrow(ProjectionTransactionClosedError);
      expect(fixture.blobs.read(contentHash)).toBeUndefined();
    } finally {
      fixture.close();
    }
  });

  test("rejects non-undefined and promise-like projection returns before committing append state", () => {
    for (const returnKind of ["value", "async", "thenable"] as const) {
      let retained: ProjectionTransaction | undefined;
      let projectionDb: Database;
      const bytes = new TextEncoder().encode(`${returnKind} projection blob`);
      const contentHash =
        `sha256:${createHash("sha256").update(bytes).digest("hex")}` as ArtifactBlobHash;
      const mutate = (
        batch: readonly Ledger.EnvelopeV1[],
        transaction: ProjectionTransaction,
      ): undefined => {
        retained = transaction;
        projectionDb
          .query("INSERT INTO test_projection_value (event_id) VALUES (?)")
          .run(required(batch[0], "projection batch envelope").event.eventId);
        transaction.artifactBlobs.insert({ bytes, expectedHash: contentHash });
        return undefined;
      };
      const callback =
        returnKind === "async"
          ? async (batch: readonly Ledger.EnvelopeV1[], transaction: ProjectionTransaction) => {
              mutate(batch, transaction);
              return undefined;
            }
          : returnKind === "thenable"
            ? (batch: readonly Ledger.EnvelopeV1[], transaction: ProjectionTransaction) => {
                mutate(batch, transaction);
                return new Proxy(
                  {},
                  {
                    get: (_target, property) => (property === "then" ? () => undefined : undefined),
                  },
                );
              }
            : (batch: readonly Ledger.EnvelopeV1[], transaction: ProjectionTransaction) => {
                mutate(batch, transaction);
                return "non-undefined";
              };
      const fixture = createLedgerFixture({
        projections: [
          {
            name: `test.${returnKind}-return`,
            identity: "v1",
            applyCompleteBatch: callback as unknown as ProjectionDefinition["applyCompleteBatch"],
          },
        ],
      });
      projectionDb = fixture.db;
      try {
        fixture.db.exec("CREATE TABLE test_projection_value (event_id TEXT PRIMARY KEY) STRICT");
        const requestId = `${returnKind}-return`;

        expect(() =>
          fixture.writer.append(appendBatch({ requestId, events: [event(requestId)] })),
        ).toThrow(
          `Projection test.${returnKind}-return applyCompleteBatch must return undefined synchronously`,
        );
        expect(fixture.query.eventsByLedgerSequence({ throughLedgerSeq: 10 })).toEqual([]);
        expect(fixture.query.appendResult(requestId)).toBeUndefined();
        expect(fixture.query.head(genesis().owner)).toEqual(genesis());
        expect(required(fixture.projections[0], "invalid return projection").checkpoint()).toBe(0);
        expect(fixture.db.query("SELECT event_id FROM test_projection_value").all()).toEqual([]);
        expect(fixture.blobs.read(contentHash)).toBeUndefined();
        expect(() =>
          required(retained, "retained projection transaction").artifactBlobs.read(contentHash),
        ).toThrow(ProjectionTransactionClosedError);
      } finally {
        fixture.close();
      }
    }
  });

  test("rolls back event, head, request, projection mutation, checkpoint, and blob together", () => {
    let retained: ProjectionTransaction | undefined;
    const bytes = new TextEncoder().encode("projection-owned blob");
    const contentHash =
      `sha256:${createHash("sha256").update(bytes).digest("hex")}` as ArtifactBlobHash;
    let projectionDb: Database;
    const fixture = createLedgerFixture({
      projections: [
        {
          name: "test.rollback",
          identity: "v1",
          applyCompleteBatch: (batch, transaction) => {
            retained = transaction;
            projectionDb
              .query("INSERT INTO test_projection_value (event_id) VALUES (?)")
              .run(required(batch[0], "rollback projection batch envelope").event.eventId);
            expect(transaction.artifactBlobs.insert({ bytes, expectedHash: contentHash })).toBe(
              contentHash,
            );
            throw new Error("projection failed");
          },
        },
      ],
    });
    projectionDb = fixture.db;
    try {
      fixture.db.exec("CREATE TABLE test_projection_value (event_id TEXT PRIMARY KEY) STRICT");
      expect(() =>
        fixture.writer.append(appendBatch({ requestId: "failing", events: [event("event-a")] })),
      ).toThrow("projection failed");
      expect(fixture.query.eventsByLedgerSequence({ throughLedgerSeq: 10 })).toEqual([]);
      expect(fixture.query.appendResult("failing")).toBeUndefined();
      expect(fixture.query.head(genesis().owner)).toEqual(genesis());
      expect(required(fixture.projections[0], "rollback projection").checkpoint()).toBe(0);
      expect(fixture.db.query("SELECT event_id FROM test_projection_value").all()).toEqual([]);
      expect(fixture.blobs.read(contentHash)).toBeUndefined();
      expect(() =>
        required(retained, "retained projection transaction").artifactBlobs.read(contentHash),
      ).toThrow(ProjectionTransactionClosedError);
      expect(() =>
        required(retained, "retained projection transaction").artifactBlobs.insert({
          bytes,
          expectedHash: contentHash,
        }),
      ).toThrow(ProjectionTransactionClosedError);
    } finally {
      fixture.close();
    }
  });

  test("rejects an invalid later registered projection before running any callback", () => {
    const callbacks: string[] = [];
    const fixture = createLedgerFixture({
      projections: [
        {
          name: "test.valid",
          identity: "v1",
          applyCompleteBatch: () => {
            callbacks.push("valid");
            return undefined;
          },
        },
        {
          name: "test.conflict",
          identity: "v1",
          applyCompleteBatch: () => {
            callbacks.push("invalid");
            return undefined;
          },
        },
      ],
    });
    try {
      const validProjection = required(fixture.projections[0], "valid projection");
      const invalidProjection = required(fixture.projections[1], "invalid projection");
      fixture.db
        .query(
          `INSERT INTO projection_checkpoint
             (projection_name, projection_identity, ledger_seq, updated_at_db_ms)
           VALUES (?, ?, ?, ?)`,
        )
        .run(invalidProjection.name, invalidProjection.identity, 1, 0);

      expect(() =>
        fixture.writer.append(appendBatch({ requestId: "conflict", events: [event("conflict")] })),
      ).toThrow(ProjectionCheckpointConflictError);
      expect(callbacks).toEqual([]);
      expect(fixture.query.eventsByLedgerSequence({ throughLedgerSeq: 10 })).toEqual([]);
      expect(fixture.query.appendResult("conflict")).toBeUndefined();
      expect(fixture.query.head(genesis().owner)).toEqual(genesis());
      expect(validProjection.checkpoint()).toBe(0);
      expect(invalidProjection.checkpoint()).toBe(1);
    } finally {
      fixture.close();
    }
  });

  test("binds an immutable registered definition instead of caller mutation authority", () => {
    const callbacks: string[] = [];
    const definition: ProjectionDefinition = {
      name: "test.registered-only",
      identity: "v1",
      applyCompleteBatch: () => {
        callbacks.push("registered");
        return undefined;
      },
    };
    const fixture = createLedgerFixture({ projections: [definition] });
    try {
      (definition as { applyCompleteBatch: () => undefined }).applyCompleteBatch = () => {
        throw new Error("unregistered replacement ran");
      };

      fixture.writer.append(
        appendBatch({ requestId: "registered-only", events: [event("registered-only")] }),
      );
      expect(callbacks).toEqual(["registered"]);
      expect(required(fixture.projections[0], "registered projection").checkpoint()).toBe(1);
    } finally {
      fixture.close();
    }
  });

  test("fresh rebuild replay produces projection, blob, and checkpoint equality", () => {
    const replay = () => {
      let projectionDb: Database;
      const fixture = createLedgerFixture({
        projections: [
          {
            name: "test.rebuild-equality",
            identity: "v1",
            applyCompleteBatch: (batch, transaction) => {
              for (const envelope of batch) {
                projectionDb
                  .query("INSERT INTO test_projection_value (event_id) VALUES (?)")
                  .run(envelope.event.eventId);
                transaction.artifactBlobs.insert({
                  bytes: new TextEncoder().encode(`projection:${envelope.event.eventId}`),
                });
              }
              return undefined;
            },
          },
        ],
      });
      projectionDb = fixture.db;
      try {
        fixture.db.exec("CREATE TABLE test_projection_value (event_id TEXT PRIMARY KEY) STRICT");
        const first = fixture.writer.append(
          appendBatch({ requestId: "rebuild-a", events: [event("rebuild-a")] }),
        );
        fixture.writer.append(
          appendBatch({
            requestId: "rebuild-b",
            expectedHead: first.head,
            events: [event("rebuild-b")],
          }),
        );
        return {
          projection: fixture.db
            .query("SELECT event_id FROM test_projection_value ORDER BY event_id")
            .all(),
          blobs: fixture.db
            .query(
              "SELECT content_hash, byte_length, hex(bytes) AS bytes FROM artifact_blob ORDER BY content_hash",
            )
            .all(),
          checkpoint: required(fixture.projections[0], "rebuild projection").checkpoint(),
        };
      } finally {
        fixture.close();
      }
    };

    expect(replay()).toEqual(replay());
  });

  test("projects create and revise, deletes retired configuration, and rebuilds identically", () => {
    const db = new Database(":memory:", { strict: true });
    initializeSqliteDatabase(db);
    const writer = createLedgerWriter(db, createProductionLedgerProjections(db));
    const owner = genesis().owner;
    const identity = { id: "actor-1", kind: "human", trustTier: "owner", relationship: "owner" };
    const prepare = (operationId: "AI-01" | "AI-02" | "AI-03", recordVersion: number) => {
      const command = required(
        Execution.ConfigurationOperationCatalogV1.find(({ id }) => id === operationId),
        `configuration operation ${operationId}`,
      ).command;
      const artifactPayload = {
        version: "configuration-operation-payload-v1",
        operationId,
        command,
        owner,
        subjectId: "actor-1",
        recordVersion,
        occurredAtDbMs: recordVersion,
        ...(operationId === "AI-03"
          ? {}
          : {
              identity: { ...identity, ...(recordVersion === 2 ? { displayName: "Owner" } : {}) },
            }),
      };
      const artifact = {
        version: "configuration-artifact-v1",
        operationId,
        command,
        owner,
        subjectId: "actor-1",
        recordVersion,
        occurredAtDbMs: recordVersion,
        payload: artifactPayload,
      };
      const bytes = new TextEncoder().encode(JSON.stringify(artifact));
      const configurationSnapshotRef = {
        version: "content-blob-ref-v1" as const,
        digest: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.byteLength,
        mediaType: "application/json",
      };
      const eventType =
        operationId === "AI-01"
          ? "actor.identity_registered.v1"
          : operationId === "AI-02"
            ? "actor.identity_revised.v1"
            : "actor.identity_retired.v1";
      return {
        bytes,
        event: Ledger.EventV1.parse({
          version: "ledger-event-v1",
          eventId: `configuration-${recordVersion}`,
          eventType,
          eventVersion: 1,
          owner,
          payload: {
            version: "native-event-payload-v1",
            eventType,
            subjectId: "actor-1",
            occurredAtDbMs: recordVersion,
            configurationSnapshotRef,
          },
          provenance: {
            version: "native-event-provenance-v1",
            principalId: "principal-a",
            requestId: `configuration-${recordVersion}`,
          },
        }),
      };
    };
    try {
      const created = prepare("AI-01", 1);
      const first = writer.append(
        appendBatch({ requestId: "configuration-1", events: [created.event] }),
        { artifactBlobs: [{ bytes: created.bytes }] },
      );
      const revised = prepare("AI-02", 2);
      const second = writer.append(
        appendBatch({
          requestId: "configuration-2",
          expectedHead: first.head,
          events: [revised.event],
        }),
        { artifactBlobs: [{ bytes: revised.bytes }] },
      );
      expect(
        required(createLedgerQuery(db).actorIdentity("actor-1"), "actor identity").state,
      ).toMatchObject({
        operationId: "AI-02",
        recordVersion: 2,
      });

      const retired = prepare("AI-03", 3);
      writer.append(
        appendBatch({
          requestId: "configuration-3",
          expectedHead: second.head,
          events: [retired.event],
        }),
        { artifactBlobs: [{ bytes: retired.bytes }] },
      );
      expect(createLedgerQuery(db).actorIdentity("actor-1")).toBeUndefined();

      const configurationHash = `sha256:${createHash("sha256").update(retired.bytes).digest("hex")}`;
      const corrupted = retired.bytes.slice();
      corrupted[0] = required(corrupted[0], "first corrupted byte") ^ 1;
      db.query("UPDATE artifact_blob SET bytes = ? WHERE content_hash = ?").run(
        corrupted,
        configurationHash,
      );
      const rejectedRebuild = createProductionLedgerProjections(db);
      expect(() => rebuildProductionLedgerProjections(db, rejectedRebuild)).toThrow(
        "hash mismatch",
      );
      expect(rejectedRebuild.every((projection) => projection.checkpoint() === 3)).toBe(true);
      expect(createLedgerQuery(db).actorIdentity("actor-1")).toBeUndefined();
      db.query("UPDATE artifact_blob SET bytes = ? WHERE content_hash = ?").run(
        retired.bytes,
        configurationHash,
      );

      const rebuilt = createProductionLedgerProjections(db);
      rebuildProductionLedgerProjections(db, rebuilt);
      expect(createLedgerQuery(db).actorIdentity("actor-1")).toBeUndefined();
      expect(rebuilt.every((projection) => projection.checkpoint() === 3)).toBe(true);
    } finally {
      db.close();
    }
  });

  test("rejects malformed, cross-family, and identity-mismatched snapshots atomically", () => {
    const cases = [
      {
        name: "missing-blob",
        bytes: new TextEncoder().encode("{}"),
        expected: "is missing",
        noBlob: true,
      },
      {
        name: "length-mismatch",
        bytes: new TextEncoder().encode("{}"),
        expected: "unexpected byte length",
        refLength: 1,
      },
      {
        name: "digest-mismatch",
        bytes: new TextEncoder().encode("{}"),
        expected: "hash mismatch",
        corruptDigest: "f".repeat(64),
      },
      { name: "invalid-utf8", bytes: Uint8Array.of(0xff), expected: "not valid UTF-8" },
      { name: "invalid-json", bytes: new TextEncoder().encode("{"), expected: "not valid JSON" },
      { name: "array-json", bytes: new TextEncoder().encode("[]"), expected: "JSON object" },
      {
        name: "missing-session-id",
        bytes: new TextEncoder().encode(
          JSON.stringify({ version: "session-projection-state-v1", state: {} }),
        ),
        expected: "snapshot id does not match event facts",
      },
      {
        name: "cross-family",
        bytes: new TextEncoder().encode(
          JSON.stringify({
            version: "message-projection-state-v1",
            state: { id: "session-1", sessionId: "session-1" },
          }),
        ),
        expected: "invalid version",
      },
    ] as const;

    for (const item of cases) {
      const db = new Database(":memory:", { strict: true });
      initializeSqliteDatabase(db);
      const projections = createProductionLedgerProjections(db);
      const writer = createLedgerWriter(db, projections);
      try {
        const digest =
          "corruptDigest" in item
            ? item.corruptDigest
            : createHash("sha256").update(item.bytes).digest("hex");
        const ref = {
          version: "content-blob-ref-v1" as const,
          digest,
          byteLength: "refLength" in item ? item.refLength : item.bytes.byteLength,
          mediaType: "application/json",
        };
        if ("corruptDigest" in item) {
          db.query(
            `INSERT INTO artifact_blob
             (content_hash, byte_length, bytes, created_at_db_ms) VALUES (?, ?, ?, 0)`,
          ).run(`sha256:${digest}`, item.bytes.byteLength, item.bytes);
        }
        const owner = genesis().owner;
        const eventType = "session.opened.v1" as const;
        const payload = {
          version: "native-event-payload-v1" as const,
          eventType,
          subjectId: "session-1",
          occurredAtDbMs: 0,
          sessionId: "session-1",
          parentSessionId: null,
          model: { provider: "test", id: "test" },
          sessionSnapshotRef: ref,
        };
        const malformedEvent = Ledger.EventV1.parse({
          version: "ledger-event-v1",
          eventId: item.name,
          eventType,
          eventVersion: 1,
          owner,
          payload,
          provenance: {
            version: "native-event-provenance-v1",
            principalId: "principal-a",
            requestId: item.name,
          },
        });

        expect(() =>
          writer.append(appendBatch({ requestId: item.name, events: [malformedEvent] }), {
            artifactBlobs:
              "noBlob" in item || "corruptDigest" in item ? [] : [{ bytes: item.bytes }],
          }),
        ).toThrow(item.expected);
        expect(createLedgerQuery(db).eventsByLedgerSequence({ throughLedgerSeq: 1 })).toEqual([]);
        expect(db.query("SELECT * FROM session_projection").all()).toEqual([]);
        expect(db.query("SELECT * FROM actor_endpoint_projection").all()).toEqual([]);
      } finally {
        db.close();
      }
    }
  });
});
