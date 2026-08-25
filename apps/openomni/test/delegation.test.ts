import { describe, expect, test } from "bun:test";
import { DelegationStore } from "@openomni/ledger";
import type { Delegation } from "@openomni/protocol";
import { admit, type AdmissionLimits } from "../src/delegation/admission";
import { createDelegationKernel } from "../src/delegation/kernel";
import {
  AWAIT_DELEGATION_TOOL_NAME,
  CANCEL_DELEGATION_TOOL_NAME,
  DELEGATE_TOOL_NAME,
  delegateToolExecutor,
  delegateToolSpec,
} from "../src/delegation/tool";
import {
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
      events,
      limits: LIMITS,
    });
    const result = await kernel.delegate(ask({ deadline: Date.now() + 25 }), RESIDENT);
    if ("refused" in result) throw new Error(result.refused);
    expect(result.settled?.status).toBe("no_response");
    expect(result.settled).toMatchObject({ deadline: expect.any(Number) });
  });
});

describe("delegation controls and tool surface", () => {
  test("start advertises v2 operation and durable controls return immediately", async () => {
    const events = eventCollector();
    const kernel = createDelegationKernel({
      drivers: { process: { run: () => new Promise(() => undefined) } },
      now: () => 1_000,
      newDelegationId: () => "d-tool",
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

  test("restart sweep interrupts volatile work and preserves future channel correlation", () => {
    const open = (record: Delegation.Record): void => {
      DelegationStore.create(record);
    };
    open({
      delegationId: "d-inline-restart",
      operation: "ask",
      address: { kind: "core", scope: "inline" },
      transport: "inline",
      deadline: 5_000,
      rootDelegationId: "d-inline-restart",
      origin: RESIDENT,
      instruction: "volatile",
      status: "open",
      createdAt: 1_000,
    });
    let processWakes = 0;
    const processKernel = createDelegationKernel({
      drivers: {},
      now: () => 2_000,
      newDelegationId: () => "unused",
      wake: () => {
        processWakes += 1;
      },
    });
    expect(DelegationStore.get("d-inline-restart")?.settled).toMatchObject({ status: "interrupted" });
    expect(processWakes).toBe(0);
    processKernel.stop();

    open({
      delegationId: "d-process-restart",
      operation: "ask",
      address: { kind: "core", scope: "independent" },
      transport: "process",
      deadline: 5_000,
      rootDelegationId: "d-process-restart",
      origin: RESIDENT,
      instruction: "process volatile",
      status: "open",
      createdAt: 1_000,
    });
    let processWakesAfterSweep = 0;
    const processSweep = createDelegationKernel({
      drivers: {},
      now: () => 2_000,
      newDelegationId: () => "unused-process",
      wake: () => {
        processWakesAfterSweep += 1;
      },
    });
    expect(DelegationStore.get("d-process-restart")?.settled).toMatchObject({ status: "interrupted" });
    expect(processWakesAfterSweep).toBe(1);
    processSweep.stop();

    open({
      delegationId: "d-channel-restart",
      operation: "ask",
      address: { kind: "actor", actorId: "alice" },
      transport: "channel",
      deadline: 5_000,
      waitId: "wait-restart",
      rootDelegationId: "d-channel-restart",
      origin: RESIDENT,
      instruction: "durable",
      status: "open",
      createdAt: 1_000,
    });
    const channelKernel = createDelegationKernel({
      drivers: {},
      now: () => 2_000,
      newDelegationId: () => "unused-2",
    });
    expect(channelKernel.settleFromReply("wait-restart", "replied after restart")).toBe(true);
    expect(DelegationStore.get("d-channel-restart")?.settled).toMatchObject({
      status: "completed",
      output: "replied after restart",
    });
    channelKernel.stop();
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
