import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wait } from "../../packages/protocol/src/index";
import { Bus, SqliteStorageAdapter, Storage, WaitStore } from "../../packages/session/src/index";
import { Ledger } from "../../packages/session/src/ledger-core/index";

/**
 * #510 phase B conformance — the Wait decision class against the clean
 * ledger baseline ("no record, no action"):
 *
 *   (a) append-before-act: every committed Wait transition has its
 *       decision-class fact on the owner stream `wait:<id>` at
 *       seq === projected revision, and a failed append leaves no
 *       projection change and no Bus event;
 *   (b) a stale expectedHead is a typed conflict (revision_conflict at the
 *       store, cas_conflict at the append core) that writes nothing;
 *   (c) boot tail verification over the wait streams reports no breaks
 *       after a normal run and detects a tampered row.
 *
 * Ledger and session sources are imported by path (not the package entry)
 * so every module — including the non-exported ledger core — resolves to
 * one instance.
 */

let tempDir: string;
let inspect: Database;

beforeEach(() => {
  Bus.reset();
  Storage.reset();
  tempDir = mkdtempSync(join(tmpdir(), "p2-ledger-baseline-"));
  Storage.initialize({ dbPath: join(tempDir, "openomni.db") });
  // Second connection on the same WAL file: assertions and tampering must
  // not ride the writer's connection.
  inspect = new Database(join(tempDir, "openomni.db"));
});

afterEach(() => {
  inspect.close();
  const adapter = Storage.getAdapter();
  if (adapter instanceof SqliteStorageAdapter) adapter.close();
  Storage.reset();
  Bus.reset();
  rmSync(tempDir, { recursive: true, force: true });
});

const flushBus = () => new Promise<void>((resolve) => queueMicrotask(() => resolve()));

function buildWaitCreate(overrides: Partial<Wait.Create> = {}): Wait.Create {
  return {
    id: "wait-1",
    ownerRef: { kind: "workItem", id: "wi-1" },
    originMessageId: "out-msg-1",
    correlation: { tokenHash: "tok-1" },
    allowedActions: ["report_result"],
    expectedResponders: ["actor-a"],
    resolutionPolicy: "first_reply",
    expiresAt: 10_000,
    followUpWindow: 1_000,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

function buildReplyInput(overrides: Partial<Wait.ReplyInput> = {}): Wait.ReplyInput {
  return {
    replyKey: "reply-key-1",
    responderCandidates: ["actor-a"],
    messageId: "in-msg-1",
    at: 1_000,
    ...overrides,
  };
}

interface FactRow {
  readonly seq: number;
  readonly type: string;
  readonly data: string;
}

function factsOf(waitId: string): FactRow[] {
  return inspect
    .query("SELECT seq, type, data FROM ledger_event WHERE stream_id = ? ORDER BY seq ASC")
    .all(`wait:${waitId}`) as FactRow[];
}

function headOf(waitId: string): number | undefined {
  const row = inspect
    .query("SELECT head FROM ledger_head WHERE stream_id = ?")
    .get(`wait:${waitId}`) as { head: number } | null;
  return row?.head;
}

function captureStoreError(fn: () => unknown): InstanceType<typeof Wait.StoreError> {
  try {
    fn();
  } catch (error) {
    if (Wait.StoreError.isInstance(error)) return error;
    throw error;
  }
  throw new Error("expected WaitStoreError, but nothing was thrown");
}

describe("p2 ledger baseline — Wait decision-class facts", () => {
  test("append-before-act: every committed transition appends its fact at seq === projected revision", () => {
    const created = WaitStore.create(buildWaitCreate());
    const resolved = WaitStore.attachReply("wait-1", buildReplyInput());
    if (resolved.kind !== "resolved") throw new Error(`expected resolved, got ${resolved.kind}`);

    const facts = factsOf("wait-1");
    expect(facts.map((fact) => [fact.seq, fact.type])).toEqual([
      [1, "wait.opened"],
      [2, "wait.resolved"],
    ]);
    // Head↔revision binding: the stream head IS the projected revision.
    expect(created.revision).toBe(1);
    expect(resolved.record.revision).toBe(2);
    expect(headOf("wait-1")).toBe(2);
    expect(WaitStore.get("wait-1")?.revision).toBe(2);

    // The fact stores the outcome's typed payload plus the resulting
    // revision — never the record snapshot (the projection row stays the
    // read model).
    const opened = JSON.parse(facts[0]?.data ?? "{}") as Record<string, unknown>;
    expect(opened).toEqual({
      ownerKind: "workItem",
      ownerId: "wi-1",
      originMessageId: "out-msg-1",
      expiresAt: 10_000,
      revision: 1,
    });
    const resolvedFact = JSON.parse(facts[1]?.data ?? "{}") as Record<string, unknown>;
    expect(resolvedFact).toMatchObject({
      replyKey: "reply-key-1",
      responderId: "actor-a",
      responders: 1,
      threshold: 1,
      resolvedAt: 1_000,
      revision: 2,
    });
    expect(Object.keys(resolvedFact)).not.toContain("replies");
    expect(Object.keys(resolvedFact)).not.toContain("correlation");
  });

  test("a failed append leaves no projection change, no extra fact, and no Bus event", async () => {
    WaitStore.create(buildWaitCreate());
    const events: string[] = [];
    Bus.observe((event) => events.push(event.name));

    // A concurrent writer advances the stream between the read and the
    // append: the appended cancel fact wins, the outer expire must fail as
    // a typed revision_conflict with nothing written.
    const error = captureStoreError(() =>
      WaitStore.transition("wait-1", (record) => {
        WaitStore.cancel("wait-1", 500);
        return Wait.expire(record, { at: 20_000 });
      }),
    );

    expect(error.data.code).toBe("revision_conflict");
    const persisted = WaitStore.get("wait-1");
    expect(persisted?.status).toBe("cancelled");
    expect(persisted?.revision).toBe(2);
    // The CAS receipt and the ledger head never disagree: only the inner
    // cancel appended (seq 2); the failed expire left no fact behind.
    expect(headOf("wait-1")).toBe(2);
    expect(factsOf("wait-1").map((fact) => fact.type)).toEqual(["wait.opened", "wait.cancelled"]);
    await flushBus();
    expect(events).toContain("wait.cancelled");
    expect(events).not.toContain("wait.expired");
  });

  test("a stale expectedHead at the append core is a typed cas_conflict that writes nothing", () => {
    WaitStore.create(buildWaitCreate());

    const conflict = Ledger.append(
      inspect,
      { streamId: "wait:wait-1", type: "wait.cancelled", data: { revision: 1 } },
      0,
    );

    expect(conflict).toEqual({ kind: "cas_conflict", currentHead: 1 });
    expect(factsOf("wait-1")).toHaveLength(1);
    expect(headOf("wait-1")).toBe(1);
  });

  test("a duplicate create conflicts on the owner stream and projects nothing", async () => {
    WaitStore.create(buildWaitCreate());
    const events: string[] = [];
    Bus.observe((event) => events.push(event.name));

    const error = captureStoreError(() =>
      WaitStore.create(buildWaitCreate({ originMessageId: "out-msg-2" })),
    );

    expect(error.data.code).toBe("duplicate");
    expect(factsOf("wait-1")).toHaveLength(1);
    expect(headOf("wait-1")).toBe(1);
    expect(WaitStore.get("wait-1")?.originMessageId).toBe("out-msg-1");
    await flushBus();
    expect(events).not.toContain("wait.opened");
  });

  test("boot tail verification passes after a normal run and detects a tampered row", () => {
    WaitStore.create(buildWaitCreate());
    WaitStore.attachReply("wait-1", buildReplyInput());
    WaitStore.create(buildWaitCreate({ id: "wait-2", originMessageId: "out-msg-2" }));
    WaitStore.expire("wait-2", 10_001);

    expect(Ledger.verifyTail(inspect)).toEqual([]);

    inspect
      .query("UPDATE ledger_event SET data = ? WHERE stream_id = ? AND seq = ?")
      .run('{"partial":true,"revision":2}', "wait:wait-2", 2);

    const breaks = Ledger.verifyTail(inspect);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]).toMatchObject({
      streamId: "wait:wait-2",
      seq: 2,
      code: "hash_mismatch",
    });
  });
});
