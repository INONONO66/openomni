import { describe, expect, it } from "bun:test";
import { Ingress } from "@openomni/protocol";
import { resolveRoute, type RouteInbound, type RouteState } from "../../src/router/index.js";
import { requireRoutedDecision } from "../../src/router/routing-execution.js";

const inbound = Object.freeze({
  traceId: "trace-precedence",
  time: 4_000,
  id: "inbound-precedence",
  surface: "discord",
  mode: "direct",
  target: "resident",
  requestedAction: "report_result",
}) satisfies RouteInbound;

const matchedWait = Object.freeze({
  kind: "match",
  backing: "wait",
  key: "wait:wait-match",
  recordId: "wait-match",
  owner: Object.freeze({ kind: "session", id: "session-wait" }),
  allowed: Object.freeze(["report_result"]),
});

const trustedChannel = Object.freeze({
  id: "grant-trusted",
  kind: "trusted_channel",
  inboundTreatment: "full_access",
  defaultTier: "observer",
});

const registeredActor = Object.freeze({
  id: "actor-registered",
  trustTier: "collaborator",
  registered: true,
});

interface PrecedenceCase {
  readonly name: string;
  readonly state: RouteState;
  readonly stage: Ingress.RoutingDecisionPayload["stage"];
  readonly outcome: Ingress.RoutingDecisionPayload["outcome"];
  readonly sessionId?: string;
}

const precedenceCases = Object.freeze([
  {
    name: "blacklist before wait correlation",
    state: Object.freeze({
      blacklist: Object.freeze({ id: "blacklist-actor", kind: "actor", reason: "revoked" }),
      wait: matchedWait,
      channel: trustedChannel,
      actor: registeredActor,
      surfaceSessionId: "session-surface",
    }),
    stage: "blacklist",
    outcome: "drop",
  },
  {
    name: "wait correlation before channel ceiling",
    state: Object.freeze({
      wait: matchedWait,
      channel: Object.freeze({
        id: "grant-blocked",
        kind: "blocked_channel",
        inboundTreatment: "drop",
      }),
      actor: registeredActor,
      surfaceSessionId: "session-surface",
    }),
    stage: "wait_correlation",
    outcome: "route",
    // The wait OWNER's session wins over the conflicting surface-key mapping.
    sessionId: "session-wait",
  },
  {
    name: "channel ceiling before actor identity",
    state: Object.freeze({
      wait: Object.freeze({ kind: "none" }),
      channel: Object.freeze({
        id: "grant-blocked",
        kind: "blocked_channel",
        inboundTreatment: "drop",
      }),
      actor: registeredActor,
      surfaceSessionId: "session-surface",
    }),
    stage: "channel_ceiling",
    outcome: "block",
  },
  {
    name: "actor identity before surface default",
    state: Object.freeze({
      wait: Object.freeze({ kind: "none" }),
      channel: Object.freeze({
        id: "grant-no-default",
        kind: "trusted_channel",
        inboundTreatment: "full_access",
      }),
      surfaceSessionId: "session-surface",
    }),
    stage: "actor_identity",
    outcome: "block",
  },
  {
    name: "surface default after all earlier stages pass",
    state: Object.freeze({
      wait: Object.freeze({ kind: "none" }),
      channel: trustedChannel,
      actor: registeredActor,
      surfaceSessionId: "session-surface",
    }),
    stage: "surface_default",
    outcome: "route",
    sessionId: "session-surface",
  },
]) satisfies readonly PrecedenceCase[];

describe("resolveRoute precedence", () => {
  for (const testCase of precedenceCases) {
    it(testCase.name, () => {
      // Given
      const state = testCase.state;

      // When
      const decision = Ingress.Events.RoutingDecision.schema.parse(resolveRoute(inbound, state));

      // Then
      expect(decision.stage).toBe(testCase.stage);
      expect(decision.outcome).toBe(testCase.outcome);
      if (testCase.sessionId !== undefined) {
        expect(decision.sessionId).toBe(testCase.sessionId);
      }
    });
  }

  it("preserves fail-closed ambiguity from the winning wait-correlation level", () => {
    // Given
    const state = Object.freeze({
      wait: Object.freeze({
        kind: "ambiguous",
        candidateInteractionIds: Object.freeze(["wait:wait-a", "wait:wait-b"]),
      }),
      channel: trustedChannel,
      actor: registeredActor,
      surfaceSessionId: "session-surface",
    }) satisfies RouteState;

    // When
    const decision = Ingress.Events.RoutingDecision.schema.parse(resolveRoute(inbound, state));

    // Then
    expect(decision).toMatchObject({
      stage: "wait_correlation",
      outcome: "ambiguous",
      candidateInteractionIds: ["wait:wait-a", "wait:wait-b"],
    });
    expect(decision.sessionId).toBeUndefined();
  });

  it("does not produce an execution target for blocked or missing channel grants", () => {
    // Given
    const states = Object.freeze([
      Object.freeze({
        wait: Object.freeze({ kind: "none" }),
        channel: Object.freeze({
          id: "grant-blocked",
          kind: "blocked_channel",
          inboundTreatment: "drop",
        }),
        actor: registeredActor,
        surfaceSessionId: "session-surface",
      }),
      Object.freeze({
        wait: Object.freeze({ kind: "none" }),
        actor: registeredActor,
        surfaceSessionId: "session-surface",
      }),
    ]) satisfies readonly RouteState[];

    // When
    const decisions = states.map((state) => resolveRoute(inbound, state));

    // Then
    expect(decisions.map((decision) => decision.outcome)).toEqual(["block", "block"]);
    expect(decisions.every((decision) => decision.target === undefined)).toBe(true);
    expect(decisions.every((decision) => decision.sessionId === undefined)).toBe(true);
  });

  it("refuses blacklist, block and ambiguity before the inbox body", () => {
    const decisions = [
      resolveRoute(inbound, {
        blacklist: { id: "blacklist-actor", kind: "actor", reason: "revoked" },
        wait: matchedWait,
        channel: trustedChannel,
        actor: registeredActor,
      }),
      resolveRoute(inbound, {
        wait: { kind: "none" },
        actor: registeredActor,
      }),
      resolveRoute(inbound, {
        wait: {
          kind: "ambiguous",
          candidateInteractionIds: ["wait:wait-a", "wait:wait-b"],
        },
        channel: trustedChannel,
        actor: registeredActor,
      }),
    ].map((decision) => Ingress.Events.RoutingDecision.schema.parse(decision));

    const accepted = decisions[0];
    expect(accepted).toBeDefined();
    if (accepted === undefined || accepted.stage !== "blacklist" || accepted.outcome !== "drop") {
      throw new TypeError("missing accepted decision fixture");
    }
    const codes = decisions.map((decision) => {
      try {
        requireRoutedDecision(decision);
        return "accepted";
      } catch (error) {
        return (error as { readonly code?: string }).code;
      }
    });
    expect(codes).toEqual(["route_blocked", "route_blocked", "route_ambiguous"]);
  });

  it("classifies a blocked channel through the typed routing error", () => {
    const decision = Ingress.Events.RoutingDecision.schema.parse(
      resolveRoute(inbound, {
        wait: { kind: "none" },
        channel: {
          id: "grant-blocked",
          kind: "blocked_channel",
          inboundTreatment: "drop",
        },
      }),
    );

    let code: string | undefined;
    try {
      requireRoutedDecision(decision);
    } catch (error) {
      code = (error as { readonly code?: string }).code;
    }
    expect(code).toBe("route_blocked");
  });

  it("classifies an actor-identity block through the typed routing error", () => {
    const decision = Ingress.Events.RoutingDecision.schema.parse(
      resolveRoute(inbound, {
        wait: { kind: "none" },
        channel: {
          id: "grant-no-default",
          kind: "trusted_channel",
          inboundTreatment: "full_access",
        },
      }),
    );

    let code: string | undefined;
    try {
      requireRoutedDecision(decision);
    } catch (error) {
      code = (error as { readonly code?: string }).code;
    }
    expect(code).toBe("route_blocked");
  });

  it("preserves evidence_only treatment while routing a broadcast channel", () => {
    // Given
    const state = Object.freeze({
      wait: Object.freeze({ kind: "none" }),
      channel: Object.freeze({
        id: "grant-broadcast",
        kind: "broadcast_channel",
        inboundTreatment: "evidence_only",
        defaultTier: "observer",
      }),
      surfaceSessionId: "session-surface",
    }) satisfies RouteState;

    // When
    const decision = Ingress.Events.RoutingDecision.schema.parse(resolveRoute(inbound, state));

    // Then
    expect(decision).toMatchObject({
      stage: "surface_default",
      outcome: "route",
      target: "resident",
      sessionId: "session-surface",
      inboundTreatment: "evidence_only",
    });
    expect(decision.factsUsed).toContain("channel:grant-broadcast");
    expect(decision.factsUsed).toContain("channel.treatment:evidence_only");
  });

  it("blocks an unknown actor when the channel supplies no default tier", () => {
    // Given
    const state = Object.freeze({
      wait: Object.freeze({ kind: "none" }),
      channel: Object.freeze({
        id: "grant-no-default",
        kind: "trusted_channel",
        inboundTreatment: "full_access",
      }),
      surfaceSessionId: "session-surface",
    }) satisfies RouteState;

    // When
    const decision = Ingress.Events.RoutingDecision.schema.parse(resolveRoute(inbound, state));

    // Then
    expect(decision.stage).toBe("actor_identity");
    expect(decision.outcome).toBe("block");
    expect(decision.actorId).toBeUndefined();
    expect(decision.trustTier).toBeUndefined();
    expect(decision.sessionId).toBeUndefined();
  });
});
