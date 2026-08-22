import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BusQuery } from "../../src/bus-persistence/query.js";
import { cleanupQueryStorage, insertEvent, resetQueryStorage } from "./query-fixture.js";

describe("BusQuery event queries", () => {
  beforeEach(resetQueryStorage);
  afterEach(cleanupQueryStorage);

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
      payloadStatus: "invalid",
      payloadDiagnostic: "schema validation failed",
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
    expect(events.map((event) => event.payloadStatus)).toEqual(["invalid", "unmarked"]);
    expect(events[0]?.payloadDiagnostic).toBe("schema validation failed");
    expect(events[1]?.payloadDiagnostic).toBeUndefined();
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

describe("BusQuery public contracts", () => {
  test("exposes public schema contracts", () => {
    expect(BusQuery.ChainIntegrityResult.parse({ valid: true, totalVerified: 0 })).toEqual({
      valid: true,
      totalVerified: 0,
    });
  });
});
