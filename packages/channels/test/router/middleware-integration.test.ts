import { describe, expect, test } from "bun:test";
import type { Policy } from "@openomni/protocol";
import { IngressAuthorityMiddleware } from "../../src/router/authority.js";
import { makeInboundEvent } from "./_router-fixture.js";

// Moved from openomni test/policy/middleware-integration.test.ts at the #707
// seam flip: runRoutedPreRun parses Gateway.DeliveredEvent (no brain-owned
// `agent`) and takes no coordinator — presence checks are brain-side.

// Authorization is a pure trust-tier check: the pre-split role fallbacks and
// worker-control action rules were unreachable (every routed pre-run event
// carries a resolved trustTier by routing time) and were removed. An untiered
// actor — whatever its self-reported role or action — fails closed here.
describe("IngressAuthorityMiddleware integration", () => {
  test("allows a top-level trust-tier actor to create inbound work", async () => {
    const event = makeInboundEvent({
      meta: { actor: { actorId: "act_owner", trustTier: "owner" } },
    });

    const result = await IngressAuthorityMiddleware.runRoutedPreRun({ event });

    expect(result.event.id).toBe("evt-1");
    expect(result.mode).toBe("direct");
  });

  test("allows an evidence_only collaborator delivered to the resident", async () => {
    const event = makeInboundEvent({
      target: { kind: "resident" },
      meta: {
        actor: { actorId: "act_collab", trustTier: "collaborator" },
        inboundTreatment: "evidence_only",
      },
    });

    const result = await IngressAuthorityMiddleware.runRoutedPreRun({ event });

    expect(result.target.kind).toBe("resident");
  });

  test("denies an untiered actor regardless of self-reported role", async () => {
    const event = makeInboundEvent({
      meta: { actor: { role: "user" } },
    });

    await expect(IngressAuthorityMiddleware.runRoutedPreRun({ event })).rejects.toThrow(
      "not authorized to create top-level inbound work",
    );
  });

  test("denies an untiered worker-role actor with a control action", async () => {
    const event = makeInboundEvent({
      meta: { actor: { role: "worker" }, action: "spawn" },
    });

    await expect(IngressAuthorityMiddleware.runRoutedPreRun({ event })).rejects.toThrow(
      "not authorized to create top-level inbound work",
    );
  });

  test("fans the authority decision to the observer with the trust label", async () => {
    const decisions: Policy.PolicyDecision[] = [];
    const event = makeInboundEvent({
      meta: { actor: { actorId: "act_owner", trustTier: "owner" } },
    });

    await IngressAuthorityMiddleware.runRoutedPreRun({
      event,
      onDecision: (decision) => {
        decisions.push(decision);
      },
    });

    expect(decisions.some((decision) => decision.factsUsed?.includes("trust.owner"))).toBe(true);
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
