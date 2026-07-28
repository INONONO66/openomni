import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "@openomni/protocol";
import {
  LedgerAppendOptionsMismatchError,
  LedgerSchemaError,
  LedgerWriteError,
  createLedgerWriter,
} from "../../src/ledger/writer.js";
import { openLedgerRuntime } from "../../src/ledger/runtime.js";
import {
  HASH_B,
  appendBatch,
  createLedgerFixture,
  event,
  genesis,
  owner,
  projectionSnapshot,
} from "./fixture.js";

describe("dormant ledger writer contract", () => {
  test("appends one-owner batches in owner order and one global sequence", () => {
    const fixture = createLedgerFixture({ includeNativeProjectionCapability: true });
    try {
      const ownerA = owner("owner-a");
      const first = fixture.writer.append(
        appendBatch({
          requestId: "request-a",
          owner: ownerA,
          events: [event("a-1", ownerA), event("a-2", ownerA)],
        }),
      );
      const ownerB = owner("owner-b");
      const second = fixture.writer.append(
        appendBatch({ requestId: "request-b", owner: ownerB, events: [event("b-1", ownerB)] }),
      );

      expect([first.firstLedgerSeq, first.lastLedgerSeq, second.firstLedgerSeq]).toEqual([1, 2, 3]);
      const events = fixture.query.eventsByLedgerSequence({ throughLedgerSeq: 3 });
      expect(events.map(({ ledgerSeq, ownerSeq }) => [ledgerSeq, ownerSeq])).toEqual([
        [1, 1],
        [2, 2],
        [3, 1],
      ]);
      expect(events[0].previousEventHash).toBe(Ledger.GENESIS_V1);
      expect(events[1].previousEventHash).toBe(events[0].eventHash);
      expect(fixture.query.head(ownerA)).toEqual(first.head);
      expect(fixture.query.head(ownerB)).toEqual(second.head);
    } finally {
      fixture.close();
    }
  });

  test("requires the option manifest schema at construction without mutating legacy DDL", () => {
    const db = new Database(":memory:", { strict: true });
    try {
      db.exec(`
        CREATE TABLE ledger_request (
          request_id TEXT PRIMARY KEY NOT NULL,
          request_hash TEXT NOT NULL,
          principal_id TEXT NOT NULL,
          receipt_json TEXT NOT NULL
        ) STRICT;

        CREATE TABLE projection_checkpoint (
          projection_name TEXT PRIMARY KEY NOT NULL,
          projection_identity TEXT NOT NULL,
          ledger_seq INTEGER NOT NULL,
          updated_at_db_ms INTEGER NOT NULL
        ) STRICT
      `);
      const before = db
        .query("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'ledger_request'")
        .get();

      let rejection: unknown;
      try {
        createLedgerWriter(db, []);
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(LedgerSchemaError);
      expect(rejection).toMatchObject({
        code: "ledger_schema_invalid",
        missingColumns: ["ledger_request.option_manifest_json NOT NULL"],
      });
      expect(
        db
          .query("PRAGMA table_info(ledger_request)")
          .all()
          .map((column) => (column as { readonly name: string }).name),
      ).not.toContain("option_manifest_json");
      expect(
        db
          .query("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'ledger_request'")
          .get(),
      ).toEqual(before);
    } finally {
      db.close();
    }
  });

  test("constructs a writer against the fresh ledger fixture schema", () => {
    const fixture = createLedgerFixture();
    try {
      expect(createLedgerWriter(fixture.db, [])).toBeDefined();
    } finally {
      fixture.close();
    }
  });

  test("does not own durability pragmas", () => {
    const fixture = createLedgerFixture();
    try {
      fixture.db.query("PRAGMA synchronous = OFF").get();
      createLedgerWriter(fixture.db, []);
      expect(fixture.db.query("PRAGMA synchronous").get()).toEqual({ synchronous: 0 });
    } finally {
      fixture.close();
    }
  });

  test("rejects a stale second writer and leaves its request absent", () => {
    const fixture = createLedgerFixture({ includeNativeProjectionCapability: true });
    try {
      const secondWriter = createLedgerWriter(fixture.db, fixture.projections);
      const staleHead = genesis();
      fixture.writer.append(
        appendBatch({
          requestId: "winner",
          expectedHead: staleHead,
          events: [event("winner-event")],
        }),
      );

      let rejection: unknown;
      try {
        secondWriter.append(
          appendBatch({
            requestId: "loser",
            expectedHead: staleHead,
            events: [event("loser-event")],
          }),
        );
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(LedgerWriteError);
      expect((rejection as LedgerWriteError).detail.code).toBe("head_conflict");
      expect(fixture.query.appendResult("loser")).toBeUndefined();
      expect(fixture.query.eventsByLedgerSequence({ throughLedgerSeq: 10 })).toHaveLength(1);
    } finally {
      fixture.close();
    }
  });

  test("deduplicates requests globally and rejects changed hash or principal", () => {
    const fixture = createLedgerFixture({ includeNativeProjectionCapability: true });
    try {
      const request = appendBatch({ requestId: "global-request", events: [event("event-1")] });
      const receipt = fixture.writer.append(request);
      expect(fixture.writer.append(request)).toEqual(receipt);

      for (const changed of [
        { ...request, requestHash: HASH_B },
        {
          ...request,
          principalId: "principal-b",
          batch: {
            ...request.batch,
            events: request.batch.events.map((item) => ({
              ...item,
              provenance: { ...item.provenance, principalId: "principal-b" },
            })),
          },
        },
      ]) {
        try {
          fixture.writer.append(Ledger.AppendBatch.parse(changed));
          throw new Error("expected idempotency mismatch");
        } catch (error) {
          expect(error).toBeInstanceOf(LedgerWriteError);
          expect((error as LedgerWriteError).detail.code).toBe("idempotency_mismatch");
        }
      }
      expect(fixture.query.eventsByLedgerSequence({ throughLedgerSeq: 10 })).toHaveLength(1);
    } finally {
      fixture.close();
    }
  });

  test("preserves exact append idempotency and mismatch rejection across close and reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openomni-append-reopen-"));
    const dbPath = join(directory, "ledger.sqlite");
    const snapshot = projectionSnapshot("session", { id: "durable-session", status: "open" });
    const request = appendBatch({
      requestId: "durable-idempotency",
      events: [
        Ledger.EventV1.parse({
          version: "ledger-event-v1",
          eventId: "durable-session-opened",
          eventType: "session.opened.v1",
          eventVersion: 1,
          owner: owner(),
          payload: {
            version: "native-event-payload-v1",
            eventType: "session.opened.v1",
            subjectId: "durable-session",
            occurredAtDbMs: 10,
            sessionId: "durable-session",
            parentSessionId: null,
            model: { provider: "test", id: "model" },
            sessionSnapshotRef: snapshot.ref,
          },
          provenance: {
            version: "native-event-provenance-v1",
            principalId: "principal-a",
            requestId: "durable-idempotency",
          },
        }),
      ],
    });
    const options = { artifactBlobs: [{ bytes: snapshot.bytes }] } as const;
    try {
      const runtime = openLedgerRuntime({ dbPath });
      const receipt = await runtime.append(request, options);
      const liveState = await runtime.query((query) => query.session("durable-session"));
      await runtime.close();
      const before = durableCounts(dbPath);

      const reopened = openLedgerRuntime({ dbPath });
      expect(
        await reopened.append(request, {
          artifactBlobs: [{ bytes: snapshot.bytes.slice() }],
        }),
      ).toEqual(receipt);

      for (const changed of [
        { request: { ...request, requestHash: HASH_B }, options },
        {
          request: {
            ...request,
            principalId: "principal-b",
            batch: {
              ...request.batch,
              events: request.batch.events.map((item) => ({
                ...item,
                provenance: { ...item.provenance, principalId: "principal-b" },
              })),
            },
          },
          options,
        },
      ]) {
        await expect(
          reopened.append(Ledger.AppendBatch.parse(changed.request), changed.options),
        ).rejects.toMatchObject({
          detail: { code: "idempotency_mismatch" },
        });
      }
      await expect(
        reopened.append(request, {
          artifactBlobs: [{ bytes: new TextEncoder().encode("changed manifest") }],
        }),
      ).rejects.toBeInstanceOf(LedgerAppendOptionsMismatchError);
      expect(await reopened.query((query) => query.session("durable-session"))).toEqual(liveState);
      expect(
        await reopened.query((query) =>
          query.eventsByLedgerSequence({ throughLedgerSeq: 10 }).map(({ event }) => event.eventId),
        ),
      ).toEqual(["durable-session-opened"]);
      await reopened.close();

      expect(durableCounts(dbPath)).toEqual(before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects cross-owner batches through the exported schema", () => {
    const ownerA = owner("owner-a");
    const ownerB = owner("owner-b");
    expect(() =>
      appendBatch({
        requestId: "cross-owner",
        owner: ownerA,
        events: [event("a", ownerA), event("b", ownerB)],
      }),
    ).toThrow();
  });

  test("rolls back every event, head, and request when a later event fails", () => {
    const fixture = createLedgerFixture({ includeNativeProjectionCapability: true });
    try {
      fixture.writer.append(appendBatch({ requestId: "seed", events: [event("duplicate-id")] }));
      const ownerB = owner("owner-b");
      expect(() =>
        fixture.writer.append(
          appendBatch({
            requestId: "rolled-back",
            owner: ownerB,
            events: [event("transient", ownerB), event("duplicate-id", ownerB)],
          }),
        ),
      ).toThrow();

      expect(fixture.query.head(ownerB)).toEqual(genesis(ownerB));
      expect(fixture.query.appendResult("rolled-back")).toBeUndefined();
      expect(
        fixture.query
          .eventsByLedgerSequence({ throughLedgerSeq: 10 })
          .map((row) => row.event.eventId),
      ).toEqual(["duplicate-id"]);
    } finally {
      fixture.close();
    }
  });

  test("returns only complete, contiguous batches within sequence bounds", () => {
    const fixture = createLedgerFixture({ includeNativeProjectionCapability: true });
    try {
      const first = fixture.writer.append(
        appendBatch({ requestId: "batch-one", events: [event("one-a"), event("one-b")] }),
      );
      fixture.writer.append(
        appendBatch({
          requestId: "batch-two",
          expectedHead: first.head,
          events: [event("two-a"), event("two-b")],
        }),
      );

      expect(
        fixture.query
          .eventsByLedgerSequence({ afterLedgerSeq: 1, throughLedgerSeq: 3 })
          .map((e) => e.ledgerSeq),
      ).toEqual([2, 3]);
      expect(
        fixture.query
          .eventsByOwnerSequence(owner(), { afterOwnerSeq: 1, throughOwnerSeq: 3 })
          .map((e) => e.ownerSeq),
      ).toEqual([2, 3]);
      expect(
        fixture.query
          .completeBatches({ throughLedgerSeq: 3 })
          .map((batch) => batch.map((e) => e.ledgerSeq)),
      ).toEqual([[1, 2]]);
      expect(
        fixture.query
          .completeBatches({ afterLedgerSeq: 2, throughLedgerSeq: 4 })
          .map((batch) => batch.map((e) => e.ledgerSeq)),
      ).toEqual([[3, 4]]);
      expect(fixture.query.completeBatches({ afterLedgerSeq: 1, throughLedgerSeq: 4 })).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test("keeps adjacent reused owner batch IDs separate by durable request ID", () => {
    const fixture = createLedgerFixture({ includeNativeProjectionCapability: true });
    try {
      const first = fixture.writer.append(
        appendBatch({
          requestId: "reuse-first",
          batchId: "first-id",
          events: [event("first")],
        }),
      );
      fixture.writer.append(
        appendBatch({
          requestId: "reuse-second",
          batchId: "second-id",
          expectedHead: first.head,
          events: [event("second")],
        }),
      );
      fixture.db.exec(`
        CREATE TABLE ledger_event_copy AS SELECT * FROM ledger_event;
        DROP TABLE ledger_event;
        ALTER TABLE ledger_event_copy RENAME TO ledger_event;
        UPDATE ledger_event SET batch_id = 'reused-id';
      `);

      expect(
        fixture.query
          .completeBatches({ throughLedgerSeq: 2 })
          .map((batch) => batch.map((envelope) => envelope.event.eventId)),
      ).toEqual([["first"], ["second"]]);
    } finally {
      fixture.close();
    }
  });

  test("rejects a batch whose durable request metadata changes between events", () => {
    const fixture = createLedgerFixture({ includeNativeProjectionCapability: true });
    try {
      fixture.writer.append(
        appendBatch({
          requestId: "inconsistent-request-metadata",
          events: [event("first"), event("second")],
        }),
      );
      fixture.db
        .query("UPDATE ledger_event SET request_hash = ? WHERE batch_index = 1")
        .run(HASH_B);

      expect(fixture.query.completeBatches({ throughLedgerSeq: 2 })).toEqual([]);
    } finally {
      fixture.close();
    }
  });
});

function durableCounts(dbPath: string) {
  const db = new Database(dbPath, { readonly: true, strict: true });
  try {
    return {
      events: (db.query("SELECT COUNT(*) AS count FROM ledger_event").get() as { count: number })
        .count,
      blobs: (db.query("SELECT COUNT(*) AS count FROM artifact_blob").get() as { count: number })
        .count,
      sessions: (
        db.query("SELECT COUNT(*) AS count FROM session_projection").get() as { count: number }
      ).count,
    };
  } finally {
    db.close();
  }
}
