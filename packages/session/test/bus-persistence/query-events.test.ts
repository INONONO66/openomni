import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BusQuery } from "../../src/bus-persistence/query.js";
import { cleanupQueryStorage, insertEvent, resetQueryStorage } from "./query-fixture.js";

describe("BusQuery event queries", () => {
  beforeEach(resetQueryStorage);
  afterEach(cleanupQueryStorage);

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
      visibility: "internal",
      data: { ok: true },
      traceId: "trace-1",
      durationMs: 12,
      timeCreated: 100,
    });
  });

  test("listForLlmReasoning returns only model-visible audit events", async () => {
    insertEvent({
      sessionId: "sess-1",
      type: "operational.warn",
      category: "operational",
      visibility: "internal",
      traceId: "trace-internal",
      timeCreated: 100,
    });
    insertEvent({
      sessionId: "sess-1",
      type: "llm.call.completed",
      category: "llm",
      visibility: "llm_reason",
      traceId: "trace-llm",
      timeCreated: 200,
    });
    insertEvent({
      sessionId: "sess-1",
      type: "ingress.received",
      category: "ingress",
      visibility: "user_audit",
      traceId: "trace-user",
      timeCreated: 300,
    });

    const events = await BusQuery.listForLlmReasoning("sess-1");

    expect(events.map((event) => event.traceId)).toEqual(["trace-user", "trace-llm"]);
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
});
