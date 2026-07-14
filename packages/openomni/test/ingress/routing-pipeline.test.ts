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
    expect(decision.factsUsed.join(" ")).toContain("grant-owner-dm");
    expect(decision.factsUsed.join(" ")).toContain("actor-owner");
    expect(decision.factsUsed.join(" ")).toContain("session-owner-dm");
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
        interactionId: "interaction-report",
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
    expect(decision.sessionId).not.toBe("session-surface-decoy");
    expect(decision.factsUsed.join(" ")).toContain("interaction-report");
    expect(decision.factsUsed.join(" ")).toContain("report_result");
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
    expect(decision.factsUsed.join(" ")).toContain("system:cron");
    expect(decision.factsUsed.join(" ")).toContain("session-cron");
  });
});
