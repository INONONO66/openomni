import { describe, expect, it } from "bun:test";
import { Ingress } from "@openomni/protocol";
import {
  resolveInternalRoute,
  type InternalRouteInbound,
  type InternalRouteState,
} from "../../src/ingress/internal-route";

function parseDecision(inbound: InternalRouteInbound, state: InternalRouteState) {
  const decision = resolveInternalRoute(inbound, state);
  return Ingress.Events.RoutingDecision.schema.parse(decision);
}

describe("resolveInternalRoute", () => {
  it("routes system cron through the same surface-default decision", () => {
    // Given
    const inbound = Object.freeze({
      traceId: "trace-cron",
      time: 3_000,
      id: "inbound-cron",
      surface: "cron",
      mode: "internal",
      target: "resident",
    }) satisfies InternalRouteInbound;
    const state = Object.freeze({
      surfaceSessionId: "session-cron",
      systemActorId: "system:cron",
    }) satisfies InternalRouteState;

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
