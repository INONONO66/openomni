import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Dispatch } from "@openomni/protocol";
import { Storage } from "@openomni/session";
import { DispatchRegistry } from "../../src/dispatch/registry";
import { registerBuiltInDispatchHandlers } from "../../src/dispatch/setup";
import { CronJobRegistry } from "../../src/execution-runtime/cron-job-registry";

function command(
  action: string,
  target: Dispatch.Target,
  payload: unknown = "hello",
): Dispatch.Command {
  return {
    dispatchId: `dispatch-${action}`,
    action,
    target,
    payload,
    actor: { kind: "resident", actorId: "agent:resident", agentName: "resident" },
    traceId: "trace-1",
    submittedAt: Date.now(),
  };
}

function tempDbPath(): string {
  return join(
    tmpdir(),
    `dispatch-schedule-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
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

describe("built-in schedule dispatch persistence", () => {
  const dbPaths = new Set<string>();

  beforeEach(() => {
    CronJobRegistry.clear();
    Storage.reset();
  });

  afterEach(() => {
    CronJobRegistry.clear();
    Storage.reset();
    for (const dbPath of dbPaths) removeSqliteFiles(dbPath);
    dbPaths.clear();
  });

  test("default schedule handlers persist and cancel cron jobs across storage reopen", async () => {
    const dbPath = tempDbPath();
    dbPaths.add(dbPath);
    Storage.initialize({ dbPath });

    const registry = new DispatchRegistry();
    registerBuiltInDispatchHandlers(registry);

    await registry.get("schedule.create")?.(
      command(
        "schedule.create",
        { kind: "schedule", name: "resident", sessionId: "session-1" },
        { schedule: "0 9 * * *", payload: "report" },
      ),
    );

    const jobs = CronJobRegistry.list();
    expect(jobs).toHaveLength(1);
    const job = jobs[0];
    if (!job) throw new Error("schedule.create did not persist a cron job");
    const jobId = job.id;
    expect(jobs).toMatchObject([
      {
        id: jobId,
        agentName: "resident",
        payload: "report",
        schedule: "0 9 * * *",
        target: { kind: "resident", sessionId: "session-1" },
      },
    ]);

    Storage.reset();
    CronJobRegistry.clear();
    Storage.initialize({ dbPath });

    expect(CronJobRegistry.list().map((reopenedJob) => reopenedJob.id)).toEqual([jobId]);

    const cancelResult = await registry.get("schedule.cancel")?.(
      command("schedule.cancel", { kind: "schedule", id: jobId }),
    );

    expect(cancelResult).toEqual({ output: { cancelled: true, jobId } });
    Storage.reset();
    CronJobRegistry.clear();
    Storage.initialize({ dbPath });
    expect(CronJobRegistry.list()).toEqual([]);
  });
});
