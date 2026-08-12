import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Ingress, Policy } from "@openomni/protocol";
import { Bus, ChannelGrantStore, Storage } from "@openomni/session";
import { createIngressEngine } from "../../src/ingress/engine";
import {
  applyChannelGrantTreatment,
  IngressAuthorityMiddleware,
} from "../../src/ingress/middleware/ingress-authority";

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
  test("canonical observer trust tier overrides legacy user role", async () => {
    const decisions: Policy.PolicyDecision[] = [];
    const event = makeInboundEvent({
      meta: { actor: { role: "user", actorId: "act_observer", trustTier: "observer" } },
    });

    await expect(
      IngressAuthorityMiddleware.runRoutedPreRun({
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
      IngressAuthorityMiddleware.runRoutedPreRun({
        event,
        coordinator: stubCoordinator,
      }),
    ).rejects.toThrow("actor is not authorized to create top-level inbound work");
  });

  test("channel grant treatment applies default trust tier to unregistered actors", () => {
    const event = makeInboundEvent({
      channel: "public",
      meta: { actor: { role: "user", id: "external-user-1" } },
    });

    const treated = applyChannelGrantTreatment(
      event as Ingress.DirectEvent,
      {
        id: "grant-public-observer",
        surface: "test",
        channel: "public",
        kind: "trusted_channel",
        defaultTier: "observer",
        createdBy: "act_owner",
      },
      "normal",
    );

    expect(treated.meta?.actor).toMatchObject({ role: "user", trustTier: "observer" });
    expect(treated.meta?.channelGrantId).toBe("grant-public-observer");
    expect(treated.meta?.inboundTreatment).toBe("normal");
  });

  test("channel grant treatment never overrides an explicit trust tier", () => {
    const event = makeInboundEvent({
      meta: { actor: { role: "user", actorId: "act_manager", trustTier: "manager" } },
    });

    const treated = applyChannelGrantTreatment(
      event as Ingress.DirectEvent,
      {
        id: "grant-default-observer",
        surface: "test",
        kind: "trusted_channel",
        defaultTier: "observer",
        createdBy: "act_owner",
      },
      "normal",
    );

    expect(treated.meta?.actor).toMatchObject({ trustTier: "manager" });
  });

  test("allows explicit resident target when coordinator is missing", async () => {
    const event = makeInboundEvent({
      target: { kind: "resident" },
      meta: { actor: { role: "user" } },
    });

    const result = await IngressAuthorityMiddleware.runRoutedPreRun({ event });

    expect(result.target.kind).toBe("resident");
    expect(result.coordinator).toBeUndefined();
  });

  test("aborts when coordinator is missing for worker creation target", async () => {
    const event = makeInboundEvent({ target: { kind: "worker" } });

    await expect(IngressAuthorityMiddleware.runRoutedPreRun({ event })).rejects.toThrow(
      "coordinator is required for worker target",
    );
  });

  test("aborts on invalid schema", async () => {
    const badEvent = { not: "valid" };

    await expect(
      IngressAuthorityMiddleware.runRoutedPreRun({
        event: badEvent,
        coordinator: stubCoordinator,
      }),
    ).rejects.toThrow();
  });

  test("aborts on unsupported mode", async () => {
    const event = makeInboundEvent();
    (event as Record<string, unknown>).mode = "fork";

    await expect(
      IngressAuthorityMiddleware.runRoutedPreRun({
        event,
        coordinator: stubCoordinator,
      }),
    ).rejects.toThrow("invalid_literal");
  });

  test("collects policy decisions via onDecision callback", async () => {
    const decisions: Policy.PolicyDecision[] = [];
    const event = makeInboundEvent({
      meta: { actor: { role: "user" } },
    });

    await IngressAuthorityMiddleware.runRoutedPreRun({
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

  test("routed pre-run never re-runs blacklist or channel-grant checks", async () => {
    const decisions: Policy.PolicyDecision[] = [];
    const event = makeInboundEvent({
      meta: { actor: { role: "user" } },
    });

    await IngressAuthorityMiddleware.runRoutedPreRun({
      event,
      coordinator: stubCoordinator,
      onDecision: (d) => {
        decisions.push(d);
      },
    });

    const policyIds = decisions.map((d) => d.policyId);
    expect(policyIds).toContain("guardrail.permission");
    expect(policyIds).not.toContain("ingress.blacklist");
    expect(policyIds).not.toContain("ingress.channel_grant");
  });
});

describe("IngressEngine channel default tier composite (e2e)", () => {
  beforeEach(() => {
    Storage.reset();
    Bus.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  afterEach(() => {
    Storage.reset();
    Bus.reset();
  });

  test("trusted_channel defaultTier observer admits an unregistered actor at the channel ceiling, then the authority check denies", async () => {
    ChannelGrantStore.put({
      id: "grant-public-observer",
      surface: "test",
      channel: "public",
      kind: "trusted_channel",
      defaultTier: "observer",
      createdBy: "act_owner",
    });
    const decisions: unknown[] = [];
    const unsubscribe = Bus.observe((event, payload) => {
      if (event.name === "ingress.routing.decision") decisions.push(payload);
    });
    const event = {
      id: "evt-observer-default",
      surface: "test",
      channel: "public",
      mode: "direct",
      payload: "hello",
      meta: { actor: { role: "user", id: "external-user-1" } },
      agent: { model: { provider: "test", id: "test-model" } },
    } satisfies Ingress.DirectEvent;

    try {
      // The grant admits the message at the channel ceiling (routing decision
      // routes with the channel default tier), but the unregistered actor is
      // then denied by the ingress authority check — the composite that keeps
      // defaultTier a routing fact, never a work-creation authorization.
      await expect(createIngressEngine().ingest(event)).rejects.toThrow(
        "actor is not authorized to create top-level inbound work",
      );
    } finally {
      unsubscribe();
    }

    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      stage: "surface_default",
      outcome: "route",
      trustTier: "observer",
    });
    expect((decisions[0] as { factsUsed: string[] }).factsUsed).toContain(
      "channel.default-tier:observer",
    );
  });
});
