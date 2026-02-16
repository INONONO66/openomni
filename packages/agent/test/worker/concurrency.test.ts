import { describe, it, expect, beforeEach } from "bun:test";
import { ConcurrencyGate, ConcurrencyConfig } from "../../src/worker/policy";

describe("ConcurrencyGate", () => {
  beforeEach(() => {
    ConcurrencyGate.resetStats();
  });

  it("check returns 'allow' when under maxRunning limit", () => {
    const config: ConcurrencyConfig = { maxRunning: 5, mode: "queue" };
    const result = ConcurrencyGate.check("task-1", 2, config);
    expect(result).toBe("allow");
  });

  it("check returns 'queue' when at limit in queue mode", () => {
    const config: ConcurrencyConfig = { maxRunning: 3, mode: "queue" };
    const result = ConcurrencyGate.check("task-1", 3, config);
    expect(result).toBe("queue");
  });

  it("check returns 'drop' when at limit in drop mode", () => {
    const config: ConcurrencyConfig = { maxRunning: 3, mode: "drop" };
    const result = ConcurrencyGate.check("task-1", 3, config);
    expect(result).toBe("drop");
  });

  it("record updates statistics correctly", () => {
    ConcurrencyGate.record("task-1", "allow");
    ConcurrencyGate.record("task-2", "queue");
    ConcurrencyGate.record("task-3", "drop");
    ConcurrencyGate.record("task-4", "allow");

    const status = ConcurrencyGate.getStatus();
    expect(status.allowed).toBe(2);
    expect(status.queued).toBe(1);
    expect(status.dropped).toBe(1);
  });

  it("getStatus returns correct counts", () => {
    ConcurrencyGate.record("task-1", "allow");
    ConcurrencyGate.record("task-2", "allow");
    ConcurrencyGate.record("task-3", "queue");

    const status = ConcurrencyGate.getStatus();
    expect(status).toEqual({
      allowed: 2,
      queued: 1,
      dropped: 0,
    });
  });

  it("check respects maxRunning limit across multiple calls", () => {
    const config: ConcurrencyConfig = { maxRunning: 2, mode: "queue" };

    const result1 = ConcurrencyGate.check("task-1", 0, config);
    const result2 = ConcurrencyGate.check("task-2", 1, config);
    const result3 = ConcurrencyGate.check("task-3", 2, config);
    const result4 = ConcurrencyGate.check("task-4", 2, config);

    expect(result1).toBe("allow");
    expect(result2).toBe("allow");
    expect(result3).toBe("queue");
    expect(result4).toBe("queue");
  });
});
