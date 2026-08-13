import { describe, expect, it } from "bun:test";
import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import {
  checkBudget,
  describeBudgetRemaining,
  createBudgetState,
  effectiveBudgetThresholds,
  publishBudgetTelemetry,
} from "../../src/core/budget";

/** The run whose budget is being reported; the reporter never mints one. */
const TEST_RUN = { traceId: "trace-budget-test", sessionId: "session-budget-test" };

async function countOperationalEmits(run: () => void): Promise<number> {
  Bus.reset();
  let count = 0;
  const unsubWarn = Bus.subscribe(Operational.Warn, () => {
    count += 1;
  });
  const unsubInfo = Bus.subscribe(Operational.Info, () => {
    count += 1;
  });
  run();
  // Bus delivers on a microtask; a macrotask turn flushes all pending handlers.
  await new Promise((resolve) => setTimeout(resolve, 0));
  unsubWarn();
  unsubInfo();
  return count;
}

describe("effectiveBudgetThresholds", () => {
  it("uses protocol-owned defaults and runtime-local resolution", () => {
    expect(effectiveBudgetThresholds()).toEqual({
      reassuranceThreshold: 0.6,
      warningThreshold: 0.8,
    });
    expect(effectiveBudgetThresholds({ warningThreshold: 0.9 })).toEqual({
      reassuranceThreshold: 0.6,
      warningThreshold: 0.9,
    });
  });
});

describe("checkBudget 4-state", () => {
  it("returns ok when below reassurance threshold", () => {
    const s = { ...createBudgetState(), turns: 12 };
    expect(checkBudget(s, { maxTurns: 24 })).toBe("ok");
  });

  it("returns reassurance when between reassurance and warning thresholds", () => {
    const s = { ...createBudgetState(), turns: 15 };
    expect(checkBudget(s, { maxTurns: 24 })).toBe("reassurance");
  });

  it("returns warning when between warning and exceeded thresholds", () => {
    const s = { ...createBudgetState(), turns: 20 };
    expect(checkBudget(s, { maxTurns: 24 })).toBe("warning");
  });

  it("returns exceeded when at limit", () => {
    const s = { ...createBudgetState(), turns: 24 };
    expect(checkBudget(s, { maxTurns: 24 })).toBe("exceeded");
  });

  it("maxTurns -1 allows unlimited turns", () => {
    const s = { ...createBudgetState(), turns: 1000 };
    expect(checkBudget(s, { maxTurns: -1 })).toBe("ok");
  });

  it("maxTurns -1 with maxToolCalls limit uses only toolCalls ratio", () => {
    const s = { ...createBudgetState(), turns: 1000, toolCalls: 9 };
    expect(checkBudget(s, { maxTurns: -1, maxToolCalls: 10 })).toBe("warning");
  });

  it("all limits -1 always returns ok", () => {
    const s = { ...createBudgetState(), turns: 1000, toolCalls: 1000, toolRuntimeMs: 1000000 };
    expect(
      checkBudget(s, {
        maxTurns: -1,
        maxToolCalls: -1,
        maxWallTimeMs: -1,
        maxToolRuntimeMs: -1,
      }),
    ).toBe("ok");
  });

  it("backward compat: undefined budget uses defaults", () => {
    expect(checkBudget(createBudgetState())).toBe("ok");
  });

  it("custom thresholds override defaults", () => {
    const s = { ...createBudgetState(), turns: 18 };
    expect(checkBudget(s, { maxTurns: 24, warningThreshold: 0.9, reassuranceThreshold: 0.7 })).toBe(
      "reassurance",
    );
  });
});

describe("checkBudget is a pure query (query/command split)", () => {
  it("emits no telemetry even called twice at the warning threshold", async () => {
    const s = { ...createBudgetState(), turns: 20 };
    const emits = await countOperationalEmits(() => {
      checkBudget(s, { maxTurns: 24 });
      checkBudget(s, { maxTurns: 24 });
    });
    expect(emits).toBe(0);
  });

  it("emits no telemetry at the exceeded threshold", async () => {
    const s = { ...createBudgetState(), turns: 24 };
    const emits = await countOperationalEmits(() => {
      checkBudget(s, { maxTurns: 24 });
    });
    expect(emits).toBe(0);
  });
});

describe("publishBudgetTelemetry is the command (emits once, returns status)", () => {
  /**
   * Budget reporting is not a trace origin: it happens because a run is
   * running. Re-minting here left the whole suite green until this existed.
   */
  it("files the budget event under the run's trace", async () => {
    const seen: Array<{ traceId: string; sessionId?: string }> = [];
    const unsubscribe = Bus.subscribe(Operational.Warn, (event) => {
      seen.push(event as unknown as { traceId: string; sessionId?: string });
    });

    try {
      publishBudgetTelemetry({ ...createBudgetState(), turns: 20 }, TEST_RUN, { maxTurns: 24 });
      await Bun.sleep(0);
    } finally {
      unsubscribe();
    }

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ traceId: TEST_RUN.traceId, sessionId: TEST_RUN.sessionId });
  });

  /** The branch `dispatchBudgetCheck` acts on to end the run. */
  it("files the exceeded event under the run's trace", async () => {
    const seen: Array<{ traceId: string; sessionId?: string }> = [];
    const unsubscribe = Bus.subscribe(Operational.Warn, (event) => {
      seen.push(event as unknown as { traceId: string; sessionId?: string });
    });

    try {
      const status = publishBudgetTelemetry({ ...createBudgetState(), turns: 30 }, TEST_RUN, {
        maxTurns: 24,
      });
      expect(status).toBe("exceeded");
      await Bun.sleep(0);
    } finally {
      unsubscribe();
    }

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ traceId: TEST_RUN.traceId, sessionId: TEST_RUN.sessionId });
  });

  it("emits exactly one event per call at the warning threshold", async () => {
    const s = { ...createBudgetState(), turns: 20 };
    let status: string | undefined;
    const emits = await countOperationalEmits(() => {
      status = publishBudgetTelemetry(s, TEST_RUN, { maxTurns: 24 });
    });
    expect(status).toBe("warning");
    expect(emits).toBe(1);
  });

  it("emits nothing below the reassurance threshold", async () => {
    const s = { ...createBudgetState(), turns: 5 };
    let status: string | undefined;
    const emits = await countOperationalEmits(() => {
      status = publishBudgetTelemetry(s, TEST_RUN, { maxTurns: 24 });
    });
    expect(status).toBe("ok");
    expect(emits).toBe(0);
  });
});

describe("describeBudgetRemaining", () => {
  it("includes turns remaining", () => {
    const s = { ...createBudgetState(), turns: 5 };
    const desc = describeBudgetRemaining(s, { maxTurns: 24 });
    expect(desc).toContain("19 turns remaining");
  });

  it("displays unlimited when maxTurns is -1", () => {
    const s = { ...createBudgetState(), turns: 5 };
    const desc = describeBudgetRemaining(s, { maxTurns: -1 });
    expect(desc).toContain("unlimited turns remaining");
  });

  it("singular turn when 1 remaining", () => {
    const s = { ...createBudgetState(), turns: 23 };
    const desc = describeBudgetRemaining(s, { maxTurns: 24 });
    expect(desc).toContain("1 turn remaining");
    expect(desc).not.toContain("turns");
  });
});
