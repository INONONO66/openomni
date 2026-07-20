import { describe, expect, it } from "bun:test";
import { IngressEvent } from "@openomni/protocol";
import { resolveRoute, type RouteInbound, type RouteState } from "../../src/ingress/index";

function parseDecision(inbound: RouteInbound, state: RouteState) {
  const decision = resolveRoute(inbound, state);
  return IngressEvent.RoutingDecision.schema.parse(decision);
}

describe("resolveRoute", () => {
  it("returns one surface route for a registered Owner DM", () => {
    // Given
    const inbound = Object.freeze({
      traceId: "trace-owner-dm",
      time: 1_000,
      id: "inbound-owner-dm",
      surface: "discord",
      mode: "direct",
      target: "resident",
    }) satisfies RouteInbound;
    const state = Object.freeze({
      wait: Object.freeze({ kind: "none" }),
      channel: Object.freeze({
        id: "grant-owner-dm",
        kind: "trusted_channel",
        inboundTreatment: "full_access",
        defaultTier: "owner",
      }),
      actor: Object.freeze({
        id: "actor-owner",
        trustTier: "owner",
        registered: true,
      }),
      surfaceSessionId: "session-owner-dm",
    }) satisfies RouteState;

    // When
    const decision = parseDecision(inbound, state);

    // Then
    expect(decision).toMatchObject({
      traceId: "trace-owner-dm",
      time: 1_000,
      inboundId: "inbound-owner-dm",
      surface: "discord",
      mode: "direct",
      stage: "surface_default",
      outcome: "route",
      target: "resident",
      sessionId: "session-owner-dm",
      actorId: "actor-owner",
      trustTier: "owner",
      inboundTreatment: "full_access",
    });
    expect(decision.factsUsed).toContain("channel:grant-owner-dm");
    expect(decision.factsUsed).toContain("actor:actor-owner");
    expect(decision.factsUsed).toContain("surface.default:session-owner-dm");
  });

  it("routes trusted first contact to a new surface session candidate", () => {
    // Given
    const inbound = Object.freeze({
      traceId: "trace-first-contact",
      time: 1_500,
      id: "inbound-first-contact",
      surface: "discord",
      mode: "direct",
      target: "resident",
    }) satisfies RouteInbound;
    const state = Object.freeze({
      wait: Object.freeze({ kind: "none" }),
      channel: Object.freeze({
        id: "grant-first-contact",
        kind: "trusted_channel",
        inboundTreatment: "full_access",
        defaultTier: "owner",
      }),
    }) satisfies RouteState;

    // When
    const decision = parseDecision(inbound, state);

    // Then
    expect(decision).toMatchObject({
      traceId: "trace-first-contact",
      time: 1_500,
      inboundId: "inbound-first-contact",
      surface: "discord",
      mode: "direct",
      stage: "surface_default",
      outcome: "route",
      target: "resident",
      trustTier: "owner",
      inboundTreatment: "full_access",
    });
    expect(decision.sessionId).toBeUndefined();
    expect(decision.factsUsed).toContain("surface.default:new");
    expect(decision.factsUsed.some((fact) => fact.includes("undefined"))).toBe(false);
  });

  it("routes an allowed report reply to its PendingInteraction session and run", () => {
    // Given
    const inbound = Object.freeze({
      traceId: "trace-report-reply",
      time: 2_000,
      id: "inbound-report-reply",
      surface: "app_connector",
      mode: "direct",
      target: "resident",
      requestedAction: "report_result",
    }) satisfies RouteInbound;
    const state = Object.freeze({
      wait: Object.freeze({
        kind: "match",
        backing: "pending_interaction",
        key: "pending_interaction:interaction-report",
        recordId: "interaction-report",
        sessionId: "session-owning-work",
        runId: "run-owning-work",
        allowed: Object.freeze(["report_result"]),
        targetActorId: "actor-external-worker",
      }),
      channel: Object.freeze({
        id: "blocked-decoy",
        kind: "blocked_channel",
        inboundTreatment: "drop",
      }),
      surfaceSessionId: "session-surface-decoy",
    }) satisfies RouteState;

    // When
    const decision = parseDecision(inbound, state);

    // Then
    expect(decision).toMatchObject({
      traceId: "trace-report-reply",
      time: 2_000,
      inboundId: "inbound-report-reply",
      surface: "app_connector",
      mode: "direct",
      stage: "wait_correlation",
      outcome: "route",
      target: "worker-session:session-owning-work",
      sessionId: "session-owning-work",
      runId: "run-owning-work",
      pendingInteractionId: "interaction-report",
      actorId: "actor-external-worker",
      trustTier: "assigned_worker",
    });
    expect(decision.factsUsed).toContain("wait:pending_interaction:interaction-report");
    expect(decision.factsUsed).toContain("wait.action:report_result");
  });

  it("routes a PendingAsk match to its owning Resident session and optional run", () => {
    const inbound = Object.freeze({
      traceId: "trace-pending-ask",
      time: 2_500,
      id: "inbound-pending-ask",
      surface: "discord",
      mode: "direct",
      target: "resident",
    }) satisfies RouteInbound;
    const state = Object.freeze({
      wait: Object.freeze({
        kind: "match",
        backing: "pending_ask",
        key: "pending_ask:ask-owner",
        recordId: "ask-owner",
        sessionId: "session-ask-owner",
        runId: "run-ask-owner",
      }),
      channel: Object.freeze({
        id: "blocked-decoy",
        kind: "blocked_channel",
        inboundTreatment: "drop",
      }),
      surfaceSessionId: "session-surface-decoy",
    }) satisfies RouteState;

    const decision = parseDecision(inbound, state);

    expect(decision).toMatchObject({
      stage: "wait_correlation",
      outcome: "route",
      target: "resident",
      sessionId: "session-ask-owner",
      runId: "run-ask-owner",
    });
    expect(decision.pendingInteractionId).toBeUndefined();
    expect(decision.trustTier).toBeUndefined();
    expect(decision.factsUsed).toContain("wait:pending_ask:ask-owner");
  });

  it("routes system cron through the same surface-default decision", () => {
    // Given
    const inbound = Object.freeze({
      traceId: "trace-cron",
      time: 3_000,
      id: "inbound-cron",
      surface: "cron",
      mode: "internal",
      target: "resident",
    }) satisfies RouteInbound;
    const state = Object.freeze({
      wait: Object.freeze({ kind: "none" }),
      surfaceSessionId: "session-cron",
      systemActorId: "system:cron",
    }) satisfies RouteState;

    // When
    const decision = parseDecision(inbound, state);

    // Then
    expect(decision).toMatchObject({
      traceId: "trace-cron",
      time: 3_000,
      inboundId: "inbound-cron",
      surface: "cron",
      mode: "internal",
      stage: "surface_default",
      outcome: "route",
      target: "resident",
      sessionId: "session-cron",
      actorId: "system:cron",
    });
    expect(decision.factsUsed).toContain("actor.system:system:cron");
    expect(decision.factsUsed).toContain("surface.default:session-cron");
  });
});
