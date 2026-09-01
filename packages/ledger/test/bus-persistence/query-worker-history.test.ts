import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BusQuery } from "../../src/bus-persistence/query.js";
import {
  cleanupQueryStorage,
  insertEvent,
  insertWorkerRun,
  resetQueryStorage,
} from "./query-fixture.js";

describe("BusQuery worker run history", () => {
  beforeEach(resetQueryStorage);
  afterEach(cleanupQueryStorage);

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

  test("getWorkerRunHistory reports actual event count per run", async () => {
    insertWorkerRun({
      runId: "run-1",
      sessionId: "sess-1",
      status: "completed",
      timeCreated: 100,
      timeUpdated: 200,
    });
    insertWorkerRun({
      runId: "run-2",
      sessionId: "sess-1",
      status: "running",
      timeCreated: 300,
      timeUpdated: 350,
    });
    insertWorkerRun({
      runId: "run-3",
      sessionId: "sess-2",
      status: "completed",
      timeCreated: 400,
      timeUpdated: 450,
    });

    insertEvent({
      sessionId: "sess-1",
      runId: "run-1",
      type: "agent.step.started",
      category: "agent",
      traceId: "t1",
      timeCreated: 110,
    });
    insertEvent({
      sessionId: "sess-1",
      runId: "run-1",
      type: "agent.tool.invoked",
      category: "agent",
      traceId: "t2",
      timeCreated: 120,
    });
    insertEvent({
      sessionId: "sess-1",
      runId: "run-1",
      type: "agent.step.completed",
      category: "agent",
      traceId: "t3",
      timeCreated: 130,
    });
    insertEvent({
      sessionId: "sess-1",
      runId: "run-2",
      type: "agent.step.started",
      category: "agent",
      traceId: "t4",
      timeCreated: 310,
    });
    insertEvent({
      sessionId: "sess-2",
      runId: "run-3",
      type: "agent.step.started",
      category: "agent",
      traceId: "t5",
      timeCreated: 410,
    });
    insertEvent({
      sessionId: "sess-1",
      type: "custom.note",
      category: "custom",
      traceId: "t6",
      timeCreated: 500,
    });

    const runs = await BusQuery.getWorkerRunHistory("sess-1");

    expect(runs).toEqual([
      { runId: "run-2", status: "running", eventCount: 1, startTime: 300, endTime: 350 },
      { runId: "run-1", status: "completed", eventCount: 3, startTime: 100, endTime: 200 },
    ]);
  });

  test("query functions return empty results for missing data", async () => {
    await expect(BusQuery.listErrors("sess-1")).resolves.toEqual([]);
    await expect(BusQuery.getWorkerRunHistory("sess-1")).resolves.toEqual([]);
  });
});
