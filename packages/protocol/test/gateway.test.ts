import { describe, expect, test } from "bun:test";
import { Gateway } from "../src/gateway/index.js";

const message = {
  messageId: "m-1",
  traceId: "t-1",
  surfaceKey: "telegram:bot:chat:123",
  text: "hello",
};

const actorContext = {
  trustTier: "observer",
  inboundTreatment: "evidence_only",
  origin: { surface: "telegram", externalId: "u-9" },
} as const;

// Shared minimal routed-event residue: the agent-less DeliveredEvent every
// Deliver carries since the #707 seam flip.
const event = {
  id: "m-1",
  traceId: "t-1",
  surface: "telegram",
  mode: "direct",
  payload: "hello",
} as const;

// Shared minimal recorded route.decided fact (surface_default route arm of
// the RoutingDecision payload union).
const decision = {
  traceId: "t-1",
  time: 1_000,
  inboundId: "m-1",
  surface: "telegram",
  mode: "direct",
  reason: "surface default",
  factsUsed: [],
  stage: "surface_default",
  outcome: "route",
  target: "resident",
} as const;

describe("Gateway.Deliver", () => {
  test("parses a minimal anonymous delivery (no actorId, no waitContext)", () => {
    const parsed = Gateway.Deliver.parse({
      sessionId: "s-1",
      message,
      actorContext,
      event,
      decision,
    });
    expect(parsed.actorContext?.actorId).toBeUndefined();
    expect(parsed.waitContext).toBeUndefined();
  });

  test("parses a wait resumption with waitContext", () => {
    const parsed = Gateway.Deliver.parse({
      sessionId: "s-1",
      message: { ...message, replyToId: "m-0", threadId: "th-1" },
      actorContext: { ...actorContext, actorId: "a-7", trustTier: "collaborator" },
      waitContext: { waitId: "w-1", allowedAction: "report_result", engagementId: "e-1" },
      event,
      decision,
    });
    expect(parsed.waitContext?.waitId).toBe("w-1");
  });

  test("rejects unknown fields (strict at every level)", () => {
    expect(() =>
      Gateway.Deliver.parse({
        sessionId: "s-1",
        message,
        actorContext,
        event,
        decision,
        smuggled: true,
      }),
    ).toThrow();
    expect(() =>
      Gateway.Deliver.parse({
        sessionId: "s-1",
        message,
        actorContext: { ...actorContext, conductOverride: "admin" },
        event,
        decision,
      }),
    ).toThrow();
  });

  test("rejects 'drop' across the seam — a dropped message is never delivered", () => {
    expect(() =>
      Gateway.Deliver.parse({
        sessionId: "s-1",
        message,
        actorContext: { ...actorContext, inboundTreatment: "drop" },
        event,
        decision,
      }),
    ).toThrow();
  });

  test("nested strictness: message and waitContext reject unknown fields", () => {
    expect(() =>
      Gateway.Deliver.parse({
        sessionId: "s-1",
        message: { ...message, rawPlatformPayload: {} },
        actorContext,
        event,
        decision,
      }),
    ).toThrow();
    expect(() =>
      Gateway.Deliver.parse({
        sessionId: "s-1",
        message,
        actorContext,
        waitContext: { waitId: "w-1", allowedAction: "report_result", sessionPeek: true },
        event,
        decision,
      }),
    ).toThrow();
  });

  test("media reference needs a url or filename; kind alone is not addressable", () => {
    expect(() =>
      Gateway.Deliver.parse({
        sessionId: "s-1",
        message: { ...message, media: [{ kind: "image" }] },
        actorContext,
        event,
        decision,
      }),
    ).toThrow();
    const ok = Gateway.Deliver.parse({
      sessionId: "s-1",
      message: { ...message, media: [{ kind: "image", url: "https://x/y.png" }] },
      actorContext,
      event,
      decision,
    });
    expect(ok.message.media?.length).toBe(1);
  });

  test("rejects an out-of-enum treatment or trust tier", () => {
    expect(() =>
      Gateway.Deliver.parse({
        sessionId: "s-1",
        message,
        actorContext: { ...actorContext, inboundTreatment: "root_access" },
        event,
        decision,
      }),
    ).toThrow();
    expect(() =>
      Gateway.Deliver.parse({
        sessionId: "s-1",
        message,
        actorContext: { ...actorContext, trustTier: "manager_i_swear" },
        event,
        decision,
      }),
    ).toThrow();
  });

  test("an actorContext without origin is rejected — a tier verdict needs its taint root", () => {
    const { origin: _origin, ...withoutOrigin } = actorContext;
    expect(() =>
      Gateway.Deliver.parse({
        sessionId: "s-1",
        message,
        actorContext: withoutOrigin,
        event,
        decision,
      }),
    ).toThrow();
  });

  test("a Deliver without the recorded decision is rejected", () => {
    expect(() =>
      Gateway.Deliver.parse({ sessionId: "s-1", message, actorContext, event }),
    ).toThrow();
  });

  test("a parsed DeliveredEvent drops an extraneous embedded agent (brain material never crosses)", () => {
    const parsed = Gateway.DeliveredEvent.parse({
      ...event,
      agent: { model: { provider: "smuggler", id: "smuggled-model" } },
    });
    expect("agent" in parsed).toBe(false);
  });
});

describe("Gateway.SendInput (re-homed #215 vocabulary)", () => {
  const base = {
    messageId: "m-1",
    traceId: "t-1",
    senderId: "persona-1",
    target: { actorId: "seller-1" },
    body: "still available?",
    at: 1_000,
  };

  test("awaited requires a waitSpec", () => {
    expect(() => Gateway.SendInput.parse({ ...base, operation: "awaited" })).toThrow();
  });

  test("fire_and_forget forbids a waitSpec", () => {
    expect(() =>
      Gateway.SendInput.parse({
        ...base,
        operation: "fire_and_forget",
        waitSpec: {
          waitId: "w-1",
          ownerRef: { kind: "session", id: "s-1" },
          allowedActions: ["report_result"],
          expectedResponders: ["seller-1"],
          resolutionPolicy: "first_reply",
          expiresAt: 2_000,
          followUpWindow: 0,
        },
      }),
    ).toThrow();
  });

  test("awaited with a coherent waitSpec parses", () => {
    const parsed = Gateway.SendInput.parse({
      ...base,
      operation: "awaited",
      waitSpec: {
        waitId: "w-1",
        ownerRef: { kind: "session", id: "s-1" },
        allowedActions: ["report_result"],
        expectedResponders: ["seller-1"],
        resolutionPolicy: "first_reply",
        expiresAt: 2_000,
        followUpWindow: 0,
      },
    });
    expect(parsed.waitSpec?.waitId).toBe("w-1");
  });
});

describe("Gateway.SenderTargetGrant (instances)", () => {
  const standing = {
    id: "g-1",
    senderId: "persona-1",
    targetActorId: "seller-1",
    operations: ["awaited"],
  };

  test("an Owner-written standing grant parses without rule fields", () => {
    expect(Gateway.SenderTargetGrant.parse(standing).ruleId).toBeUndefined();
  });

  test("a rule-materialized instance requires replyScope AND expiresAt", () => {
    expect(() => Gateway.SenderTargetGrant.parse({ ...standing, ruleId: "r-1" })).toThrow();
    expect(() =>
      Gateway.SenderTargetGrant.parse({
        ...standing,
        ruleId: "r-1",
        replyScope: { surfaceKey: "junggonara:chat:777" },
      }),
    ).toThrow();
    const instance = Gateway.SenderTargetGrant.parse({
      ...standing,
      ruleId: "r-1",
      replyScope: { surfaceKey: "junggonara:chat:777" },
      expiresAt: 2_000,
    });
    expect(instance.replyScope?.surfaceKey).toBe("junggonara:chat:777");
  });

  test("replyScope without a ruleId is orphaned containment — rejected", () => {
    expect(() =>
      Gateway.SenderTargetGrant.parse({
        ...standing,
        replyScope: { surfaceKey: "junggonara:chat:777" },
      }),
    ).toThrow();
  });
});

describe("Gateway.AwaitSpec — quorum coherence is deliberately NOT refined here", () => {
  test("quorum without resolutionPolicy 'quorum' still parses at spec level (#215 rule 4: Wait.Record.parse at WaitStore.create is the one enforcement layer)", () => {
    const spec = Gateway.AwaitSpec.parse({
      waitId: "w-1",
      ownerRef: { kind: "session", id: "s-1" },
      allowedActions: ["report_result"],
      expectedResponders: ["a", "b"],
      resolutionPolicy: "first_reply",
      quorum: { expected: 2, threshold: 1 },
      expiresAt: 2_000,
      followUpWindow: 0,
    });
    expect(spec.quorum?.expected).toBe(2);
  });
});

describe("Gateway.ReplyGrantRule", () => {
  const rule = {
    id: "r-1",
    senderId: "persona-1",
    surface: "junggonara",
    operations: ["awaited"],
    instanceTtlMs: 86_400_000,
    maxLiveInstances: 5,
    createdBy: "owner",
  };

  test("parses an Owner-written rule row", () => {
    expect(Gateway.ReplyGrantRule.parse(rule).maxLiveInstances).toBe(5);
  });

  test("rejects a zero or negative live-instance cap (farming bound)", () => {
    expect(() => Gateway.ReplyGrantRule.parse({ ...rule, maxLiveInstances: 0 })).toThrow();
    expect(() => Gateway.ReplyGrantRule.parse({ ...rule, instanceTtlMs: -1 })).toThrow();
  });
});

describe("Gateway.WaitControl", () => {
  test("parses cancel and expire_now, rejects other verbs", () => {
    expect(
      Gateway.WaitControl.parse({ waitId: "w-1", action: "cancel", reason: "engagement aborted" })
        .action,
    ).toBe("cancel");
    expect(
      Gateway.WaitControl.parse({ waitId: "w-1", action: "expire_now", reason: "term crossed" })
        .action,
    ).toBe("expire_now");
    expect(() =>
      Gateway.WaitControl.parse({ waitId: "w-1", action: "extend", reason: "nope" }),
    ).toThrow();
  });

  test("requires a reason (auditability)", () => {
    expect(() => Gateway.WaitControl.parse({ waitId: "w-1", action: "cancel" })).toThrow();
  });
});
