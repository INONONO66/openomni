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
    CronJobRegistry.clear();
    Storage.reset();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  });

  test("registered jobs survive storage reinitialization", () => {
    const paths = tempDbPath();
    tmpDir = paths.dir;
    Storage.initialize({ dbPath: paths.dbPath });
    const job = jobFixture();

    CronJobRegistry.register(job);
    Storage.reset();
    CronJobRegistry.clear();
    Storage.initialize({ dbPath: paths.dbPath });

    expect(CronJobRegistry.list()).toEqual([job]);
  });

  test("registry falls back to process memory when storage is not initialized", () => {
    Storage.reset();
    const job = jobFixture();

    CronJobRegistry.register(job);

    expect(Storage.initializedDbPath).toBeNull();
    expect(CronJobRegistry.list()).toEqual([job]);
    expect(CronJobRegistry.remove(job.id)).toBe(true);
    expect(CronJobRegistry.list()).toEqual([]);
  });

  test("removed jobs stay removed after storage reinitialization", () => {
    const paths = tempDbPath();
    tmpDir = paths.dir;
    Storage.initialize({ dbPath: paths.dbPath });
    const first = jobFixture("job-1");
    const second = jobFixture("job-2");

    CronJobRegistry.register(first);
    CronJobRegistry.register(second);
    expect(CronJobRegistry.remove("job-1")).toBe(true);
    Storage.reset();
    CronJobRegistry.clear();
    Storage.initialize({ dbPath: paths.dbPath });

    expect(CronJobRegistry.list()).toEqual([second]);
    expect(CronJobRegistry.remove("missing")).toBe(false);
  });
});
