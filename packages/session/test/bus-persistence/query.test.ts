import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { BusQuery } from "../../src/bus-persistence/query.js";
import { Storage } from "../../src/storage/storage.js";
import "../../src/storage/initialize.js";

function db(): Database {
  return (Storage.getAdapter() as unknown as { readonly db: Database }).db;
}

function seedSession(id: string): void {
  const now = Date.now();
  Storage.getAdapter().session.set(id, {
    id,
    title: `Session ${id}`,
    model: { providerID: "test", modelID: "test-model" },
    time: { created: now, updated: now },
    spawnDepth: 0,
  });
}

function insertEvent(input: {
  readonly sessionId: string;
  readonly runId?: string;
  readonly type: string;
  readonly category: string;
  readonly data?: Record<string, unknown>;
  readonly traceId: string;
  readonly durationMs?: number;
  readonly timeCreated: number;
}): void {
  db()
    .query(
      `INSERT INTO bus_event
       (session_id, run_id, event_type, category, data, trace_id, duration_ms, time_created)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.sessionId,
      input.runId ?? null,
      input.type,
      input.category,
      JSON.stringify(input.data ?? {}),
      input.traceId,
      input.durationMs ?? null,
      input.timeCreated,
    );
}

function insertWorkerRun(input: {
  readonly runId: string;
  readonly sessionId: string;
  readonly status: string;
  readonly timeCreated: number;
  readonly timeUpdated: number;
}): void {
  db()
    .query(
      `INSERT INTO worker_run_state
       (run_id, session_id, parent_session_id, agent_name, status, title, prompt,
        resume_count, assigned_step_id, error, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.runId,
      input.sessionId,
      null,
      "worker",
      input.status,
      `Run ${input.runId}`,
      "do the work",
      0,
      null,
      null,
      input.timeCreated,
      input.timeUpdated,
    );
}

describe("BusQuery", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
    seedSession("sess-1");
    seedSession("sess-2");
  });

  afterEach(() => {
    Storage.reset();
  });

  test("listBySession maps persisted rows newest first", async () => {
    insertEvent({
      sessionId: "sess-1",
      runId: "run-1",
      type: "agent.execution.started",
      category: "agent",
      data: { ok: true },
      traceId: "trace-1",
      durationMs: 12,
      timeCreated: 100,
    });
    insertEvent({
      sessionId: "sess-1",
      type: "custom.note",
      category: "custom",
      data: { note: "latest" },
      traceId: "trace-2",
      timeCreated: 300,
    });
    insertEvent({
      sessionId: "sess-2",
      type: "agent.execution.started",
      category: "agent",
      traceId: "trace-other",
      timeCreated: 500,
    });

    const events = await BusQuery.listBySession("sess-1");

    expect(events.map((event) => event.eventType)).toEqual([
      "custom.note",
      "agent.execution.started",
    ]);
    expect(events[1]).toMatchObject({
      id: "1",
      sessionId: "sess-1",
      runId: "run-1",
      eventType: "agent.execution.started",
      category: "agent",
      data: { ok: true },
      traceId: "trace-1",
      durationMs: 12,
      timeCreated: 100,
    });
  });

  test("listBySession applies type, category, time, and limit filters", async () => {
    insertEvent({
      sessionId: "sess-1",
      type: "agent.execution.started",
      category: "agent",
      traceId: "trace-started",
      timeCreated: 100,
    });
    insertEvent({
      sessionId: "sess-1",
      type: "agent.execution.completed",
      category: "agent",
      traceId: "trace-completed-1",
      timeCreated: 200,
    });
    insertEvent({
      sessionId: "sess-1",
      type: "agent.execution.completed",
      category: "agent",
      traceId: "trace-completed-2",
      timeCreated: 300,
    });
    insertEvent({
      sessionId: "sess-1",
      type: "custom.note",
      category: "custom",
      traceId: "trace-custom",
      timeCreated: 250,
    });

    const events = await BusQuery.listBySession("sess-1", {
      type: "agent.execution.completed",
      category: "agent",
      after: 150,
      before: 350,
      limit: 1,
    });

    expect(events.map((event) => event.traceId)).toEqual(["trace-completed-2"]);
  });

  test("listByRun queries run-scoped events with filters", async () => {
    insertEvent({
      sessionId: "sess-1",
      runId: "run-1",
      type: "agent.step.started",
      category: "agent",
      traceId: "trace-started",
      timeCreated: 100,
    });
    insertEvent({
      sessionId: "sess-1",
      runId: "run-1",
      type: "agent.step.completed",
      category: "agent",
      traceId: "trace-completed",
      timeCreated: 200,
    });
    insertEvent({
      sessionId: "sess-1",
      runId: "run-2",
      type: "agent.step.completed",
      category: "agent",
      traceId: "trace-other-run",
      timeCreated: 300,
    });

    const events = await BusQuery.listByRun("run-1", {
      type: "agent.step.completed",
      after: 150,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ runId: "run-1", traceId: "trace-completed" });
  });

  test("listErrors returns operational error events for a session", async () => {
    insertEvent({
      sessionId: "sess-1",
      type: "operational.error",
      category: "operational",
      traceId: "trace-error-1",
      timeCreated: 100,
    });
    insertEvent({
      sessionId: "sess-1",
      type: "operational.error.tool",
      category: "operational",
      traceId: "trace-error-2",
      timeCreated: 200,
    });
    insertEvent({
      sessionId: "sess-1",
      type: "operational.warn",
      category: "operational",
      traceId: "trace-warn",
      timeCreated: 300,
    });
    insertEvent({
      sessionId: "sess-2",
      type: "operational.error",
      category: "operational",
      traceId: "trace-other-session",
      timeCreated: 400,
    });

    const events = await BusQuery.listErrors("sess-1");

    expect(events.map((event) => event.traceId)).toEqual(["trace-error-2", "trace-error-1"]);
  });

  test("getStats returns total, category, and type counts for a session", async () => {
    insertEvent({
      sessionId: "sess-1",
      type: "agent.step.started",
      category: "agent",
      traceId: "trace-1",
      timeCreated: 100,
    });
    insertEvent({
      sessionId: "sess-1",
      type: "agent.step.started",
      category: "agent",
      traceId: "trace-2",
      timeCreated: 200,
    });
    insertEvent({
      sessionId: "sess-1",
      type: "custom.note",
      category: "custom",
      traceId: "trace-3",
      timeCreated: 300,
    });
    insertEvent({
      sessionId: "sess-2",
      type: "agent.step.started",
      category: "agent",
      traceId: "trace-other-session",
      timeCreated: 400,
    });

    const stats = await BusQuery.getStats("sess-1");

    expect(stats).toEqual({
      totalEvents: 3,
      byCategory: { agent: 2, custom: 1 },
      byType: { "agent.step.started": 2, "custom.note": 1 },
    });
  });

  test("getWorkerRunHistory returns session-scoped runs newest first", async () => {
    insertWorkerRun({
      runId: "run-1",
      sessionId: "sess-1",
      status: "running",
      timeCreated: 100,
      timeUpdated: 150,
    });
    insertWorkerRun({
      runId: "run-2",
      sessionId: "sess-1",
      status: "completed",
      timeCreated: 300,
      timeUpdated: 350,
    });
    insertWorkerRun({
      runId: "run-3",
      sessionId: "sess-2",
      status: "queued",
      timeCreated: 500,
      timeUpdated: 500,
    });

    const runs = await BusQuery.getWorkerRunHistory("sess-1");

    expect(runs).toEqual([
      { runId: "run-2", status: "completed", eventCount: 0, startTime: 300, endTime: 350 },
      { runId: "run-1", status: "running", eventCount: 0, startTime: 100, endTime: 150 },
    ]);
  });

  test("query functions return empty results for missing data", async () => {
    await expect(BusQuery.listBySession("sess-1")).resolves.toEqual([]);
    await expect(BusQuery.listByRun("missing-run")).resolves.toEqual([]);
    await expect(BusQuery.listErrors("sess-1")).resolves.toEqual([]);
    await expect(BusQuery.getStats("sess-1")).resolves.toEqual({
      totalEvents: 0,
      byCategory: {},
      byType: {},
    });
    await expect(BusQuery.getWorkerRunHistory("sess-1")).resolves.toEqual([]);
  });
});
