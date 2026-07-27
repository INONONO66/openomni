import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLedgerQuery, LedgerQueryCapabilityClosedError } from "../../src/ledger/query.js";
import { openLedgerRuntime } from "../../src/ledger/runtime.js";
import { initializeSqliteDatabase } from "../../src/storage/sqlite-schema-lifecycle.js";

describe("LedgerQuery typed projection reads", () => {
  test("returns strict, deeply frozen typed rows through primary and indexed reads", () => {
    const db = new Database(":memory:", { strict: true });
    initializeSqliteDatabase(db);
    db.query(
      `INSERT INTO message_projection
       (message_id, owner_key, session_id, state_json, source_event_id,
        source_owner_seq, source_ledger_seq, source_owner_hash, updated_at_db_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "message-1",
      "owner-1",
      "session-1",
      JSON.stringify({ id: "message-1", nested: { frozen: true } }),
      "event-1",
      2,
      3,
      "a".repeat(64),
      4,
    );

    const query = createLedgerQuery(db);
    const row = query.message("message-1");
    expect(row).toEqual({
      messageId: "message-1",
      sessionId: "session-1",
      ownerKey: "owner-1",
      state: { id: "message-1", nested: { frozen: true } },
      sourceEventId: "event-1",
      sourceOwnerSeq: 2,
      sourceLedgerSeq: 3,
      sourceOwnerHash: "a".repeat(64),
      asOfLedgerSeq: 0,
      updatedAtDbMs: 4,
    });
    if (row === undefined) throw new Error("Expected inserted message projection");
    expect(query.messagesBySession("session-1")).toEqual([row]);
    expect(Object.isFrozen(row)).toBe(true);
    expect(Object.isFrozen(row.state)).toBe(true);
    expect(Object.isFrozen(row.state.nested)).toBe(true);
    db.close();
  });

  test("orders multi-message transcripts by source sequence and multi-part content by ordinal", () => {
    const db = new Database(":memory:", { strict: true });
    initializeSqliteDatabase(db);
    const insertMessage = db.query(
      `INSERT INTO message_projection
       (message_id, owner_key, session_id, state_json, source_event_id,
        source_owner_seq, source_ledger_seq, source_owner_hash, updated_at_db_ms)
       VALUES (?, 'owner-1', 'session-1', ?, ?, ?, ?, ?, 0)`,
    );
    insertMessage.run(
      "message-z",
      JSON.stringify({ id: "message-z", role: "user" }),
      "event-message-first",
      1,
      2,
      "2".repeat(64),
    );
    insertMessage.run(
      "message-a",
      JSON.stringify({ id: "message-a", role: "assistant" }),
      "event-message-second",
      2,
      9,
      "9".repeat(64),
    );

    const insertPart = db.query(
      `INSERT INTO part_projection
       (part_id, owner_key, session_id, message_id, part_ordinal, state_json,
        source_event_id, source_owner_seq, source_ledger_seq, source_owner_hash, updated_at_db_ms)
       VALUES (?, 'owner-1', 'session-1', 'message-z', ?, ?, ?, ?, ?, ?, 0)`,
    );
    insertPart.run(
      "part-a",
      2,
      JSON.stringify({ id: "part-a", text: "third" }),
      "event-part-third",
      3,
      3,
      "3".repeat(64),
    );
    insertPart.run(
      "part-z",
      0,
      JSON.stringify({ id: "part-z", text: "first" }),
      "event-part-first",
      4,
      8,
      "8".repeat(64),
    );
    insertPart.run(
      "part-m",
      1,
      JSON.stringify({ id: "part-m", text: "second" }),
      "event-part-second",
      5,
      4,
      "4".repeat(64),
    );

    const query = createLedgerQuery(db);
    expect(query.messagesBySession("session-1").map(({ messageId }) => messageId)).toEqual([
      "message-z",
      "message-a",
    ]);
    expect(
      query.partsByMessage("message-z").map(({ partId, partOrdinal, state }) => ({
        partId,
        partOrdinal,
        text: state.text,
      })),
    ).toEqual([
      { partId: "part-z", partOrdinal: 0, text: "first" },
      { partId: "part-m", partOrdinal: 1, text: "second" },
      { partId: "part-a", partOrdinal: 2, text: "third" },
    ]);
    db.close();
  });

  test("rejects projection state that is not a JSON object", () => {
    const db = new Database(":memory:", { strict: true });
    initializeSqliteDatabase(db);
    db.query(
      `INSERT INTO session_projection
       (session_id, owner_key, state_json, source_event_id, source_owner_seq,
        source_ledger_seq, source_owner_hash, updated_at_db_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("session-1", "owner-1", "[]", "event-1", 1, 1, "b".repeat(64), 0);
    expect(() => createLedgerQuery(db).session("session-1")).toThrow(
      "Projection state must be a JSON object",
    );
    db.close();
  });

  test("selects the newest matching grant deterministically without treating grant IDs as lookup keys", () => {
    const db = new Database(":memory:", { strict: true });
    initializeSqliteDatabase(db);
    const common = (state: unknown, eventId: string, ledgerSeq: number) =>
      [
        "owner-1",
        JSON.stringify(state),
        eventId,
        ledgerSeq,
        ledgerSeq,
        `${ledgerSeq}`.padStart(64, "0"),
        ledgerSeq,
      ] as const;
    const insertChannel = db.query(
      `INSERT INTO channel_grant_projection
       (grant_id, owner_key, state_json, source_event_id, source_owner_seq,
        source_ledger_seq, source_owner_hash, updated_at_db_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertChannel.run("grant-old", ...common({ channelId: "channel-1" }, "event-1", 1));
    insertChannel.run("grant-new", ...common({ channelId: "channel-1" }, "event-2", 2));

    const insertWorker = db.query(
      `INSERT INTO worker_grant_projection
       (grant_id, work_id, attempt_id, owner_key, state_json, source_event_id,
        source_owner_seq, source_ledger_seq, source_owner_hash, updated_at_db_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertWorker.run(
      "worker-grant-old",
      "work-1",
      "attempt-1",
      ...common({ workerRunId: "run-1" }, "event-3", 3),
    );
    insertWorker.run(
      "worker-grant-new",
      "work-1",
      "attempt-2",
      ...common({ workerRunId: "run-1" }, "event-4", 4),
    );

    const query = createLedgerQuery(db);
    expect(query.channelGrant("channel-1")?.grantId).toBe("grant-new");
    expect(query.channelGrant("grant-new")).toBeUndefined();
    expect(query.workerGrant("run-1")?.grantId).toBe("worker-grant-new");
    expect(query.workerGrant("worker-grant-new")).toBeUndefined();
    db.close();
  });

  test("expires a runtime query capability immediately after its callback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openomni-query-capability-"));
    const dbPath = join(directory, "ledger.sqlite");
    try {
      const runtime = openLedgerRuntime({ dbPath, projections: [] });
      let escaped: Parameters<typeof runtime.query>[0] extends (query: infer Q) => unknown
        ? Q
        : never;
      await runtime.query((query) => {
        escaped = query;
        expect(query.session("missing")).toBeUndefined();
      });
      expect(() => escaped.session("missing")).toThrow(LedgerQueryCapabilityClosedError);
      await runtime.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
