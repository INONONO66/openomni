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

describe("Gateway.Deliver", () => {
  test("parses a minimal anonymous delivery (no actorId, no waitContext)", () => {
    const parsed = Gateway.Deliver.parse({
      sessionId: "s-1",
      message,
      actorContext,
    });
    expect(parsed.actorContext.actorId).toBeUndefined();
    expect(parsed.waitContext).toBeUndefined();
  });

  test("parses a wait resumption with waitContext", () => {
    const parsed = Gateway.Deliver.parse({
      sessionId: "s-1",
      message: { ...message, replyToId: "m-0", threadId: "th-1" },
      actorContext: { ...actorContext, actorId: "a-7", trustTier: "collaborator" },
      waitContext: { waitId: "w-1", allowedAction: "report_result", engagementId: "e-1" },
    });
    expect(parsed.waitContext?.waitId).toBe("w-1");
  });

  test("rejects unknown fields (strict at every level)", () => {
    expect(() =>
      Gateway.Deliver.parse({
        sessionId: "s-1",
        message,
        actorContext,
        smuggled: true,
      }),
    ).toThrow();
    expect(() =>
      Gateway.Deliver.parse({
        sessionId: "s-1",
        message,
        actorContext: { ...actorContext, conductOverride: "admin" },
      }),
    ).toThrow();
  });

  test("rejects an out-of-enum treatment or trust tier", () => {
    expect(() =>
      Gateway.Deliver.parse({
        sessionId: "s-1",
        message,
        actorContext: { ...actorContext, inboundTreatment: "root_access" },
      }),
    ).toThrow();
    expect(() =>
      Gateway.Deliver.parse({
        sessionId: "s-1",
        message,
        actorContext: { ...actorContext, trustTier: "manager_i_swear" },
      }),
    ).toThrow();
  });

  test("origin is mandatory — a delivery without a taint root is invalid", () => {
    const { origin: _origin, ...withoutOrigin } = actorContext;
    expect(() =>
      Gateway.Deliver.parse({ sessionId: "s-1", message, actorContext: withoutOrigin }),
    ).toThrow();
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
