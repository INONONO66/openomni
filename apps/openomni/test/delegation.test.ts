import { describe, expect, test, vi } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DelegationStore, SqliteStorageAdapter, Storage } from "@openomni/ledger";
import { admit, type AdmissionLimits } from "../src/delegation/admission";
import { createChannelDriver } from "../src/delegation/channel-driver";
import { createDelegationKernel } from "../src/delegation/kernel";
import {
  AWAIT_DELEGATION_TOOL_NAME,
  CANCEL_DELEGATION_TOOL_NAME,
  DELEGATE_TOOL_NAME,
  delegateToolExecutor,
  delegateToolSpec,
} from "../src/delegation/tool";
import {
  awaitedReceipt,
  eventCollector,
  RESIDENT,
  useDelegationStore,
  WORKER,
} from "./helpers/delegation";

useDelegationStore();

const LIMITS: AdmissionLimits = { maxInlineDepth: 2, maxFanout: 8 };

function ask(overrides: Record<string, unknown> = {}) {
  return {
    address: { kind: "core", scope: "inline" },
    operation: "ask",
    payload: { text: "what is the state of the build" },
    deadline: 10_000,
    ...overrides,
  };
}

describe("admission fold", () => {
  test("a worker may open only an inline child and the depth cap is typed", () => {
    expect(admit(ask(), WORKER, 1_000, LIMITS)).toMatchObject({ ok: true, transport: "inline" });
    expect(
      admit(
        ask({ address: { kind: "core", scope: "independent" } }),
        WORKER,
        1_000,
        LIMITS,
      ),
    ).toMatchObject({ ok: false, error: { data: { code: "worker_transport" } } });
    expect(admit(ask(), { ...WORKER, depth: 2 }, 1_000, LIMITS)).toMatchObject({
      ok: false,
      error: { data: { code: "inline_depth" } },
    });
  });

  test("the effective deadline is the minimum of request and durable parent", () => {
    const result = admit(
      ask({ deadline: 9_000 }),
      { ...WORKER, parentDelegationId: "parent", rootDelegationId: "root" },
      1_000,
      LIMITS,
      {
        delegationId: "child",
        rootDelegationId: "root",
        parent: {
          delegationId: "parent",
          rootDelegationId: "root",
          deadline: 4_000,
          status: "open",
        },
        openFanout: 1,
      },
    );
    expect(result).toMatchObject({
      ok: true,
      effectiveDeadline: 4_000,
      rootDelegationId: "root",
      childOrigin: { parentDelegationId: "child", rootDelegationId: "root" },
    });
  });

  test("the pure fold refuses a full durable root fanout", () => {
    const result = admit(ask(), RESIDENT, 1_000, LIMITS, {
      delegationId: "new",
      rootDelegationId: "root",
      openFanout: 8,
    });
    expect(result).toMatchObject({ ok: false, error: { data: { code: "fanout_cap" } } });
  });
});

describe("durable kernel", () => {
  test("records before dispatching and emits admitted, delivered, settled in fact order", async () => {
    const events = eventCollector();
    let sawRecord = false;
    const kernel = createDelegationKernel({
      drivers: {
        inline: {
          run: async (_admitted, handle, _signal, report) => {
            sawRecord = DelegationStore.get(handle.delegationId)?.status === "open";
            report?.delivered();
            return { status: "completed", output: "done" };
          },
        },
      },
      now: () => 1_000,
      newDelegationId: () => "d-1",
      wake: () => undefined,
      events,
      limits: LIMITS,
    });

    const result = await kernel.delegate(ask(), RESIDENT);
    expect(sawRecord).toBe(true);
    expect(result).toMatchObject({
      handle: { delegationId: "d-1", deadline: 10_000, rootDelegationId: "d-1" },
      settled: { status: "completed", output: "done" },
    });
    expect(DelegationStore.get("d-1")?.status).toBe("settled");
    expect(events.events.map((event) => event.name)).toEqual([
      "delegation.admitted",
      "delegation.delivered",
      "delegation.settled",
    ]);
  });

  test("process/channel work returns the handle before its outcome and can be awaited again", async () => {
    const events = eventCollector();
    let finish!: (outcome: { status: "completed"; output: string }) => void;
    const kernel = createDelegationKernel({
      drivers: {
        process: {
          run: (_admitted, _handle, _signal, report) => {
            report?.delivered();
            return new Promise((resolve) => {
              finish = resolve as typeof finish;
            });
          },
        },
      },
      now: () => 1_000,
      newDelegationId: () => "d-process",
      wake: () => undefined,
      events,
      limits: LIMITS,
    });

    const started = await kernel.delegate(
      {
        address: { kind: "core", scope: "independent" },
        operation: "ask",
        payload: { text: "audit" },
        deadline: 10_000,
      },
      RESIDENT,
    );
    expect(started).toMatchObject({ handle: { transport: "process" } });
    if ("refused" in started || started.settled !== undefined) throw new Error("background work blocked the caller");

    const awaiting = kernel.awaitDelegation(started.handle.delegationId);
    finish({ status: "completed", output: "audited" });
    const settled = await awaiting;
    expect(settled).toEqual({ kind: "settled", settlement: expect.objectContaining({ status: "completed", output: "audited" }) });
    expect(events.events.map((event) => event.name)).toContain("delegation.settled");
  });

  test("cancel aborts local work and CAS-settles cancelled", async () => {
    const events = eventCollector();
    let aborted = false;
    const kernel = createDelegationKernel({
      drivers: {
        process: {
          run: (_admitted, _handle, signal) =>
            new Promise((resolve) => {
              signal.addEventListener("abort", () => {
                aborted = true;
                resolve({ status: "cancelled", reason: "stopped" });
              });
            }),
        },
      },
      now: () => 1_000,
      newDelegationId: () => "d-cancel",
      wake: () => undefined,
      events,
      limits: LIMITS,
    });
    const started = await kernel.delegate(
      {
        address: { kind: "core", scope: "independent" },
        operation: "ask",
        payload: { text: "long" },
        deadline: 10_000,
      },
      RESIDENT,
    );
    if ("refused" in started) throw new Error(started.refused);
    await expect(kernel.cancelDelegation(started.handle.delegationId)).resolves.toMatchObject({ status: "cancelled" });
    expect(aborted).toBe(true);
    await expect(kernel.cancelDelegation(started.handle.delegationId)).resolves.toMatchObject({ status: "cancelled" });
  });

  test("an inline caller returns the deadline settlement even if its driver ignores abort", async () => {
    const kernel = createDelegationKernel({
      drivers: { inline: { run: () => new Promise(() => undefined) } },
      now: () => Date.now(),
      newDelegationId: () => "d-uncooperative",
      wake: () => undefined,
      limits: LIMITS,
    });
    const result = await kernel.delegate(ask({ deadline: Date.now() + 25 }), RESIDENT);
    if ("refused" in result) throw new Error(result.refused);
    expect(result.settled).toMatchObject({ status: "no_response" });
    kernel.stop();
  });

  test("a forged root lineage is replaced by the admission-stamped root", async () => {
    const kernel = createDelegationKernel({
      drivers: { inline: { run: async () => ({ status: "completed", output: "ok" }) } },
      now: () => 1_000,
      newDelegationId: () => "d-stamped",
      wake: () => undefined,
      limits: LIMITS,
    });
    const result = await kernel.delegate(ask(), { ...RESIDENT, rootDelegationId: "forged-root" });
    if ("refused" in result) throw new Error(result.refused);
    expect(result.handle.rootDelegationId).toBe("d-stamped");
    expect(DelegationStore.get("d-stamped")?.origin).toEqual(RESIDENT);
  });

  test("a deadline timer settles no_response at the effective deadline", async () => {
    const events = eventCollector();
    const kernel = createDelegationKernel({
      drivers: {
        inline: {
          run: (_admitted, _handle, signal) =>
            new Promise((resolve) => signal.addEventListener("abort", () => resolve({ status: "cancelled", reason: "stopped" }))),
        },
      },
      now: () => Date.now(),
      newDelegationId: () => "d-deadline",
      wake: () => undefined,
      events,
      limits: LIMITS,
    });
    const result = await kernel.delegate(ask({ deadline: Date.now() + 25 }), RESIDENT);
    if ("refused" in result) throw new Error(result.refused);
    expect(result.settled?.status).toBe("no_response");
    expect(result.settled).toMatchObject({ deadline: expect.any(Number) });
  });

  test("deadline and await timers re-arm instead of settling at the timer cap", async () => {
    const timerCap = 2_147_000_000;
    vi.useFakeTimers();
    // Injected clock, not setSystemTime: bun ≤1.3.6 (the pinned CI toolchain)
    // does not advance the fake Date clock with advanceTimersByTime, so a
    // Date.now()-backed kernel sees real time and settles at the first fire.
    let now = 0;
    let wakes = 0;
    let kernel: ReturnType<typeof createDelegationKernel> | undefined;
    try {
      kernel = createDelegationKernel({
        drivers: { process: { run: () => new Promise(() => undefined) } },
        now: () => now,
        newDelegationId: () => "d-long-deadline",
        wake: () => {
          wakes += 1;
        },
        limits: LIMITS,
      });
      const started = await kernel.delegate(
        {
          address: { kind: "core", scope: "independent" },
          operation: "ask",
          payload: { text: "wait a long time" },
          deadline: timerCap + 1_000,
        },
        RESIDENT,
      );
      if ("refused" in started) throw new Error(started.refused);
      let awaited: unknown;
      const waiting = kernel.awaitDelegation(started.handle.delegationId).then((result) => {
        awaited = result;
        return result;
      });

      now = timerCap;
      vi.advanceTimersByTime(timerCap);
      await Promise.resolve();
      expect(DelegationStore.get(started.handle.delegationId)?.status).toBe("open");
      expect(awaited).toBeUndefined();
      expect(wakes).toBe(0);

      now = timerCap + 1_000;
      vi.advanceTimersByTime(1_000);
      await expect(waiting).resolves.toMatchObject({
        kind: "settled",
        settlement: { status: "no_response", deadline: timerCap + 1_000 },
      });
      expect(wakes).toBe(1);
    } finally {
      kernel?.stop();
      vi.useRealTimers();
    }
  });
});

describe("delegation controls and tool surface", () => {
  test("start advertises v2 operation and durable controls return immediately", async () => {
    const events = eventCollector();
    const kernel = createDelegationKernel({
      drivers: { process: { run: () => new Promise(() => undefined) } },
      now: () => 1_000,
      newDelegationId: () => "d-tool",
      wake: () => undefined,
      events,
      limits: LIMITS,
    });
    const spec = delegateToolSpec();
    expect(spec.name).toBe(DELEGATE_TOOL_NAME);
    expect((spec.inputSchema as { properties: Record<string, unknown> }).properties.operation).toBeDefined();
    const answer = await delegateToolExecutor(kernel, RESIDENT)({
      instruction: "send it",
      operation: "ask",
      scope: "independent",
      timeoutMs: 5_000,
    });
    expect(answer).toContain("settlement will arrive as a message");
    expect(answer).toContain("d-tool");
    expect(AWAIT_DELEGATION_TOOL_NAME).toBe("await_delegation");
    expect(CANCEL_DELEGATION_TOOL_NAME).toBe("cancel_delegation");
    kernel.stop();
  });

  test("SQLite restart sweep preserves channel correlation and interrupts volatile work", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openomni-delegation-restart-"));
    const dbPath = join(directory, "ledger.sqlite");
    let kernelA: ReturnType<typeof createDelegationKernel> | undefined;
    let kernelB: ReturnType<typeof createDelegationKernel> | undefined;
    try {
      Storage.reset();
      Storage.configure(new SqliteStorageAdapter(dbPath));
      kernelA = createDelegationKernel({
        store: DelegationStore,
        drivers: {
          channel: createChannelDriver({
            send: async (input) => awaitedReceipt(input),
            now: () => 2_000,
            newWaitId: () => "wait-restart",
          }),
        },
        now: () => 2_000,
        newDelegationId: () => "d-channel-restart",
        wake: () => undefined,
        limits: LIMITS,
      });
      const started = await kernelA.delegate(
        {
          address: { kind: "actor", actorId: "alice" },
          operation: "ask",
          payload: { text: "durable question" },
          deadline: 5_000,
        },
        RESIDENT,
      );
      if ("refused" in started) throw new Error(started.refused);
      expect(started.settled).toBeUndefined();
      expect(started.handle.waitId).toBe("wait-restart");
      kernelA.stop();

      DelegationStore.create({
        delegationId: "d-inline-restart",
        operation: "ask",
        address: { kind: "core", scope: "inline" },
        transport: "inline",
        deadline: 5_000,
        rootDelegationId: "d-inline-restart",
        origin: { ...RESIDENT, sessionId: "volatile-inline" },
        instruction: "volatile inline",
        status: "open",
        createdAt: 1_000,
      });
      DelegationStore.create({
        delegationId: "d-process-restart",
        operation: "ask",
        address: { kind: "core", scope: "independent" },
        transport: "process",
        deadline: 5_000,
        rootDelegationId: "d-process-restart",
        origin: { ...RESIDENT, sessionId: "volatile-process" },
        instruction: "volatile process",
        status: "open",
        createdAt: 1_000,
      });

      Storage.reset();
      Storage.configure(new SqliteStorageAdapter(dbPath));
      const events = eventCollector();
      const wakes: Array<{ delegationId: string; sessionId: string }> = [];
      kernelB = createDelegationKernel({
        store: DelegationStore,
        drivers: {},
        now: () => 2_000,
        newDelegationId: () => "unused-restart",
        events,
        wake: ({ record }) => {
          wakes.push({ delegationId: record.delegationId, sessionId: record.origin.sessionId });
        },
        bootSweep: false,
        limits: LIMITS,
      });
      kernelB.start();

      expect(DelegationStore.get("d-channel-restart")?.status).toBe("open");
      expect(DelegationStore.get("d-channel-restart")?.settled).toBeUndefined();
      expect(DelegationStore.get("d-inline-restart")?.settled).toMatchObject({ status: "interrupted" });
      expect(DelegationStore.get("d-process-restart")?.settled).toMatchObject({ status: "interrupted" });
      expect(wakes).toEqual([{ delegationId: "d-process-restart", sessionId: "volatile-process" }]);

      expect(kernelB.settleFromReply("wait-restart", "replied after restart")).toBe(true);
      expect(DelegationStore.get("d-channel-restart")?.settled).toMatchObject({
        status: "completed",
        output: "replied after restart",
      });
      expect(
        events.events.filter(
          (event) => event.name === "delegation.settled" && (event.data as { delegationId: string }).delegationId === "d-channel-restart",
        ),
      ).toHaveLength(1);
      expect(wakes.filter((wake) => wake.delegationId === "d-channel-restart")).toEqual([
        { delegationId: "d-channel-restart", sessionId: "session-origin" },
      ]);
      expect(wakes).toHaveLength(2);
    } finally {
      kernelB?.stop();
      kernelA?.stop();
      Storage.reset();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("restart re-delivers a settled non-inline wake until its receipt is recorded", () => {
    DelegationStore.create({
      delegationId: "d-unwoken",
      operation: "ask",
      address: { kind: "core", scope: "independent" },
      transport: "process",
      deadline: 5_000,
      rootDelegationId: "d-unwoken",
      origin: RESIDENT,
      instruction: "recover my wake",
      status: "open",
      createdAt: 1_000,
    });
    DelegationStore.settle("d-unwoken", {
      status: "completed",
      delegationId: "d-unwoken",
      output: "durable result",
      at: 1_500,
    });
    let wakeCount = 0;
    const kernel = createDelegationKernel({
      drivers: {},
      now: () => 2_000,
      newDelegationId: () => "unused-unwoken",
      wake: () => {
        wakeCount += 1;
      },
      bootSweep: false,
    });

    kernel.start();
    expect(wakeCount).toBe(1);
    expect(DelegationStore.get("d-unwoken")?.wokenAt).toBe(2_000);
    expect(DelegationStore.listSettledUnwoken()).toEqual([]);
    kernel.stop();

    const restarted = createDelegationKernel({
      drivers: {},
      now: () => 3_000,
      newDelegationId: () => "unused-restarted",
      wake: () => {
        wakeCount += 1;
      },
      bootSweep: false,
    });
    restarted.start();
    expect(wakeCount).toBe(1);
    restarted.stop();
  });

  test("publishes a typed operational error and leaves the wake retryable when delivery fails", async () => {
    const events = eventCollector();
    const kernel = createDelegationKernel({
      drivers: {
        process: { run: async () => ({ status: "completed", output: "done" }) },
      },
      now: () => 2_000,
      newDelegationId: () => "d-wake-failure",
      wake: () => Promise.reject(new Error("resident unavailable")),
      events,
      bootSweep: false,
    });
    const failed = events.waitFor("operational.error");
    await kernel.delegate(
      {
        address: { kind: "core", scope: "independent" },
        operation: "ask",
        payload: { text: "background" },
        deadline: 5_000,
      },
      RESIDENT,
    );

    await expect(failed).resolves.toMatchObject({
      traceId: "d-wake-failure",
      component: "delegation",
      msg: "delegation wake failed for d-wake-failure",
      error: "resident unavailable",
    });
    expect(DelegationStore.listSettledUnwoken().map((record) => record.delegationId)).toEqual([
      "d-wake-failure",
    ]);
    kernel.stop();
  });

  test("restart sweep settles an expired channel as no_response and notify closes at acceptance", async () => {
    DelegationStore.create({
      delegationId: "d-expired-channel",
      operation: "assign",
      address: { kind: "actor", actorId: "alice" },
      transport: "channel",
      deadline: 1_000,
      waitId: "wait-expired",
      rootDelegationId: "d-expired-channel",
      origin: RESIDENT,
      instruction: "expired",
      status: "open",
      createdAt: 500,
    });
    const expired = createDelegationKernel({
      drivers: {},
      now: () => 2_000,
      newDelegationId: () => "unused-3",
      wake: () => undefined,
    });
    expect(DelegationStore.get("d-expired-channel")?.settled).toMatchObject({
      status: "no_response",
      deadline: 1_000,
      at: 2_000,
    });
    expired.stop();

    const notify = createDelegationKernel({
      drivers: {
        channel: {
          run: async (_admitted, _handle, _signal, report) => {
            report?.delivered();
            return { status: "sent" };
          },
        },
      },
      now: () => 3_000,
      newDelegationId: () => "d-notify",
      wake: () => undefined,
    });
    const result = await notify.delegate(
      {
        address: { kind: "actor", actorId: "alice" },
        operation: "notify",
        payload: { text: "hello" },
        deadline: 10_000,
      },
      RESIDENT,
    );
    expect(result).toMatchObject({ handle: { delegationId: "d-notify" }, settled: { status: "sent" } });
    notify.stop();
  });

  test("worker restriction remains inline-only while notify is actor-only", () => {
    expect(
      admit(
        {
          address: { kind: "actor", actorId: "a" },
          operation: "notify",
          payload: { text: "hello" },
          deadline: 5_000,
        },
        WORKER,
        1_000,
        LIMITS,
      ),
    ).toMatchObject({ ok: false, error: { data: { code: "worker_transport" } } });
    expect(
      admit(
        {
          address: { kind: "core", scope: "inline" },
          operation: "notify",
          payload: { text: "hello" },
          deadline: 5_000,
        },
        RESIDENT,
        1_000,
        LIMITS,
      ),
    ).toMatchObject({ ok: false });
  });
});
