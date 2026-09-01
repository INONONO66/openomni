import { describe, expect, test } from "bun:test";
import type { Gateway } from "@openomni/protocol";
import { DelegationStore, WorkItemStore } from "@openomni/ledger";
import { admit, type Admitted } from "../src/delegation/admission";
import { createChannelDriver } from "../src/delegation/channel-driver";
import { createDelegationKernel } from "../src/delegation/kernel";
import { eventCollector, awaitedReceipt, RESIDENT, useDelegationStore } from "./helpers/delegation";
import { fakeWorkItemLinkage } from "./helpers/fake-work-items";
import { createWorkItemLinkage } from "../src/delegation/work-item-linkage";

useDelegationStore();

const NOW = 1_000_000;
const DEADLINE = NOW + 5_000;

function admitted(operation: "ask" | "assign" | "notify" = "assign"): Admitted {
  const decision = admit(
    {
      address: { kind: "actor", actorId: "alice" },
      operation,
      payload: { text: "review the report" },
      ...(operation === "assign" ? { acceptanceCriteria: ["every section read"] } : {}),
      deadline: DEADLINE,
    },
    RESIDENT,
    NOW,
    { maxInlineDepth: 2, maxFanout: 8 },
    {
      delegationId: "delegation-1",
      rootDelegationId: "delegation-1",
      openFanout: 0,
    },
  );
  if (!decision.ok) throw new Error(decision.reason);
  return decision;
}

const HANDLE = {
  delegationId: "delegation-1",
  operation: "assign",
  address: { kind: "actor", actorId: "alice" },
  transport: "channel",
  deadline: DEADLINE,
  waitId: "wait-1",
  rootDelegationId: "delegation-1",
} as const;

describe("channel delegation driver", () => {
  test("prepare allocates the Wait id before run and uses the Handle deadline", async () => {
    const sent: Gateway.SendInput[] = [];
    const controller = new AbortController();
    const driver = createChannelDriver({
      send: async (input) => {
        sent.push(input);
        return awaitedReceipt(input);
      },
      now: () => NOW,
      newWaitId: () => "wait-1",
      conversations: {
        open: () => {
          throw new Error("window open failed");
        },
        get: () => undefined,
      },
    });
    const prepared = driver.prepare(admitted(), {
      ...HANDLE,
      waitId: undefined,
    });
    expect(prepared).toEqual({ waitId: "wait-1" });
    await expect(driver.run(admitted(), HANDLE, controller.signal)).rejects.toThrow(
      "window open failed",
    );
    const input = sent[0];
    if (input === undefined || input.waitSpec === undefined) throw new Error("nothing was sent");
    expect(input.operation).toBe("awaited");
    expect(input.waitSpec.expiresAt).toBe(DEADLINE);
    expect(input.waitSpec.waitId).toBe("wait-1");
  });

  test("notify uses fire-and-forget and reports sent at acceptance", async () => {
    let delivered = 0;
    let sentInput: Gateway.SendInput | undefined;
    const driver = createChannelDriver({
      send: async (input) => {
        sentInput = input;
        return {
          kind: "sent",
          operation: "fire_and_forget",
          messageId: input.messageId,
          senderId: input.senderId,
          grantId: "grant",
          target: { actorId: "alice", endpointId: "e", channel: "ws", externalId: "alice" },
          at: input.at,
        };
      },
      now: () => NOW,
      newWaitId: () => "never-used",
      conversations: { open: () => { throw new Error("not reached"); }, get: () => undefined },
    });
    const outcome = await driver.run(admitted("notify"), { ...HANDLE, operation: "notify", waitId: undefined }, new AbortController().signal, {
      delivered: () => {
        delivered += 1;
      },
    });
    expect(outcome).toEqual({ status: "sent" });
    expect(delivered).toBe(1);
    expect(sentInput?.operation).toBe("fire_and_forget");
    expect(sentInput?.waitSpec).toBeUndefined();
  });

  test("denied and thrown sends report delivery_failed without a correlation map", async () => {
    const denied = createChannelDriver({
      send: async (input) => ({
        kind: "denied",
        code: "target_stale",
        messageId: input.messageId,
        senderId: input.senderId,
        targetActorId: "alice",
        reason: "actor has no endpoint",
        at: input.at,
      }),
      now: () => NOW,
      newWaitId: () => "wait-1",
      conversations: { open: () => { throw new Error("not reached"); }, get: () => undefined },
    });
    await expect(denied.run(admitted(), HANDLE, new AbortController().signal)).resolves.toEqual({
      status: "delivery_failed",
      reason: "actor has no endpoint",
    });

    const broken = createChannelDriver({
      send: async () => {
        throw new Error("socket closed");
      },
      now: () => NOW,
      newWaitId: () => "wait-1",
      conversations: { open: () => { throw new Error("not reached"); }, get: () => undefined },
    });
    await expect(broken.run(admitted(), HANDLE, new AbortController().signal)).resolves.toEqual({
      status: "delivery_failed",
      reason: "socket closed",
    });
  });

  test("durable channel assignment correlates its attempt to the prepared wait id", async () => {
    const driver = createChannelDriver({
      send: async (input) => awaitedReceipt(input),
      now: () => NOW,
      newWaitId: () => "wait-durable",
      conversations: { open: () => { throw new Error("not reached"); }, get: () => undefined },
    });
    const kernel = createDelegationKernel({
      drivers: { channel: driver },
      now: () => NOW,
      newDelegationId: () => "delegation-durable",
      wake: () => undefined,
      workItems: createWorkItemLinkage({ model: { provider: "test", id: "model" }, now: () => NOW }),
    });
    const started = await kernel.delegate({
      address: { kind: "actor", actorId: "alice" }, operation: "assign",
      payload: { text: "review" }, acceptanceCriteria: ["read"], deadline: DEADLINE,
    }, RESIDENT);
    if ("refused" in started) throw new Error(started.refused);
    const workItemId = DelegationStore.get("delegation-durable")?.workItemId;
    const item = await WorkItemStore.get(workItemId ?? "");
    expect(item?.workerRunId).toBe("wait-durable");
    expect(item?.workerRunId).not.toMatch(/^[0-9a-f-]{36}$/);
    kernel.stop();
  });

  test("the kernel resolves a correlated reply from the durable record", async () => {
    const events = eventCollector();
    const driver = createChannelDriver({
      send: async (input) => awaitedReceipt(input),
      now: () => NOW,
      newWaitId: () => "wait-1",
      conversations: { open: () => { throw new Error("not reached"); }, get: () => undefined },
    });
    const kernel = createDelegationKernel({
      drivers: { channel: driver },
      now: () => NOW,
      newDelegationId: () => "delegation-1",
      wake: () => undefined,
      events,
      workItems: fakeWorkItemLinkage(),
    });
    const started = await kernel.delegate(
      {
        address: { kind: "actor", actorId: "alice" },
        operation: "assign",
        payload: { text: "review" },
        acceptanceCriteria: ["read"],
        deadline: DEADLINE,
      },
      RESIDENT,
    );
    if ("refused" in started) throw new Error(started.refused);
    expect(started.settled).toBeUndefined();
    expect(started.handle.waitId).toBe("wait-1");
    expect(kernel.settleFromReply("wait-1", "all read")).toBe(true);
    expect(kernel.settleFromReply("wait-1", "late reply")).toBe(false);
    expect(DelegationStore.get("delegation-1")).toMatchObject({
      status: "settled",
      settled: { status: "completed", output: "all read" },
    });
    await events.waitFor("delegation.settled");
  });

  test("a worker cannot reach an actor channel", () => {
    const decision = admit(
      {
        address: { kind: "actor", actorId: "alice" },
        operation: "assign",
        payload: { text: "review" },
        acceptanceCriteria: ["read"],
        deadline: DEADLINE,
      },
      { role: "worker", depth: 1, sessionId: "session-origin" },
      NOW,
      { maxInlineDepth: 2, maxFanout: 8 },
    );
    expect(decision).toMatchObject({ ok: false, error: { data: { code: "worker_transport" } } });
  });
  test("an awaited ask opens its bounded conversation window after acceptance", async () => {
    const opened: Array<{ id: string; expiresAt: number }> = [];
    const controller = new AbortController();
    const driver = createChannelDriver({
      send: async (input) => awaitedReceipt(input),
      now: () => NOW,
      newWaitId: () => "wait-1",
      conversations: {
        open: (input) => {
          opened.push({ id: input.id, expiresAt: input.policy.expiresAt });
          throw new Error("stop after recording — the window shape is the assertion");
        },
        get: () => undefined,
      },
    });
    await expect(
      driver.run(admitted("ask"), { ...HANDLE, operation: "ask" }, controller.signal),
    ).rejects.toThrow("stop after recording");
    expect(opened).toEqual([{ id: "conv:wait-1", expiresAt: DEADLINE }]);
  });

  test("a replayed dispatch reuses the already-open window (idempotent)", async () => {
    let opens = 0;
    const controller = new AbortController();
    const driver = createChannelDriver({
      send: async (input) => awaitedReceipt(input),
      now: () => NOW,
      newWaitId: () => "wait-1",
      conversations: {
        open: () => {
          opens += 1;
          throw new Error("must not re-open");
        },
        get: () => ({ id: "conv:wait-1" }) as never,
      },
    });
    const outcome = driver.run(admitted("ask"), { ...HANDLE, operation: "ask" }, controller.signal);
    controller.abort();
    await outcome;
    expect(opens).toBe(0);
  });
});

