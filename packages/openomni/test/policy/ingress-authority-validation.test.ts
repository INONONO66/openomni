import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Ingress, Policy } from "@openomni/protocol";
import { ChannelGrantStore, Storage } from "@openomni/session";
import { IngressAuthorityMiddleware } from "../../src/ingress/middleware/ingress-authority";

type RestrictedTrustTier = "observer" | "collaborator" | "assigned_worker";

function makeInboundEvent(overrides?: Partial<Ingress.InboundEvent>): Ingress.InboundEvent {
  return {
    id: "evt-1",
    surface: "test",
    mode: "direct",
    agent: {
      model: { provider: "test", id: "test-model" },
    },
    ...overrides,
  } as Ingress.InboundEvent;
}

const stubCoordinator = {
  dispatch: async () => ({
    runId: "run-stub",
    sessionId: "session-stub",
    status: "succeeded" as const,
    output: "ok",
    finishReason: "stop",
  }),
};

describe("IngressAuthorityMiddleware trust and validation", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
    ChannelGrantStore.put({
      id: "grant-test",
      surface: "test",
      kind: "trusted_channel",
      createdBy: "act_owner",
    });
  });

  afterEach(() => {
    Storage.reset();
  });
  test("canonical observer trust tier overrides legacy user role", async () => {
    const decisions: Policy.PolicyDecision[] = [];
    const event = makeInboundEvent({
      meta: { actor: { role: "user", actorId: "act_observer", trustTier: "observer" } },
    });

    await expect(
      IngressAuthorityMiddleware.runPreRun({
        event,
        coordinator: stubCoordinator,
        onDecision: (decision) => {
          decisions.push(decision);
        },
      }),
    ).rejects.toThrow("actor is not authorized to create top-level inbound work");

    expect(decisions.some((decision) => decision.factsUsed?.includes("trust.observer"))).toBe(true);
  });

  test.each([
    "observer",
    "collaborator",
    "assigned_worker",
  ] as const)("canonical %s trust tier overrides privileged legacy resident role", async (trustTier: RestrictedTrustTier) => {
    const event = makeInboundEvent({
      target: { kind: "worker" },
      meta: {
        actor: {
          role: "resident",
          actorId: `act_${trustTier}`,
          trustTier,
          trusted: true,
          isTrustedManager: true,
        },
        action: "spawn",
      },
    });

    await expect(
      IngressAuthorityMiddleware.runPreRun({
        event,
        coordinator: stubCoordinator,
      }),
    ).rejects.toThrow("actor is not authorized to create top-level inbound work");
  });

  test("uses channel default trust tier for unregistered actors", async () => {
    ChannelGrantStore.put({
      id: "grant-public-observer",
      surface: "test",
      channel: "public",
      kind: "trusted_channel",
      defaultTier: "observer",
      createdBy: "act_owner",
    });
    const event = makeInboundEvent({
      channel: "public",
      meta: { actor: { role: "user", id: "external-user-1" } },
    });

    await expect(
      IngressAuthorityMiddleware.runPreRun({
        event,
        coordinator: stubCoordinator,
      }),
    ).rejects.toThrow("actor is not authorized to create top-level inbound work");
  });

  test("allows explicit resident target when coordinator is missing", async () => {
    const event = makeInboundEvent({
      target: { kind: "resident" },
      meta: { actor: { role: "user" } },
    });

    const result = await IngressAuthorityMiddleware.runPreRun({ event });

    expect(result.target.kind).toBe("resident");
    expect(result.coordinator).toBeUndefined();
  });

  test("aborts when coordinator is missing for worker creation target", async () => {
    const event = makeInboundEvent({ target: { kind: "worker" } });

    await expect(IngressAuthorityMiddleware.runPreRun({ event })).rejects.toThrow(
      "coordinator is required for worker target",
    );
  });

  test("aborts on invalid schema", async () => {
    const badEvent = { not: "valid" };

    await expect(
      IngressAuthorityMiddleware.runPreRun({
        event: badEvent,
        coordinator: stubCoordinator,
      }),
    ).rejects.toThrow();
  });

  test("aborts on unsupported mode", async () => {
    const event = makeInboundEvent();
    (event as Record<string, unknown>).mode = "fork";

    await expect(
      IngressAuthorityMiddleware.runPreRun({
        event,
        coordinator: stubCoordinator,
      }),
    ).rejects.toThrow();
  });

  test("collects policy decisions via onDecision callback", async () => {
    const decisions: unknown[] = [];
    const event = makeInboundEvent({
      meta: { actor: { role: "user" } },
    });

    await IngressAuthorityMiddleware.runPreRun({
      event,
      coordinator: stubCoordinator,
      onDecision: (d) => {
        decisions.push(d);
      },
    });

    expect(decisions.length).toBeGreaterThan(0);
    for (const d of decisions) {
      expect(d).toHaveProperty("policyId");
      expect(d).toHaveProperty("verdict");
    }
  });

  test("registrations produce all six middleware steps", () => {
    const state = {
      input: makeInboundEvent(),
      coordinator: stubCoordinator,
    } satisfies Parameters<typeof IngressAuthorityMiddleware.registrations>[0];
    const regs = IngressAuthorityMiddleware.registrations(state);

    expect(regs).toHaveLength(6);
    const names = regs.map((r) => r.name);
    expect(names).toContain(IngressAuthorityMiddleware.CoordinatorPresence.name);
    expect(names).toContain(IngressAuthorityMiddleware.SchemaValidation.name);
    expect(names).toContain(IngressAuthorityMiddleware.BlacklistCheck.name);
    expect(names).toContain(IngressAuthorityMiddleware.ChannelGrantCheck.name);
    expect(names).toContain(IngressAuthorityMiddleware.AuthorityCheck.name);
    expect(names).toContain(IngressAuthorityMiddleware.ModeDispatch.name);
  });
});
