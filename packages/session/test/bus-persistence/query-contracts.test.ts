import { describe, expect, test } from "bun:test";
import { BusQuery } from "../../src/bus-persistence/query.js";

describe("BusQuery public contracts", () => {
  test("exposes public schema contracts", () => {
    expect(BusQuery.QueryOptions.parse({ limit: 1 })).toEqual({ limit: 1 });
    expect(BusQuery.ChainIntegrityResult.parse({ valid: true, totalVerified: 0 })).toEqual({
      valid: true,
      totalVerified: 0,
    });
    expect(
      BusQuery.AuditChainRecord.parse({
        seq: 1,
        sessionId: "sess-1",
        eventType: "agent.execution.started",
        eventHash: "hash",
        prevHash: "prev",
        timeCreated: 100,
      }),
    ).toEqual({
      seq: 1,
      sessionId: "sess-1",
      eventType: "agent.execution.started",
      eventHash: "hash",
      prevHash: "prev",
      timeCreated: 100,
    });
  });
});
