import { describe, expect, it } from "bun:test";
import { Conversation, Ingress } from "@openomni/protocol";
import { resolveRoute, type RouteInbound, type RouteState } from "../../src/router/index.js";

const inbound = Object.freeze({
  traceId: "trace-conv",
  time: 1_000,
  id: "inbound-conv",
  surface: "telegram",
  mode: "direct",
  target: "resident",
}) satisfies RouteInbound;

function conversationRecord(overrides: Partial<Conversation.Record> = {}): Conversation.Record {
  return Conversation.Record.parse({
    id: "conv-1",
    contactId: "actor-contact",
    endpointId: "telegram:contact-1",
    ownerRef: { kind: "session", id: "session-owner" },
    openedBy: "delegate_ask",
    state: "open",
    policy: {
      expiresAt: 100_000,
      maxOutbound: 8,
      maxInbound: 32,
      onInboundCapBreach: "demote",
    },
    outboundUsed: 0,
    inboundUsed: 0,
    revision: 1,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  });
}

function stateWith(conversation: Conversation.Record | undefined): RouteState {
  return Object.freeze({
    wait: Object.freeze({ kind: "none" }),
    ...(conversation === undefined ? {} : { conversation }),
  }) satisfies RouteState;
}

describe("resolveRoute conversation stage", () => {
  it("routes an open conversation to the window owner's session with full access", () => {
    const decision = resolveRoute(inbound, stateWith(conversationRecord()));
    Ingress.Events.RoutingDecision.schema.parse(decision);
    expect(decision).toMatchObject({
      stage: "conversation",
      outcome: "route",
      target: "resident",
      sessionId: "session-owner",
      conversationId: "conv-1",
      inboundTreatment: "full_access",
    });
    expect(decision.factsUsed).toContain("conversation:conv-1");
    expect(decision.factsUsed).toContain("conversation.owner:session:session-owner");
  });

  it("demotes a cap-breached window to evidence_only", () => {
    const decision = resolveRoute(
      inbound,
      stateWith(conversationRecord({ inboundCapBreachedAt: 500 })),
    );
    Ingress.Events.RoutingDecision.schema.parse(decision);
    expect(decision).toMatchObject({
      stage: "conversation",
      outcome: "route",
      inboundTreatment: "evidence_only",
    });
    expect(decision.factsUsed).toContain("conversation.cap:breached");
  });

  it("a closed window falls through to the wait tier", () => {
    const decision = resolveRoute(
      inbound,
      stateWith(conversationRecord({ state: "closed", closedAt: 900, closedBy: "owner" })),
    );
    expect(decision.stage).toBe("channel_ceiling");
    expect(decision.outcome).toBe("block");
  });

  it("the blacklist still wins over an open conversation", () => {
    const decision = resolveRoute(
      inbound,
      Object.freeze({
        ...stateWith(conversationRecord()),
        blacklist: Object.freeze({ id: "bl-1", kind: "actor" }),
      }) satisfies RouteState,
    );
    expect(decision.stage).toBe("blacklist");
    expect(decision.outcome).toBe("drop");
  });

  it("an open conversation wins over a pending wait correlation", () => {
    const decision = resolveRoute(
      inbound,
      Object.freeze({
        ...stateWith(conversationRecord()),
        wait: Object.freeze({
          kind: "match",
          backing: "wait",
          key: "wait-1",
          recordId: "wait-1",
          owner: Object.freeze({ kind: "session", id: "session-wait" }),
          allowed: Object.freeze(["report_result"]),
        }),
      }) satisfies RouteState,
    );
    expect(decision.stage).toBe("conversation");
    expect(decision.sessionId).toBe("session-owner");
  });
});
