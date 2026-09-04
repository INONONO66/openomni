import { afterEach, describe, expect, test } from "bun:test";
import { DelegationStore } from "@openomni/ledger";
import { Delegation, Operational } from "@openomni/protocol";
import { Bus } from "@openomni/agent";
import { createDelegationKernel } from "../src/delegation/kernel";
import { createWakeDeliveryQueue } from "../src/delegation/wake-delivery";
import { eventCollector, useDelegationStore } from "./helpers/delegation";

describe("wake delivery queue", () => {
  useDelegationStore();

  afterEach(() => {
    Bus.reset();
  });

  /**
   * A kernel whose wakes flow through a fresh queue, over one delegation
   * already settled before boot — the exact shape whose rescan wake must
   * queue until arm.
   */
  function settledUnwokenKernel(collector: ReturnType<typeof eventCollector>) {
    const queue = createWakeDeliveryQueue();
    const wakePromises: Array<Promise<void>> = [];
    const kernel = createDelegationKernel({
      drivers: {},
      now: () => 1_000,
      newDelegationId: () => crypto.randomUUID(),
      events: collector,
      bootSweep: false,
      wake: (wake) => {
        const delivery = queue.deliver(wake);
        if (delivery !== undefined) wakePromises.push(delivery);
        return delivery;
      },
    });
    DelegationStore.create(
      Delegation.Record.parse({
        delegationId: "delegation-1",
        operation: "ask",
        address: { kind: "actor", actorId: "actor-1" },
        transport: "channel",
        deadline: 10_000,
        waitId: "wait-1",
        rootDelegationId: "delegation-1",
        origin: { role: "resident", depth: 0, sessionId: "session-1" },
        instruction: "Summarize the proposal.",
        status: "open",
        createdAt: 100,
      }),
    );
    DelegationStore.settleOnce("delegation-1", {
      status: "completed",
      delegationId: "delegation-1",
      output: "done",
      at: 200,
    });
    return { queue, wakePromises, kernel };
  }

  test("a wake queued before arm rejects with exactly one kernel error event", async () => {
    const collector = eventCollector();
    // The composition root's publish channel: a duplicate wake-failure report
    // (R1's defect) would surface here, never through the kernel's sink.
    const busErrors: unknown[] = [];
    Bus.subscribe(Operational.Events.Error, (data) => busErrors.push(data));
    const { queue, wakePromises, kernel } = settledUnwokenKernel(collector);

    // Recovery runs BEFORE the queue is armed: the rescan wake has nowhere to
    // go yet, so it lands in the queue — the exact path R1's duplicate lived on.
    kernel.start();
    expect(queue.pendingCount()).toBe(1);
    expect(wakePromises).toHaveLength(1);

    queue.arm(async () => {
      throw new Error("validation: delivery disabled for this test");
    });

    // Deterministic completion, no drains: the kernel attached its
    // recordSuccess/reportFailure handler to the queued promise during
    // recover() — before this allSettled — and any composition-root publish
    // rides the rejection upstream of it, with its Bus delivery already
    // queued. When allSettled resolves, every wake-failure publish and its
    // delivery has run.
    await Promise.allSettled(wakePromises);

    const errors = collector.events.filter(
      (event) => event.name === Operational.Events.Error.name,
    );
    expect(errors).toHaveLength(1);
    expect(busErrors).toEqual([]);
    expect(errors[0]?.data).toMatchObject({
      component: "delegation",
      msg: "delegation wake failed for delegation-1",
    });
    // The failure left no receipt: the row stays settled-unwoken for the next boot.
    expect(DelegationStore.get("delegation-1")?.wokenAt).toBeUndefined();
  });

  test("a queued wake resolves once arm delivers it and stamps the receipt", async () => {
    const collector = eventCollector();
    const { queue, wakePromises, kernel } = settledUnwokenKernel(collector);

    kernel.start();
    const delivered: string[] = [];
    queue.arm(async (wake) => {
      delivered.push(wake.record.delegationId);
    });
    await Promise.allSettled(wakePromises);

    expect(delivered).toEqual(["delegation-1"]);
    expect(DelegationStore.get("delegation-1")?.wokenAt).toBe(1_000);
    expect(
      collector.events.filter((event) => event.name === Operational.Events.Error.name),
    ).toEqual([]);
  });
});
