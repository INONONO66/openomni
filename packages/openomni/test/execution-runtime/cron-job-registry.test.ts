import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CronJob } from "@openomni/protocol";
import { Storage } from "@openomni/session";
import { CronJobRegistry } from "../../src/execution-runtime/cron-job-registry";

function tempDbPath(): { readonly dir: string; readonly dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "openomni-cron-registry-"));
  return { dir, dbPath: join(dir, "storage.db") };
}

function jobFixture(id = "job-restart"): CronJob.Info {
  return {
    id,
    agentName: "resident",
    payload: "send status",
    schedule: "0 9 * * *",
    target: { kind: "resident", sessionId: "session-1" },
    createdAt: 1_710_000_000_000,
    nextFireAt: 1_710_003_600_000,
  };
}

describe("CronJobRegistry persistence", () => {
  let tmpDir = "";

  afterEach(() => {
    Storage.reset();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  });

  test("registered jobs survive storage reinitialization", () => {
    const paths = tempDbPath();
    tmpDir = paths.dir;
    Storage.initialize({ dbPath: paths.dbPath });
    const job = jobFixture();

    CronJobRegistry.register(job, "trace-cron-test");
    Storage.reset();
    Storage.initialize({ dbPath: paths.dbPath });

    expect(CronJobRegistry.list()).toEqual([job]);
  });

  test("register before initialize fails closed instead of stranding a volatile job", () => {
    // #522/#547: cron is durable by definition. A job accepted into a volatile
    // module-level Map before Storage.initialize() is stranded the moment
    // get/list start reading storage. Registering before init is a loud
    // boot-order bug, never a silent in-memory write.
    Storage.reset();
    const job = jobFixture();

    expect(() => CronJobRegistry.register(job, "trace-cron-test")).toThrow(/before initialize/);
    expect(Storage.getInitializedDbPath()).toBeNull();
  });

  test("clear() empties the single canonical backing, not just process memory", () => {
    const paths = tempDbPath();
    tmpDir = paths.dir;
    Storage.initialize({ dbPath: paths.dbPath });
    CronJobRegistry.register(jobFixture("job-1"), "trace-cron-test");
    CronJobRegistry.register(jobFixture("job-2"), "trace-cron-test");
    expect(CronJobRegistry.list()).toHaveLength(2);

    CronJobRegistry.clear();

    expect(CronJobRegistry.list()).toEqual([]);
  });

  test("removed jobs stay removed after storage reinitialization", () => {
    const paths = tempDbPath();
    tmpDir = paths.dir;
    Storage.initialize({ dbPath: paths.dbPath });
    const first = jobFixture("job-1");
    const second = jobFixture("job-2");

    CronJobRegistry.register(first, "trace-cron-test");
    CronJobRegistry.register(second, "trace-cron-test");
    expect(CronJobRegistry.remove("job-1", "trace-cron-test")).toBe(true);
    Storage.reset();
    Storage.initialize({ dbPath: paths.dbPath });

    expect(CronJobRegistry.list()).toEqual([second]);
    expect(CronJobRegistry.remove("missing", "trace-cron-test")).toBe(false);
  });
});
