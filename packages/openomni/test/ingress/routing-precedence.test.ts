import { describe, expect, it } from "bun:test";
import { IngressEvent, type RoutingDecisionPayload } from "@openomni/protocol";
import { resolveRoute, type RouteInbound, type RouteState } from "../../src/ingress/index";

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
  interactionId: "interaction-match",
  sessionId: "session-wait",
  runId: "run-wait",
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
  readonly stage: RoutingDecisionPayload["stage"];
  readonly outcome: RoutingDecisionPayload["outcome"];
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
  },
]) satisfies readonly PrecedenceCase[];

describe("resolveRoute precedence", () => {
  for (const testCase of precedenceCases) {
    it(testCase.name, () => {
      // Given
      const state = testCase.state;

      // When
      const decision = IngressEvent.RoutingDecision.schema.parse(resolveRoute(inbound, state));

      // Then
      expect(decision.stage).toBe(testCase.stage);
      expect(decision.outcome).toBe(testCase.outcome);
    });
  }

  it("does not choose among ambiguous wait candidates", () => {
    // Given
    const state = Object.freeze({
      wait: Object.freeze({
        kind: "ambiguous",
        candidateInteractionIds: Object.freeze(["interaction-a", "interaction-b"]),
      }),
      channel: trustedChannel,
      actor: registeredActor,
      surfaceSessionId: "session-surface",
    }) satisfies RouteState;

    // When
    const decision = IngressEvent.RoutingDecision.schema.parse(resolveRoute(inbound, state));

    // Then
    expect(decision).toMatchObject({
      stage: "wait_correlation",
      outcome: "ambiguous",
      candidateInteractionIds: ["interaction-a", "interaction-b"],
    });
    expect(decision.pendingInteractionId).toBeUndefined();
    expect(decision.sessionId).toBeUndefined();
    expect(decision.runId).toBeUndefined();
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
    expect(decisions.every((decision) => decision.runId === undefined)).toBe(true);
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
    const decision = IngressEvent.RoutingDecision.schema.parse(resolveRoute(inbound, state));

    // Then
    expect(decision).toMatchObject({
      stage: "surface_default",
      outcome: "route",
      target: "resident",
      sessionId: "session-surface",
      inboundTreatment: "evidence_only",
    });
    expect(decision.factsUsed.join(" ")).toContain("grant-broadcast");
    expect(decision.factsUsed.join(" ")).toContain("evidence_only");
    expect(decision.runId).toBeUndefined();
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
    const decision = IngressEvent.RoutingDecision.schema.parse(resolveRoute(inbound, state));

    // Then
    expect(decision.stage).toBe("actor_identity");
    expect(decision.outcome).toBe("block");
    expect(decision.actorId).toBeUndefined();
    expect(decision.trustTier).toBeUndefined();
    expect(decision.sessionId).toBeUndefined();
  });
});
