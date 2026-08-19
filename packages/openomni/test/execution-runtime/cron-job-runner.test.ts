import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ingress, type CronJob, type Command } from "@openomni/protocol";
import { Storage, SurfaceKey } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";
import { DispatchRegistry, registerBuiltInDispatchHandlers } from "../../src/dispatch";
import { CronJobRegistry, CronJobRunner } from "../../src/execution-runtime";
import { CronAdapter, createBrainEngine, ResidentRuntime } from "../../src";

function tempDbPath(): { readonly dir: string; readonly dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "openomni-cron-runner-"));
  return { dir, dbPath: join(dir, "storage.db") };
}

function dueJob(id = "job-due"): CronJob.Info {
  return {
    id,
    agentName: "resident",
    payload: "send status",
    schedule: "* * * * *",
    target: { kind: "resident", sessionId: "session-1" },
    createdAt: 1_710_000_000_000,
    nextFireAt: 1_710_000_060_000,
  };
}

function leapDayJob(id = "job-leap-day"): CronJob.Info {
  return {
    id,
    agentName: "resident",
    payload: "leap day report",
    schedule: "0 0 29 2 *",
    target: { kind: "resident", sessionId: "session-1" },
    createdAt: Date.UTC(2024, 1, 28, 23, 59),
    nextFireAt: Date.UTC(2024, 1, 29, 0, 0),
  };
}

function command(
  action: string,
  target: Command.Target,
  payload: unknown = "hello",
): Command.Request {
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

describe("CronJobRunner", () => {
  let tmpDir = "";

  // Storage is the single canonical cron backing (fail-closed before init);
  // give every test a live in-memory store. Reopen tests reset and reinitialize
  // against a temp db to exercise durability.
  beforeEach(() => {
    Storage.initialize({ dbPath: ":memory:" });
  });

  afterEach(() => {
    Bus.reset();
    Storage.reset();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  });

  test("fires due persisted jobs and advances their next run", async () => {
    const paths = tempDbPath();
    tmpDir = paths.dir;
    Storage.reset();
    Storage.initialize({ dbPath: paths.dbPath });
    CronJobRegistry.register(dueJob(), "trace-cron-test");

    Storage.reset();
    Storage.initialize({ dbPath: paths.dbPath });

    const fired: CronJob.Info[] = [];
    await CronJobRunner.tick({
      nowMs: () => 1_710_000_060_000,
      fire: async (job) => {
        fired.push(job);
      },
    });

    expect(fired.map((job) => job.id)).toEqual(["job-due"]);
    expect(CronJobRegistry.list()).toEqual([
      {
        ...dueJob(),
        nextFireAt: 1_710_000_120_000,
      },
    ]);

    await CronJobRunner.tick({
      nowMs: () => 1_710_000_060_000,
      fire: async (job) => {
        fired.push(job);
      },
    });

    expect(fired.map((job) => job.id)).toEqual(["job-due"]);
  });

  test("initializes jobs without nextFireAt before firing", async () => {
    const job = dueJob("job-created");
    CronJobRegistry.register({ ...job, nextFireAt: undefined }, "trace-cron-test");

    const fired: CronJob.Info[] = [];
    await CronJobRunner.tick({
      nowMs: () => 1_710_000_030_000,
      fire: async (candidate) => {
        fired.push(candidate);
      },
    });

    expect(fired).toEqual([]);
    expect(CronJobRegistry.list()).toEqual([
      {
        ...job,
        nextFireAt: 1_710_000_060_000,
      },
    ]);
  });

  test("computes next fire times in UTC", async () => {
    const job = {
      ...dueJob("job-utc-noon"),
      schedule: "0 12 * * *",
      createdAt: Date.UTC(2026, 0, 1, 0, 0),
      nextFireAt: undefined,
    };
    CronJobRegistry.register(job, "trace-cron-test");

    await CronJobRunner.tick({ nowMs: () => Date.UTC(2026, 0, 1, 1, 0) });

    expect(CronJobRegistry.get(job.id)?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 12, 0));
  });

  test("requires day-of-month and day-of-week to both match", async () => {
    const job = {
      ...dueJob("job-friday-13"),
      schedule: "0 0 13 * 5",
      createdAt: Date.UTC(2026, 0, 1, 0, 0),
      nextFireAt: undefined,
    };
    CronJobRegistry.register(job, "trace-cron-test");

    await CronJobRunner.tick({ nowMs: () => Date.UTC(2026, 0, 2, 0, 0) });

    expect(CronJobRegistry.get(job.id)?.nextFireAt).toBe(Date.UTC(2026, 1, 13, 0, 0));
  });

  test("start runs a boot tick and can be stopped", async () => {
    CronJobRegistry.register(dueJob("job-boot"), "trace-cron-test");
    const fired: string[] = [];

    const runner = CronJobRunner.start({
      intervalMs: 60_000,
      nowMs: () => 1_710_000_060_000,
      fire: async (job) => {
        fired.push(job.id);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    runner.stop();

    expect(fired).toEqual(["job-boot"]);
  });

  test("continues after an invalid persisted schedule", async () => {
    CronJobRegistry.register(
      {
        ...dueJob("job-bad"),
        schedule: "1-2-3 * * * *",
        nextFireAt: undefined,
      },
      "trace-cron-test",
    );
    CronJobRegistry.register(dueJob("job-good"), "trace-cron-test");

    const fired: string[] = [];
    await CronJobRunner.tick({
      nowMs: () => 1_710_000_060_000,
      fire: async (job) => {
        fired.push(job.id);
      },
    });

    expect(fired).toEqual(["job-good"]);
  });

  test("rejects second-precision schedules", async () => {
    CronJobRegistry.register(
      {
        ...dueJob("job-six-field"),
        schedule: "*/5 * * * * *",
        nextFireAt: undefined,
      },
      "trace-cron-test",
    );
    CronJobRegistry.register(dueJob("job-good"), "trace-cron-test");

    const fired: string[] = [];
    await CronJobRunner.tick({
      nowMs: () => 1_710_000_060_000,
      fire: async (job) => {
        fired.push(job.id);
      },
    });

    expect(fired).toEqual(["job-good"]);
    expect(CronJobRegistry.get("job-six-field")?.nextFireAt).toBeUndefined();
  });

  test("rejects croner extension syntax that the legacy parser did not support", async () => {
    const invalidSchedules = [
      "@daily",
      "0 0 * JAN *",
      "0 0 * * MON",
      "0 0 ? * *",
      "0 0 L * *",
      "0 0 * * 1#2",
    ];
    for (const [index, schedule] of invalidSchedules.entries()) {
      CronJobRegistry.register(
        {
          ...dueJob(`job-extension-${index}`),
          schedule,
          nextFireAt: undefined,
        },
        "trace-cron-test",
      );
    }
    CronJobRegistry.register(dueJob("job-good"), "trace-cron-test");

    const fired: string[] = [];
    await CronJobRunner.tick({
      nowMs: () => 1_710_000_060_000,
      fire: async (job) => {
        fired.push(job.id);
      },
    });

    expect(fired).toEqual(["job-good"]);
    for (const [index] of invalidSchedules.entries()) {
      expect(CronJobRegistry.get(`job-extension-${index}`)?.nextFireAt).toBeUndefined();
    }
  });

  test("preserves legacy step values that exceed the field size", async () => {
    const job = {
      ...dueJob("job-large-step"),
      schedule: "*/100 * * * *",
      createdAt: Date.UTC(2026, 0, 1, 12, 1),
      nextFireAt: undefined,
    };
    CronJobRegistry.register(job, "trace-cron-test");

    await CronJobRunner.tick({ nowMs: () => Date.UTC(2026, 0, 1, 12, 2) });

    expect(CronJobRegistry.get(job.id)?.nextFireAt).toBe(Date.UTC(2026, 0, 1, 13, 0));
  });

  test("does not reinsert jobs cancelled while firing", async () => {
    const job = dueJob("job-cancelled-during-fire");
    CronJobRegistry.register(job, "trace-cron-test");

    await CronJobRunner.tick({
      nowMs: () => 1_710_000_060_000,
      fire: async (candidate) => {
        expect(candidate.id).toBe(job.id);
        expect(CronJobRegistry.remove(candidate.id, "trace-cron-test")).toBe(true);
      },
    });

    expect(CronJobRegistry.list()).toEqual([]);
  });

  test("does not reinsert persisted jobs cancelled while firing", async () => {
    const paths = tempDbPath();
    tmpDir = paths.dir;
    Storage.reset();
    Storage.initialize({ dbPath: paths.dbPath });
    const job = dueJob("job-persisted-cancel");
    CronJobRegistry.register(job, "trace-cron-test");

    await CronJobRunner.tick({
      nowMs: () => 1_710_000_060_000,
      fire: async (candidate) => {
        expect(candidate.id).toBe(job.id);
        expect(CronJobRegistry.remove(candidate.id, "trace-cron-test")).toBe(true);
      },
    });

    expect(CronJobRegistry.list()).toEqual([]);
  });

  test("advances leap-day schedules instead of refiring them every tick", async () => {
    const job = leapDayJob();
    CronJobRegistry.register(job, "trace-cron-test");

    const fired: string[] = [];
    await CronJobRunner.tick({
      nowMs: () => Date.UTC(2024, 1, 29, 0, 0),
      fire: async (candidate) => {
        fired.push(candidate.id);
      },
    });

    expect(fired).toEqual([job.id]);
    expect(CronJobRegistry.get(job.id)?.nextFireAt).toBe(Date.UTC(2028, 1, 29, 0, 0));
  });

  test("fires a schedule.create job through CronAdapter after storage reopen", async () => {
    const paths = tempDbPath();
    tmpDir = paths.dir;
    Storage.reset();
    Storage.initialize({ dbPath: paths.dbPath });
    const registry = new DispatchRegistry();
    registerBuiltInDispatchHandlers(registry);

    await registry.get("schedule.create")?.(
      command(
        "schedule.create",
        { kind: "schedule", name: "resident" },
        { schedule: "* * * * *", payload: "manual cron payload" },
      ),
    );
    const created = CronJobRegistry.list()[0];
    if (!created) throw new Error("schedule.create did not persist a cron job");

    Storage.reset();
    Storage.initialize({ dbPath: paths.dbPath });

    const received: Array<{ surface: string; mode: string; target?: string }> = [];
    const outputs: string[] = [];
    const unsubscribe = Bus.subscribe(Ingress.Events.Received, (event) => {
      received.push(event);
    });
    const engine = createBrainEngine({
      agentResolver: {
        resolve: async () => ({ model: { provider: "anthropic", id: "claude-3-5-sonnet" } }),
      },
      residentRuntime: ResidentRuntime.create({
        runAgent: async (_config, input) => {
          outputs.push(String(input.messages.at(-1)?.content ?? ""));
          return { text: "cron-result", finishReason: "stop" };
        },
      }),
      // #708: cron stickiness claims cross the injected gateway port; the
      // test binds the same ledger CAS the router wraps.
      claimSurface: (surfaceKey, sessionId, expectedSessionId) =>
        SurfaceKey.claim(surfaceKey, sessionId, expectedSessionId),
    });

    try {
      await CronJobRunner.tick({
        nowMs: () => created.createdAt + 60_000,
        fire: async (job, traceId) => {
          await CronAdapter.fire(job, engine, traceId);
        },
      });
    } finally {
      unsubscribe();
    }

    expect(received.at(-1)).toMatchObject({ surface: "cron", mode: "internal" });
    expect(outputs).toEqual(["manual cron payload"]);
    expect(CronJobRegistry.list()[0]?.nextFireAt).toBeGreaterThan(created.createdAt + 60_000);
  });
});
