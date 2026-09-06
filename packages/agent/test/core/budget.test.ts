import { describe, expect, it } from "bun:test";
import { Operational } from "@openomni/protocol";
import { Bus, collector } from "../../src/index";
import { captureBusEvents } from "../helpers/bus-event";
import {
  BUDGET_DEFAULTS,
  describeBudgetRemaining,
  createBudgetState,
  effectiveBudgetThresholds,
  publishBudgetTelemetry,
  recordTokenUsage,
} from "../../src/core/budget";

/** The run whose budget is being reported; the reporter never mints one. */
const TEST_RUN = { traceId: "trace-budget-test", sessionId: "session-budget-test" };

function countCollectedOperationalEmits(
  run: (events: ReturnType<typeof collector>) => void,
): number {
  const events = collector();
  run(events);
  return (
    events.named(Operational.Events.Warn.name).length +
    events.named(Operational.Events.Info.name).length
  );
}

async function countGlobalOperationalEmits(run: () => void): Promise<number> {
  const seen: unknown[] = [];
  const sentinel = {
    traceId: "trace-budget-test-barrier",
    time: 0,
    component: "agent.test",
    msg: "budget telemetry barrier",
  };
  let resolveBarrier: () => void = () => undefined;
  let barrierTimer: ReturnType<typeof setTimeout> | undefined;
  const barrier = new Promise<void>((resolve, reject) => {
    resolveBarrier = resolve;
    barrierTimer = setTimeout(() => reject(new Error("timed out waiting for Bus barrier")), 1_000);
  });
  const unsubWarn = Bus.subscribe(Operational.Events.Warn, (event) => seen.push(event));
  const unsubInfo = Bus.subscribe(Operational.Events.Info, (event) => {
    if (event === sentinel) resolveBarrier();
    else seen.push(event);
  });

  try {
    run();
    // Bus handlers are FIFO microtasks. Observing this subscribed sentinel
    // proves every operational event published by run() has been delivered.
    Bus.publish(Operational.Events.Info, sentinel);
    await barrier;
    return seen.length;
  } finally {
    if (barrierTimer !== undefined) clearTimeout(barrierTimer);
    unsubWarn();
    unsubInfo();
  }
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

describe("budget telemetry 4-state", () => {
  it("returns ok when below reassurance threshold", () => {
    const s = { ...createBudgetState(), turns: 12 };
    expect(publishBudgetTelemetry(s, TEST_RUN, collector(), { maxTurns: 24 })).toBe("ok");
  });

  it("returns reassurance when between reassurance and warning thresholds", () => {
    const s = { ...createBudgetState(), turns: 15 };
    expect(publishBudgetTelemetry(s, TEST_RUN, collector(), { maxTurns: 24 })).toBe("reassurance");
  });

  it("returns warning when between warning and exceeded thresholds", () => {
    const s = { ...createBudgetState(), turns: 20 };
    expect(publishBudgetTelemetry(s, TEST_RUN, collector(), { maxTurns: 24 })).toBe("warning");
  });

  it("returns exceeded when at limit", () => {
    const s = { ...createBudgetState(), turns: 24 };
    expect(publishBudgetTelemetry(s, TEST_RUN, collector(), { maxTurns: 24 })).toBe("exceeded");
  });

  it("returns exceeded when tool runtime reaches its limit", () => {
    const s = { ...createBudgetState(), toolRuntimeMs: 500 };
    expect(
      publishBudgetTelemetry(s, TEST_RUN, collector(), {
        maxTurns: -1,
        maxToolCalls: -1,
        maxWallTimeMs: -1,
        maxToolRuntimeMs: 500,
      }),
    ).toBe("exceeded");
  });

  it("maxTurns -1 allows unlimited turns", () => {
    const s = { ...createBudgetState(), turns: 1000 };
    expect(publishBudgetTelemetry(s, TEST_RUN, collector(), { maxTurns: -1 })).toBe("ok");
  });

  it("maxTurns -1 with maxToolCalls limit uses only toolCalls ratio", () => {
    const s = { ...createBudgetState(), turns: 1000, toolCalls: 9 };
    expect(
      publishBudgetTelemetry(s, TEST_RUN, collector(), { maxTurns: -1, maxToolCalls: 10 }),
    ).toBe("warning");
  });

  it("all limits -1 always returns ok", () => {
    const s = { ...createBudgetState(), turns: 1000, toolCalls: 1000, toolRuntimeMs: 1000000 };
    expect(
      publishBudgetTelemetry(s, TEST_RUN, collector(), {
        maxTurns: -1,
        maxToolCalls: -1,
        maxWallTimeMs: -1,
        maxToolRuntimeMs: -1,
      }),
    ).toBe("ok");
  });

  it("backward compat: undefined budget uses defaults", () => {
    expect(publishBudgetTelemetry(createBudgetState(), TEST_RUN, collector())).toBe("ok");
  });

  it("custom thresholds override defaults", () => {
    const s = { ...createBudgetState(), turns: 18 };
    expect(
      publishBudgetTelemetry(s, TEST_RUN, collector(), {
        maxTurns: 24,
        warningThreshold: 0.9,
        reassuranceThreshold: 0.7,
      }),
    ).toBe("reassurance");
  });
});

describe("budget telemetry does not publish outside its supplied sink", () => {
  it("emits no telemetry even called twice at the warning threshold", async () => {
    const s = { ...createBudgetState(), turns: 20 };
    const emits = await countGlobalOperationalEmits(() => {
      publishBudgetTelemetry(s, TEST_RUN, collector(), { maxTurns: 24 });
      publishBudgetTelemetry(s, TEST_RUN, collector(), { maxTurns: 24 });
    });
    expect(emits).toBe(0);
  });

  it("emits no telemetry at the exceeded threshold", async () => {
    const s = { ...createBudgetState(), turns: 24 };
    const emits = await countGlobalOperationalEmits(() => {
      publishBudgetTelemetry(s, TEST_RUN, collector(), { maxTurns: 24 });
    });
    expect(emits).toBe(0);
  });
});

describe("publishBudgetTelemetry is the command (emits once, returns status)", () => {
  /** Budget reporting files every non-ok state under the run that caused it. */
  it.each([
    { name: "warning", turns: 20, event: Operational.Events.Warn, status: "warning" },
    { name: "reassurance", turns: 15, event: Operational.Events.Info, status: "reassurance" },
    { name: "exceeded", turns: 30, event: Operational.Events.Warn, status: "exceeded" },
  ] as const)("files the $name event under the run's trace", async ({ turns, event, status }) => {
    const capture = captureBusEvents(event);
    try {
      expect(
        publishBudgetTelemetry({ ...createBudgetState(), turns }, TEST_RUN, Bus, { maxTurns: 24 }),
      ).toBe(status);
      const [seen] = await capture.done;
      expect(capture.events).toHaveLength(1);
      expect(seen).toMatchObject({ traceId: TEST_RUN.traceId, sessionId: TEST_RUN.sessionId });
    } finally {
      capture.unsubscribe();
    }
  });

  it("emits exactly one event per call at the warning threshold", async () => {
    const s = { ...createBudgetState(), turns: 20 };
    let status: string | undefined;
    const emits = countCollectedOperationalEmits((events) => {
      status = publishBudgetTelemetry(s, TEST_RUN, events, { maxTurns: 24 });
    });
    expect(status).toBe("warning");
    expect(emits).toBe(1);
  });

  it("emits nothing below the reassurance threshold", async () => {
    const s = { ...createBudgetState(), turns: 5 };
    let status: string | undefined;
    const emits = countCollectedOperationalEmits((events) => {
      status = publishBudgetTelemetry(s, TEST_RUN, events, { maxTurns: 24 });
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

describe("defaults are written once — narration agrees with enforcement", () => {
  // The 24/40/5min/2min defaults used to be duplicated between
  // evaluateBudget and describeBudgetRemaining; a change to one side made
  // the narration contradict the verdict. Both sites now read
  // BUDGET_DEFAULTS, and this pin drives each pair from the shared constant:
  // reintroduce a drifting literal on either side and the pair splits.
  it("at the default turn ceiling: enforcement says exceeded, narration says 0 remaining", () => {
    const s = { ...createBudgetState(), turns: BUDGET_DEFAULTS.maxTurns };
    expect(publishBudgetTelemetry(s, TEST_RUN, collector())).toBe("exceeded");
    expect(describeBudgetRemaining(s)).toContain("0 turns remaining");

    const oneBelow = { ...createBudgetState(), turns: BUDGET_DEFAULTS.maxTurns - 1 };
    expect(publishBudgetTelemetry(oneBelow, TEST_RUN, collector())).not.toBe("exceeded");
    expect(describeBudgetRemaining(oneBelow)).toContain("1 turn remaining");
  });

  it("at the default tool-call ceiling: enforcement says exceeded, narration says 0 remaining", () => {
    const s = { ...createBudgetState(), toolCalls: BUDGET_DEFAULTS.maxToolCalls };
    expect(publishBudgetTelemetry(s, TEST_RUN, collector())).toBe("exceeded");
    expect(describeBudgetRemaining(s)).toContain("0 tool calls remaining");

    const oneBelow = { ...createBudgetState(), toolCalls: BUDGET_DEFAULTS.maxToolCalls - 1 };
    expect(publishBudgetTelemetry(oneBelow, TEST_RUN, collector())).not.toBe("exceeded");
    expect(describeBudgetRemaining(oneBelow)).toContain("1 tool call remaining");
  });

  it("the default wall-time ceilings narrate from the same constants", () => {
    const s = createBudgetState();
    const desc = describeBudgetRemaining(s);
    expect(desc).toContain(`${Math.round(BUDGET_DEFAULTS.maxWallTimeMs / 1000)}s wall time`);
    expect(desc).toContain(
      `${Math.round(BUDGET_DEFAULTS.maxToolRuntimeMs / 1000)}s tool wall time`,
    );
  });
});

describe("BudgetState token tracking", () => {
  it("starts with zero token counts", () => {
    const state = createBudgetState();
    expect(state.totalInputTokens).toBe(0);
    expect(state.totalOutputTokens).toBe(0);
  });

  it("recordTokenUsage accumulates tokens", () => {
    let state = createBudgetState();
    state = recordTokenUsage(state, 100, 50);
    state = recordTokenUsage(state, 200, 100);
    expect(state.totalInputTokens).toBe(300);
    expect(state.totalOutputTokens).toBe(150);
  });
});
