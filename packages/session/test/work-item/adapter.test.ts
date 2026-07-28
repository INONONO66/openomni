import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkItem } from "@openomni/protocol";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage";

function tempDbPath(): string {
  return join(tmpdir(), `test-work-item-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function makeWorkItem(overrides: Partial<WorkItem.Info> = {}): WorkItem.Info {
  const now = Date.now();
  return {
    hash: "wi_1",
    name: "Test item",
    sourceMessageId: "msg-1",
    sourceChannel: "discord",
    attempt: 1,
    timestamps: { created: now, updated: now },
    relations: { childHashes: [], dependsOn: [] },
    intent: "test",
    goal: "verify persistence",
    blockers: [],
    evidence: [],
    constraints: [],
    acceptanceCriteria: [],
    changedFiles: [],
    ...overrides,
  };
}

describe("SqliteStorageAdapter workItem", () => {
  let dbPath = "";
  let adapter: SqliteStorageAdapter;

  beforeEach(() => {
    dbPath = tempDbPath();
    adapter = new SqliteStorageAdapter(dbPath);
  });

  afterEach(() => {
    try {
      adapter.close();
    } catch (_err) {
      void _err;
    }
    try {
      unlinkSync(dbPath);
    } catch (_err) {
      void _err;
    }
  });

  test("round-trips through get, list, and remove", () => {
    const item = makeWorkItem({
      hash: "wi_000roundtrip",
      sessionId: "session-1",
      assigneeId: "agent-1",
      relations: { parentHash: "parent-1", childHashes: [], dependsOn: [] },
      timestamps: { created: 1000, updated: 1000, completed: 2000 },
    });

    adapter.workItem?.set(item.hash, item);

    expect(adapter.workItem?.get(item.hash)).toEqual(item);
    expect(adapter.workItem?.list()).toEqual([item]);
    expect(adapter.workItem?.remove(item.hash)).toBe(true);
    expect(adapter.workItem?.get(item.hash)).toBeUndefined();
  });

  test("list filters by status and sessionId", () => {
    const pending = makeWorkItem({
      hash: "wi_00000pending",
      sessionId: "s1",
      timestamps: { created: 1, updated: 1 },
    });
    const completed = makeWorkItem({
      hash: "wi_000completed",
      sessionId: "s2",
      timestamps: { created: 2, updated: 2, completed: 3 },
    });

    adapter.workItem?.set(pending.hash, pending);
    adapter.workItem?.set(completed.hash, completed);

    expect(adapter.workItem?.list({ status: ["completed"] }).map((item) => item.hash)).toEqual([
      "wi_000completed",
    ]);
    expect(adapter.workItem?.list({ sessionId: "s1" }).map((item) => item.hash)).toEqual([
      "wi_00000pending",
    ]);
  });

  test("clear removes work items", () => {
    const items = [
      makeWorkItem({ hash: "wi_00000000000a", timestamps: { created: 1, updated: 1 } }),
      makeWorkItem({
        hash: "wi_00000000000b",
        timestamps: { created: 2, updated: 2, completed: 3 },
      }),
      makeWorkItem({
        hash: "wi_00000000000c",
        timestamps: { created: 3, updated: 3, cancelled: 4 },
      }),
    ];

    for (const item of items) {
      adapter.workItem?.set(item.hash, item);
    }

    adapter.clear();

    expect(adapter.workItem?.list()).toEqual([]);
  });
});
