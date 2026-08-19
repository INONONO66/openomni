import { describe, expect, test } from "bun:test";
import type { Gateway, Policy } from "@openomni/protocol";
import { IngressAuthorityMiddleware } from "../../src/router/authority.js";

// Moved from openomni test/policy/middleware-integration.test.ts at the #707
// seam flip: runRoutedPreRun parses Gateway.DeliveredEvent (no brain-owned
// `agent`) and takes no coordinator — presence checks are brain-side.

type WorkerControlTestAction = "cancel" | "resume" | "schedule";

function makeInboundEvent(overrides?: Partial<Gateway.DeliveredEvent>): Gateway.DeliveredEvent {
  return {
    id: "evt-1",
    traceId: "trace-test",
    surface: "test",
    mode: "direct",
    ...overrides,
  } as Gateway.DeliveredEvent;
}

describe("IngressAuthorityMiddleware integration", () => {
  test("allows user actor to create top-level inbound work", async () => {
    const event = makeInboundEvent({
      meta: { actor: { role: "user" } },
    });

    const result = await IngressAuthorityMiddleware.runRoutedPreRun({ event });

    expect(result.event.id).toBe("evt-1");
    expect(result.mode).toBe("direct");
  });

  test("allows resident actor", async () => {
    const event = makeInboundEvent({
      meta: { actor: { role: "resident" } },
    });

    const result = await IngressAuthorityMiddleware.runRoutedPreRun({ event });

    expect(result.event.id).toBe("evt-1");
  });

  test("denies worker actor action spawn", async () => {
    const event = makeInboundEvent({
      meta: { actor: { role: "worker" }, action: "spawn" },
    });

    await expect(IngressAuthorityMiddleware.runRoutedPreRun({ event })).rejects.toThrow(
      "worker cannot spawn workers",
    );
  });

  test("allows resident actor action spawn", async () => {
    const event = makeInboundEvent({
      meta: { actor: { role: "resident" }, action: "spawn" },
    });

    const result = await IngressAuthorityMiddleware.runRoutedPreRun({ event });

    expect(result.event.id).toBe("evt-1");
  });

  test("allows worker actor action send to worker target", async () => {
    const event = makeInboundEvent({
      target: { kind: "worker", sessionId: "worker-session-1" },
      meta: { actor: { role: "worker" }, action: "send" },
    });

    const result = await IngressAuthorityMiddleware.runRoutedPreRun({ event });

    expect(result.target.kind).toBe("worker");
  });

  test("allows worker actor action send to resident target", async () => {
    const event = makeInboundEvent({
      target: { kind: "resident" },
      meta: { actor: { role: "worker" }, action: "send" },
    });

    const result = await IngressAuthorityMiddleware.runRoutedPreRun({ event });

    expect(result.target.kind).toBe("resident");
  });

  test.each([
    "cancel",
    "resume",
    "schedule",
  ] as const)("denies worker actor action %s", async (action: WorkerControlTestAction) => {
    const event = makeInboundEvent({
      meta: { actor: { role: "worker" }, action },
    });

    await expect(IngressAuthorityMiddleware.runRoutedPreRun({ event })).rejects.toThrow(
      `worker cannot ${action} workers`,
    );
  });

  test.each([
    "cancel",
    "resume",
    "schedule",
  ] as const)("allows resident actor action %s", async (action: WorkerControlTestAction) => {
    const event = makeInboundEvent({
      meta: { actor: { role: "resident" }, action },
    });

    const result = await IngressAuthorityMiddleware.runRoutedPreRun({ event });

    expect(result.event.id).toBe("evt-1");
  });

  test("adds action labels to authority policy decisions", async () => {
    const decisions: Policy.PolicyDecision[] = [];
    const event = makeInboundEvent({
      meta: { actor: { role: "worker" }, action: "spawn" },
    });

    await expect(
      IngressAuthorityMiddleware.runRoutedPreRun({
        event,
        onDecision: (decision) => {
          decisions.push(decision);
        },
      }),
    ).rejects.toThrow("worker cannot spawn workers");

    expect(decisions.some((decision) => decision.factsUsed?.includes("action.spawn"))).toBe(true);
  });

  test("denies untrusted sub-persona actor", async () => {
    const event = makeInboundEvent({
      meta: { actor: { role: "sub_persona" } },
    });

    await expect(IngressAuthorityMiddleware.runRoutedPreRun({ event })).rejects.toThrow();
  });

  test("denies manager actor without trusted flag", async () => {
    const event = makeInboundEvent({
      meta: { actor: { role: "manager", trusted: false } },
    });

    await expect(IngressAuthorityMiddleware.runRoutedPreRun({ event })).rejects.toThrow();
  });

  test("denies self-reported trusted manager without store trust tier", async () => {
    const event = makeInboundEvent({
      meta: { actor: { role: "manager", trusted: true } },
    });

    await expect(IngressAuthorityMiddleware.runRoutedPreRun({ event })).rejects.toThrow();
  });

  test("allows canonical manager trust tier without legacy trusted flag", async () => {
    const decisions: Policy.PolicyDecision[] = [];
    const event = makeInboundEvent({
      meta: { actor: { actorId: "act_manager", trustTier: "manager" } },
    });

    const result = await IngressAuthorityMiddleware.runRoutedPreRun({
      event,
      onDecision: (decision) => {
        decisions.push(decision);
      },
    });

    expect(result.event.id).toBe("evt-1");
    expect(decisions.some((decision) => decision.factsUsed?.includes("trust.manager"))).toBe(true);
  });
});
