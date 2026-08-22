import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CronJob } from "@openomni/protocol";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage";

function tempDbPath(): string {
  return join(tmpdir(), `test-sqlite-cron-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function removeSqliteFiles(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch (_err) {
      void _err;
    }
  }
}

function makeCronJob(id: string, createdAt = Date.now()): CronJob.Info {
  return {
    id,
    agentName: "resident",
    payload: `Payload ${id}`,
    schedule: "0 9 * * *",
    target: { kind: "resident", sessionId: "s1" },
    createdAt,
    nextFireAt: createdAt + 3_600_000,
  };
}

describe("SqliteStorageAdapter cronJob", () => {
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
    removeSqliteFiles(dbPath);
  });

  test("get returns undefined for non-existent jobs", () => {
    expect(adapter.cronJob.get("missing")).toBeUndefined();
  });

  test("set/get/list/remove round trips cron jobs", () => {
    const first = makeCronJob("job-1", 100);
    const second = makeCronJob("job-2", 200);

    adapter.cronJob.set(second);
    adapter.cronJob.set(first);

    expect(adapter.cronJob.get("job-1")).toEqual(first);
    expect(adapter.cronJob.list()).toEqual([first, second]);
    expect(adapter.cronJob.remove("job-1")).toBe(true);
    expect(adapter.cronJob.get("job-1")).toBeUndefined();
    expect(adapter.cronJob.list()).toEqual([second]);
  });

  test("set upserts existing cron job rows", () => {
    const initial = makeCronJob("job-1", 100);
    const updated: CronJob.Info = { ...initial, payload: "updated", nextFireAt: 500 };

    adapter.cronJob.set(initial);
    adapter.cronJob.set(updated);

    expect(adapter.cronJob.get("job-1")).toEqual(updated);
    expect(adapter.cronJob.list()).toEqual([updated]);
  });

  test("cron jobs survive close and reopen", () => {
    const job = makeCronJob("job-1", 100);
    adapter.cronJob.set(job);
    adapter.close();

    const adapter2 = new SqliteStorageAdapter(dbPath);
    expect(adapter2.cronJob.list()).toEqual([job]);
    adapter2.close();
  });

  test("clear removes cron jobs", () => {
    adapter.cronJob.set(makeCronJob("job-1", 100));

    adapter.clear();

    expect(adapter.cronJob.list()).toEqual([]);
  });
});
