import { describe, expect, test } from "bun:test";
import { Ingress } from "../src/ingress/index.js";
import type { RoutingDecisionPayload } from "../src/event/ingress.js";

const decision = (over: Partial<RoutingDecisionPayload> = {}): RoutingDecisionPayload =>
  ({
    traceId: "t-1",
    time: 1,
    inboundId: "in-1",
    surface: "telegram",
    stage: "surface_default",
    outcome: "route",
    target: "resident",
    reason: "ok",
    factsUsed: [],
    ...over,
  }) as RoutingDecisionPayload;

describe("Ingress.routeStreamId", () => {
  test("scopes the key by surface:workspace:channel:id", () => {
    expect(
      Ingress.routeStreamId({ surface: "telegram", workspace: "w", channel: "c", id: "42" }),
    ).toBe("route:telegram:w:c:42");
  });

  test("URI-encodes each component so a ':' inside one field cannot forge another scope", () => {
    // channel "C1" + id "x:5" must NOT collide with channel "C1:x" + id "5".
    const a = Ingress.routeStreamId({ surface: "s", channel: "C1", id: "x:5" });
    const b = Ingress.routeStreamId({ surface: "s", channel: "C1:x", id: "5" });
    expect(a).not.toBe(b);
    expect(a).toContain("x%3A5");
  });

  test("absent workspace/channel encode to empty segments (stable arity)", () => {
    expect(Ingress.routeStreamId({ surface: "tui", id: "1" })).toBe("route:tui:::1");
  });

  test("correction stream shares the scope on a distinct class prefix", () => {
    const scope = { surface: "telegram", channel: "c", id: "42" } as const;
    expect(Ingress.routeCorrectionStreamId(scope)).toBe("route_correction:telegram::c:42");
    expect(Ingress.routeCorrectionStreamId(scope)).not.toBe(Ingress.routeStreamId(scope));
  });
});

describe("Ingress.routeDecidedFact / routeNotDeliveredFact", () => {
  test("builds the route.decided append input verbatim", () => {
    const d = decision();
    const fact = Ingress.routeDecidedFact("route:telegram:::in-1", d);
    expect(fact).toEqual({
      streamId: "route:telegram:::in-1",
      type: Ingress.ROUTE_DECIDED_FACT_TYPE,
      data: d,
    });
    expect(Ingress.ROUTE_DECIDED_FACT_TYPE).toBe("route.decided");
  });

  test("builds the route.not_delivered correction input", () => {
    const fact = Ingress.routeNotDeliveredFact("route_correction:telegram:::in-1", {
      inboundId: "in-1",
      reason: "non-responder reply rejected",
    });
    expect(fact.type).toBe(Ingress.ROUTE_NOT_DELIVERED_FACT_TYPE);
    expect(Ingress.ROUTE_NOT_DELIVERED_FACT_TYPE).toBe("route.not_delivered");
  });
});

describe("Ingress.routeDecisionsEquivalent", () => {
  test("equal on execution-shaping fields → equivalent (ignores delivery-local traceId/time/reason)", () => {
    expect(
      Ingress.routeDecisionsEquivalent(
        decision({ traceId: "a", time: 1, reason: "x", factsUsed: ["p"] }),
        decision({ traceId: "b", time: 2, reason: "y", factsUsed: ["q"] }),
      ),
    ).toBe(true);
  });

  test.each([
    ["stage", { stage: "wait_correlation" as const }],
    ["outcome", { outcome: "block" as const }],
    ["target", { target: "worker" }],
    ["sessionId", { sessionId: "s-2" }],
    ["runId", { runId: "r-2" }],
    ["pendingInteractionId", { pendingInteractionId: "pi-2" }],
  ])("divergent %s → not equivalent (redelivery fails closed)", (_f, over) => {
    expect(Ingress.routeDecisionsEquivalent(decision(), decision(over))).toBe(false);
  });
});
