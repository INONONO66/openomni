import { describe, expect, test, vi } from "bun:test";
import { DelegationStore } from "@openomni/ledger";
import type { Delegation } from "@openomni/protocol";
import { createDelegationKernel } from "../src/delegation/kernel";
import { eventCollector, RESIDENT, useDelegationStore } from "./helpers/delegation";

useDelegationStore();

function channelRequest(operation: "ask" | "notify", deadline: number) {
  return {
    address: { kind: "actor" as const, actorId: "alice" },
    operation,
    payload: { text: "status?" },
    deadline,
  };
}

function openChannelRecord(overrides: Partial<Delegation.Record> = {}): Delegation.Record {
  return {
    delegationId: "d-mutation",
    operation: "ask",
    address: { kind: "actor", actorId: "alice" },
    transport: "channel",
    deadline: 100,
    waitId: "wait-mutation",
    rootDelegationId: "d-mutation",
    origin: RESIDENT,
    instruction: "status?",
    status: "open",
    createdAt: 0,
    ...overrides,
  };
}

describe("delegation kernel mutation invariants", () => {
  test("control methods reject unknown durable identities", async () => {
    const kernel = createDelegationKernel({
      drivers: {},
      now: () => 1,
      newDelegationId: () => "unused",
      wake: () => undefined,
      bootSweep: false,
    });
    await expect(kernel.awaitDelegation("missing")).rejects.toBeDefined();
    await expect(kernel.cancelDelegation("missing")).rejects.toBeDefined();
    kernel.stop();
  });

  test("assign refuses when no WorkItem linkage is installed", async () => {
    const kernel = createDelegationKernel({
      drivers: {},
      now: () => 1,
      newDelegationId: () => "d-no-work-items",
      wake: () => undefined,
      bootSweep: false,
    });
    const result = await kernel.delegate(
      {
        address: { kind: "core", scope: "independent" },
        operation: "assign",
        payload: { text: "work" },
        acceptanceCriteria: ["done"],
        deadline: 100,
      },
      RESIDENT,
    );
    expect(result).toHaveProperty("refused");
    kernel.stop();
  });

  test("transport preparation reports synchronous and asynchronous failures", async () => {
    for (const prepare of [
      () => {
        throw new Error("sync");
      },
      () => Promise.reject(new Error("async")),
    ]) {
      const kernel = createDelegationKernel({
        drivers: { channel: { prepare, run: () => Promise.resolve({ status: "sent" }) } },
        now: () => 1,
        newDelegationId: () => crypto.randomUUID(),
        wake: () => undefined,
        bootSweep: false,
      });
      const result = await kernel.delegate(channelRequest("ask", 100), RESIDENT);
      expect(result).toHaveProperty("refused");
      kernel.stop();
    }
  });

  test("synchronous WorkItem commissioning failures are admission refusals", async () => {
    const kernel = createDelegationKernel({
      drivers: {},
      now: () => 1,
      newDelegationId: () => "d-work-item-throw",
      wake: () => undefined,
      bootSweep: false,
      workItems: {
        openAssign: (() => {
          throw new Error("commission failed");
        }) as never,
        cancelAssign: () => Promise.resolve(),
        closeAttempt: () => Promise.resolve(),
        recoverAttempts: () => Promise.resolve(),
      },
    });
    const result = await kernel.delegate(
      {
        address: { kind: "core", scope: "independent" },
        operation: "assign",
        payload: { text: "work" },
        acceptanceCriteria: ["done"],
        deadline: 100,
      },
      RESIDENT,
    );
    expect(result).toHaveProperty("refused");
    kernel.stop();
  });

  test("publishes WorkItem recovery and closure failures as operational events", async () => {
    const recoveryEvents = eventCollector();
    const recovering = createDelegationKernel({
      drivers: {},
      now: () => 1,
      newDelegationId: () => "unused",
      wake: () => undefined,
      events: recoveryEvents,
      workItems: {
        openAssign: () => Promise.resolve("wi"),
        cancelAssign: () => Promise.resolve(),
        closeAttempt: () => Promise.resolve(),
        recoverAttempts: () => Promise.reject(new Error("recovery failed")),
      },
    });
    await recoveryEvents.waitFor("operational.error");
    recovering.stop();

    const closeEvents = eventCollector();
    const closing = createDelegationKernel({
      drivers: { process: { run: () => Promise.resolve({ status: "completed", output: "done" }) } },
      now: () => 1,
      newDelegationId: () => "d-close-error",
      wake: () => undefined,
      events: closeEvents,
      bootSweep: false,
      workItems: {
        openAssign: () => Promise.resolve("wi-close"),
        cancelAssign: () => Promise.resolve(),
        closeAttempt: () => Promise.reject("close failed"),
        recoverAttempts: () => Promise.resolve(),
      },
    });
    const result = await closing.delegate(
      {
        address: { kind: "core", scope: "independent" },
        operation: "assign",
        payload: { text: "work" },
        acceptanceCriteria: ["done"],
        deadline: 100,
      },
      RESIDENT,
    );
    if ("refused" in result) throw result.error;
    await closing.awaitDelegation(result.handle.delegationId);
    await closeEvents.waitFor("operational.error");
    closing.stop();
  });

  test("reports a wake bookkeeping failure", () => {
    const events = eventCollector();
    const open = openChannelRecord({ delegationId: "d-mark-woken" });
    const settled: Delegation.Record = {
      ...open,
      status: "settled",
      settledAt: 2,
      settled: { status: "completed", delegationId: open.delegationId, output: "done", at: 2 },
    };
    createDelegationKernel({
      drivers: {},
      now: () => 2,
      newDelegationId: () => "unused",
      wake: () => undefined,
      events,
      store: {
        claimOpenWithinRoot: DelegationStore.claimOpenWithinRoot,
        get: () => settled,
        settleOnce: DelegationStore.settleOnce,
        listOpen: () => [],
        listSettledUnwoken: () => [settled],
        markWoken: () => {
          throw new Error("write failed");
        },
        countOpenByRoot: () => 0,
        findByWaitId: () => undefined,
      },
    });
    expect(events.events.some(({ name }) => name === "operational.error")).toBe(true);
  });

  test("reports a synchronous wake failure", async () => {
    const events = eventCollector();
    const kernel = createDelegationKernel({
      drivers: { channel: { run: () => Promise.resolve({ status: "sent" }) } },
      now: () => 1,
      newDelegationId: () => "d-sync-wake-error",
      wake: () => {
        throw new Error("wake failed");
      },
      events,
      bootSweep: false,
    });
    await kernel.delegate(channelRequest("notify", 100), RESIDENT);
    expect(events.events.some(({ name }) => name === "operational.error")).toBe(true);
    kernel.stop();
  });

  test("an already-expired open record settles during an immediate await", async () => {
    DelegationStore.create(openChannelRecord({ delegationId: "d-expired-await" }));
    const kernel = createDelegationKernel({
      drivers: {},
      now: () => 100,
      newDelegationId: () => "unused",
      wake: () => undefined,
      bootSweep: false,
    });
    const result = await kernel.awaitDelegation("d-expired-await", 0);
    expect(result).toMatchObject({ kind: "settled", settlement: { status: "no_response" } });
    kernel.stop();
  });

  test("an explicit zero-length await times out before the durable deadline", async () => {
    DelegationStore.create(openChannelRecord({ delegationId: "d-zero-await", deadline: 100 }));
    const kernel = createDelegationKernel({
      drivers: {},
      now: () => 1,
      newDelegationId: () => "unused",
      wake: () => undefined,
      bootSweep: false,
    });
    expect(await kernel.awaitDelegation("d-zero-await", 0)).toMatchObject({ kind: "timeout" });
    kernel.stop();
  });

  test("closes the await registration race from a just-settled reread", async () => {
    const open = openChannelRecord({ delegationId: "d-raced-await" });
    const settled: Delegation.Record = {
      ...open,
      status: "settled",
      settledAt: 2,
      settled: { status: "completed", delegationId: open.delegationId, output: "done", at: 2 },
    };
    let reads = 0;
    const store = {
      claimOpenWithinRoot: DelegationStore.claimOpenWithinRoot,
      get: () => (reads++ === 0 ? open : settled),
      settleOnce: DelegationStore.settleOnce,
      listOpen: () => [],
      listSettledUnwoken: () => [],
      markWoken: () => true,
      countOpenByRoot: () => 0,
      findByWaitId: () => undefined,
    };
    const kernel = createDelegationKernel({
      drivers: {},
      now: () => 1,
      newDelegationId: () => "unused",
      wake: () => undefined,
      bootSweep: false,
      store,
    });
    expect(await kernel.awaitDelegation(open.delegationId, 10)).toMatchObject({ kind: "settled" });
    kernel.stop();
  });

  test("an await reports timeout when another owner removes the row before deadline settlement", async () => {
    vi.useFakeTimers();
    let now = 0;
    const open = openChannelRecord({ delegationId: "d-lost-await" });
    const store = {
      claimOpenWithinRoot: DelegationStore.claimOpenWithinRoot,
      get: () => open,
      settleOnce: () => ({ committed: false as const }),
      listOpen: () => [],
      listSettledUnwoken: () => [],
      markWoken: () => true,
      countOpenByRoot: () => 0,
      findByWaitId: () => undefined,
    };
    const kernel = createDelegationKernel({
      drivers: {},
      now: () => now,
      newDelegationId: () => "unused",
      wake: () => undefined,
      bootSweep: false,
      store,
    });
    try {
      const waiting = kernel.awaitDelegation(open.delegationId);
      now = open.deadline;
      vi.advanceTimersByTime(open.deadline);
      expect(await waiting).toMatchObject({ kind: "timeout" });
    } finally {
      kernel.stop();
      vi.useRealTimers();
    }
  });

  test("publishes delivery at most once when a driver repeats its acceptance report", async () => {
    const events = eventCollector();
    const kernel = createDelegationKernel({
      drivers: {
        inline: {
          run: async (_admitted, _handle, _signal, report) => {
            report?.delivered();
            report?.delivered();
            return { status: "completed", output: "done" };
          },
        },
      },
      now: () => 1,
      newDelegationId: () => "d-delivered-once",
      wake: () => undefined,
      events,
    });

    await kernel.delegate(
      {
        address: { kind: "core", scope: "inline" },
        operation: "ask",
        payload: { text: "run" },
        deadline: 100,
      },
      RESIDENT,
    );

    expect(events.events.filter(({ name }) => name === "delegation.delivered")).toHaveLength(1);
    kernel.stop();
  });

  test("does not let an inbound reply settle a notify delegation", () => {
    DelegationStore.create(
      openChannelRecord({ delegationId: "d-notify-reply", operation: "notify" }),
    );
    const kernel = createDelegationKernel({
      drivers: {},
      now: () => 1,
      newDelegationId: () => "unused",
      wake: () => undefined,
      bootSweep: false,
    });

    expect(kernel.settleFromReply("wait-mutation", "unsolicited reply")).toBe(false);
    expect(DelegationStore.get("d-notify-reply")?.status).toBe("open");
    kernel.stop();
  });

  test("bounds an explicit await timeout by the durable delegation deadline", async () => {
    vi.useFakeTimers();
    let now = 0;
    let kernel: ReturnType<typeof createDelegationKernel> | undefined;
    try {
      DelegationStore.create(openChannelRecord({ delegationId: "d-await-bound" }));
      kernel = createDelegationKernel({
        drivers: {},
        now: () => now,
        newDelegationId: () => "unused",
        wake: () => undefined,
        bootSweep: false,
      });
      let result: unknown;
      const waiting = kernel.awaitDelegation("d-await-bound", 1_000).then((value) => {
        result = value;
        return value;
      });
      void waiting.catch(() => undefined);

      now = 100;
      vi.advanceTimersByTime(100);
      await Promise.resolve();

      expect(result).toMatchObject({
        kind: "settled",
        settlement: { status: "no_response", deadline: 100, at: 100 },
      });
      expect(DelegationStore.get("d-await-bound")?.status).toBe("settled");
      await waiting;
    } finally {
      kernel?.stop();
      vi.useRealTimers();
    }
  });

  test("arms far-future deadlines within the runtime timer ceiling", async () => {
    const timerCap = 2_147_000_000;
    vi.useFakeTimers();
    let now = 0;
    let kernel: ReturnType<typeof createDelegationKernel> | undefined;
    try {
      kernel = createDelegationKernel({
        drivers: { process: { run: () => new Promise(() => undefined) } },
        now: () => now,
        newDelegationId: () => "d-timer-ceiling",
        wake: () => undefined,
        bootSweep: false,
      });
      await kernel.delegate(
        {
          address: { kind: "core", scope: "independent" },
          operation: "ask",
          payload: { text: "far future" },
          deadline: timerCap + 1_000,
        },
        RESIDENT,
      );

      now = timerCap + 1_000;
      vi.advanceTimersByTime(timerCap);
      await Promise.resolve();

      expect(DelegationStore.get("d-timer-ceiling")?.settled).toMatchObject({
        status: "no_response",
        deadline: timerCap + 1_000,
      });
    } finally {
      kernel?.stop();
      vi.useRealTimers();
    }
  });

  test("recovery cannot orphan a second deadline timer that survives kernel stop", async () => {
    vi.useFakeTimers();
    let now = 0;
    let kernel: ReturnType<typeof createDelegationKernel> | undefined;
    try {
      kernel = createDelegationKernel({
        drivers: {
          channel: {
            prepare: () => ({ waitId: "wait-double-arm" }),
            run: () => new Promise(() => undefined),
          },
        },
        now: () => now,
        newDelegationId: () => "d-double-arm",
        wake: () => undefined,
        bootSweep: false,
      });
      await kernel.delegate(channelRequest("ask", 100), RESIDENT);

      kernel.start();
      kernel.stop();
      now = 100;
      vi.advanceTimersByTime(100);
      await Promise.resolve();

      expect(DelegationStore.get("d-double-arm")?.status).toBe("open");
    } finally {
      kernel?.stop();
      vi.useRealTimers();
    }
  });

  test("deadline settlement remains schema-valid when the store refreshes its deadline", async () => {
    vi.useFakeTimers();
    let now = 0;
    let injectRefreshedDeadline = false;
    let kernel: ReturnType<typeof createDelegationKernel> | undefined;
    const store = {
      claimOpenWithinRoot: DelegationStore.claimOpenWithinRoot,
      get(delegationId: string): Delegation.Record | undefined {
        const record = DelegationStore.get(delegationId);
        if (!injectRefreshedDeadline || record === undefined) return record;
        injectRefreshedDeadline = false;
        let reads = 0;
        return {
          ...record,
          get deadline() {
            reads += 1;
            return reads === 1 ? 100 : 200;
          },
        };
      },
      settleOnce: DelegationStore.settleOnce,
      listOpen: DelegationStore.listOpen,
      listSettledUnwoken: DelegationStore.listSettledUnwoken,
      markWoken: DelegationStore.markWoken,
      countOpenByRoot: DelegationStore.countOpenByRoot,
      findByWaitId: DelegationStore.findByWaitId,
    };
    try {
      kernel = createDelegationKernel({
        drivers: { process: { run: () => new Promise(() => undefined) } },
        now: () => now,
        newDelegationId: () => "d-refreshed-deadline",
        wake: () => undefined,
        bootSweep: false,
        store,
      });
      await kernel.delegate(
        {
          address: { kind: "core", scope: "independent" },
          operation: "ask",
          payload: { text: "long task" },
          deadline: 100,
        },
        RESIDENT,
      );

      injectRefreshedDeadline = true;
      now = 100;
      vi.advanceTimersByTime(100);
      await Promise.resolve();

      expect(DelegationStore.get("d-refreshed-deadline")?.settled).toMatchObject({
        status: "no_response",
        deadline: 200,
        at: 200,
      });
    } finally {
      kernel?.stop();
      vi.useRealTimers();
    }
  });
});
