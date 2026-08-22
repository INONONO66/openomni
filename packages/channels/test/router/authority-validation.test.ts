import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Gateway, Policy } from "@openomni/protocol";
import { ChannelGrantStore, Storage } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";
import { createGatewayRouter } from "../../src/router/index.js";
import {
  applyChannelGrantTreatment,
  IngressAuthorityMiddleware,
} from "../../src/router/authority.js";
import { makeInboundEvent } from "./_router-fixture.js";

// Moved from openomni test/policy/ingress-authority-validation.test.ts at the
// #707 seam flip: runRoutedPreRun now parses Gateway.DeliveredEvent (no
// brain-owned `agent`) and takes no coordinator — the coordinator-presence
// check is brain-side (pinned in openomni's engine.test.ts).

type RestrictedTrustTier = "observer" | "collaborator" | "assigned_worker";

describe("IngressAuthorityMiddleware trust and validation", () => {
  test("canonical observer trust tier overrides legacy user role", async () => {
    const decisions: Policy.PolicyDecision[] = [];
    const event = makeInboundEvent({
      meta: { actor: { role: "user", actorId: "act_observer", trustTier: "observer" } },
    });

    await expect(
      IngressAuthorityMiddleware.runRoutedPreRun({
        event,
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

    await expect(IngressAuthorityMiddleware.runRoutedPreRun({ event })).rejects.toThrow(
      "actor is not authorized to create top-level inbound work",
    );
  });

  test("channel grant treatment applies default trust tier to unregistered actors", () => {
    const event = makeInboundEvent({
      channel: "public",
      meta: { actor: { role: "user", id: "external-user-1" } },
    });

    const treated = applyChannelGrantTreatment(
      event,
      {
        id: "grant-public-observer",
        surface: "test",
        channel: "public",
        kind: "trusted_channel",
        defaultTier: "observer",
        createdBy: "act_owner",
      },
      // "normal" was never in Actor.InboundTreatment — the enum was born
      // full_access|evidence_only|drop (#250), and this fixture entered already
      // illegal (#519). It passed for a year because the stamping path does no
      // runtime validation; that finding is recorded at the stamping site.
      "full_access",
    );

    expect(treated.meta?.actor).toMatchObject({ role: "user", trustTier: "observer" });
    expect(treated.meta?.channelGrantId).toBe("grant-public-observer");
    expect(treated.meta?.inboundTreatment).toBe("full_access");
  });

  test("channel grant treatment never overrides an explicit trust tier", () => {
    const event = makeInboundEvent({
      meta: { actor: { role: "user", actorId: "act_manager", trustTier: "manager" } },
    });

    const treated = applyChannelGrantTreatment(
      event,
      {
        id: "grant-default-observer",
        surface: "test",
        kind: "trusted_channel",
        defaultTier: "observer",
        createdBy: "act_owner",
      },
      "full_access",
    );

    expect(treated.meta?.actor).toMatchObject({ trustTier: "manager" });
  });

  test("allows an explicit resident target", async () => {
    const event = makeInboundEvent({
      target: { kind: "resident" },
      meta: { actor: { role: "user", actorId: "act_owner", trustTier: "owner" } },
    });

    const result = await IngressAuthorityMiddleware.runRoutedPreRun({ event });

    expect(result.target.kind).toBe("resident");
  });

  test("aborts on invalid schema", async () => {
    const badEvent = { not: "valid" };

    await expect(IngressAuthorityMiddleware.runRoutedPreRun({ event: badEvent })).rejects.toThrow();
  });

  test("aborts on unsupported mode", async () => {
    const event = makeInboundEvent();
    (event as Record<string, unknown>).mode = "fork";

    await expect(IngressAuthorityMiddleware.runRoutedPreRun({ event })).rejects.toThrow(
      "invalid_literal",
    );
  });

  test("collects policy decisions via onDecision callback", async () => {
    const decisions: Policy.PolicyDecision[] = [];
    const event = makeInboundEvent({
      meta: { actor: { role: "user", actorId: "act_owner", trustTier: "owner" } },
    });

    await IngressAuthorityMiddleware.runRoutedPreRun({
      event,
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
      meta: { actor: { role: "user", actorId: "act_owner", trustTier: "owner" } },
    });

    await IngressAuthorityMiddleware.runRoutedPreRun({
      event,
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

describe("GatewayRouter channel default tier composite (e2e)", () => {
  const deliveries: Gateway.Deliver[] = [];

  beforeEach(() => {
    Storage.reset();
    Bus.reset();
    Storage.initialize({ dbPath: ":memory:" });
    deliveries.length = 0;
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
    const router = createGatewayRouter({
      sink: (event, data) => {
        if (event.name === "ingress.routing.decision") decisions.push(data);
        Bus.publish(event, data);
      },
      deliver: async (delivery) => {
        deliveries.push(delivery);
        return {
          mode: "direct",
          target: { kind: "resident" },
          sessionId: delivery.sessionId ?? "unrouted-session",
          result: { output: "resident response", finishReason: "stop" },
        };
      },
    });
    const event = {
      id: "evt-observer-default",
      traceId: "trace-test",
      surface: "test",
      channel: "public",
      mode: "direct",
      payload: "hello",
      meta: { actor: { role: "user", id: "external-user-1" } },
    } satisfies Gateway.DeliveredEvent;

    // The grant admits the message at the channel ceiling (routing decision
    // routes with the channel default tier), but the unregistered actor is
    // then denied by the ingress authority check — the composite that keeps
    // defaultTier a routing fact, never a work-creation authorization.
    await expect(router.ingest(event)).rejects.toThrow(
      "actor is not authorized to create top-level inbound work",
    );

    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      stage: "surface_default",
      outcome: "route",
      trustTier: "observer",
    });
    expect((decisions[0] as { factsUsed: string[] }).factsUsed).toContain(
      "channel.default-tier:observer",
    );
    // No-bypass at the seam: the authority denial fires BEFORE the brain's
    // Deliver port is invoked (the pre-flip test pinned this as "before
    // coordinator dispatch").
    expect(deliveries).toHaveLength(0);
  });
});

// Split from openomni test/policy/policy-deny-wins.test.ts at the #707 seam
// flip: this is the ingress arm of the cross-middleware deny-wins property —
// the perimeter authority deny aborts the pipeline before anything brain-side
// (worker middleware, tool runtime) could allow. The brain-side arms stayed
// in openomni's policy-deny-wins suite.

describe("cross-middleware deny-wins (ingress arm)", () => {
  test("ingress deny blocks entire pipeline regardless of downstream allowances", async () => {
    const event = makeInboundEvent({
      meta: { actor: { role: "sub_persona" } },
    });

    await expect(IngressAuthorityMiddleware.runRoutedPreRun({ event })).rejects.toThrow(
      "actor is not authorized to create top-level inbound work",
    );
  });
});
