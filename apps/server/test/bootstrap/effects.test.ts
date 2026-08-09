import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Bus, EffectStore, Storage, WorkItemStore } from "@openomni/session";
import { assembleEffectRuntime } from "../../src/bootstrap/effects";

/**
 * #492 escalation seam branches, driven through the boot composition exactly
 * as recovery runs it (the conformance suite pins the same semantics but its
 * coverage lands on script/, not apps/server).
 */

async function createWorkItem(name: string) {
  const item = await WorkItemStore.create({
    name,
    sourceMessageId: `msg_${name}`,
    sourceChannel: "test",
    intent: "verify",
    goal: "effect escalation branches",
    sessionId: "session_effects_unit",
    acceptanceCriteria: ["escalation is durable and deduplicated"],
  });
  if (!item) throw new Error("work item fixture failed");
  return item;
}

describe("effect escalation seam (#492)", () => {
  let errors: Array<Record<string, unknown>>;

  beforeEach(() => {
    Bus.reset();
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
    errors = [];
    Bus.observe((event, payload) => {
      if (event.name === "operational.error") {
        errors.push(payload as Record<string, unknown>);
      }
    });
  });

  afterEach(() => {
    Storage.reset();
    Bus.reset();
  });

  it("adds exactly one waiting_input blocker and never stacks across sweeps", async () => {
    const item = await createWorkItem("escalation-dedup");
    const { service, reconciler } = assembleEffectRuntime();
    await service.run({ effectId: "fx-unit-1", kind: "exhausting-probe", workItemHash: item.hash });

    await reconciler.reconcile();
    await reconciler.reconcile();
    await reconciler.reconcile();

    const escalated = await WorkItemStore.get(item.hash);
    const blockers = escalated?.blockers.filter((b) => b.kind === "waiting_input") ?? [];
    expect(blockers).toHaveLength(1);
    expect(blockers[0]?.id).toBe("effect-escalation:fx-unit-1");
    // The loud event fires per sweep even though the blocker is deduplicated.
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(errors.filter((e) => String(e.msg).includes("fx-unit-1")).length).toBe(3);
  });

  it("skips the blocker on a terminal WorkItem but still escalates loudly", async () => {
    const item = await createWorkItem("escalation-terminal");
    const { service, reconciler } = assembleEffectRuntime();
    await service.run({ effectId: "fx-unit-2", kind: "exhausting-probe", workItemHash: item.hash });
    await WorkItemStore.cancel(item.hash);

    const summary = await reconciler.reconcile();
    expect(summary.escalated).toBe(1);

    const cancelled = await WorkItemStore.get(item.hash);
    expect(cancelled?.blockers.filter((b) => b.kind === "waiting_input")).toHaveLength(0);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const event = errors.find((e) => String(e.msg).includes("fx-unit-2"));
    expect((event?.context as Record<string, unknown>)?.blocker).toBe(
      "skipped:work_item_cancelled",
    );
  });

  it("reports a missing WorkItem distinctly and keeps the intent outstanding", async () => {
    const { reconciler } = assembleEffectRuntime();
    EffectStore.intend({
      effectId: "fx-unit-3",
      kind: "exhausting-probe",
      workItemHash: "wi_never_existed",
    });

    const summary = await reconciler.reconcile();
    expect(summary.escalated).toBe(1);
    expect(EffectStore.status("fx-unit-3").status).toBe("pending");
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const event = errors.find((e) => String(e.msg).includes("fx-unit-3"));
    expect((event?.context as Record<string, unknown>)?.blocker).toBe("failed:work_item_missing");
  });
});
