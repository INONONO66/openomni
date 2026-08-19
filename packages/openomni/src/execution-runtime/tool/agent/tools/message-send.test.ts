import { describe, expect, test } from "bun:test";
import type { Gateway, Tool } from "@openomni/protocol";
import {
  createMessageSendTool,
  DEFAULT_EXPECT_REPLY_EXPIRES_IN_MS,
  type MessageSendToolOptions,
} from "./message-send.js";

const NOW = 1_700_000_000_000;

const sentReceipt = (input: Gateway.SendInput): Gateway.SendReceipt => ({
  kind: "sent",
  operation: "fire_and_forget",
  messageId: input.messageId,
  senderId: input.senderId,
  grantId: "grant-1",
  target: {
    actorId: input.target.actorId,
    endpointId: "qa:target-1",
    channel: "qa",
    externalId: "target-1",
  },
  at: input.at,
});

function makeCall(input: Record<string, unknown>): Tool.Call {
  return { id: "call-1", tool: "message.send", input };
}

const context = {
  traceContext: { traceId: "trace-message-send", sessionId: "session-caller", runId: "run-1" },
} as const;

function makeTool(overrides: Partial<MessageSendToolOptions> = {}) {
  const sends: Gateway.SendInput[] = [];
  const tool = createMessageSendTool({
    send: async (input) => {
      sends.push(input);
      return sentReceipt(input);
    },
    personaActorId: "actor:persona",
    now: () => NOW,
    ...overrides,
  });
  return { tool, sends };
}

describe("message.send tool", () => {
  test("declares the conservative posture: agent source, tier 2, delegation category, implicit sessionId", () => {
    const { tool } = makeTool();
    expect(tool.spec.name).toBe("message.send");
    expect(tool.riskTier).toBe(2);
    expect(tool.category).toBe("delegation");
    expect(tool.implicitInputs).toEqual({ sessionId: "sessionId" });
    // The implicit slot is stripped from the public schema — the model never
    // sees (or spoofs) the session identity field.
    const properties = (tool.spec.inputSchema as { properties: Record<string, unknown> })
      .properties;
    expect(properties.sessionId).toBeUndefined();
  });

  test("fire_and_forget builds a persona-sender SendInput without a waitSpec", async () => {
    const { tool, sends } = makeTool();

    const result = await tool.execute(
      makeCall({
        target: { actorId: "actor:target" },
        body: "hello",
        operation: "fire_and_forget",
      }),
      context,
    );

    expect(result.isError).toBeUndefined();
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      senderId: "actor:persona",
      target: { actorId: "actor:target" },
      operation: "fire_and_forget",
      body: "hello",
      at: NOW,
      traceId: "trace-message-send",
    });
    expect(sends[0]?.waitSpec).toBeUndefined();
    expect(JSON.parse(result.output)).toMatchObject({ kind: "sent", operation: "fire_and_forget" });
  });

  test("awaited expands expectReply to a full waitSpec owned by the calling session", async () => {
    const sends2: Gateway.SendInput[] = [];
    const { tool } = makeTool({
      send: async (input) => {
        sends2.push(input);
        const spec = input.waitSpec;
        if (spec === undefined) throw new Error("awaited send lost its waitSpec");
        return {
          kind: "sent",
          operation: "awaited",
          messageId: input.messageId,
          senderId: input.senderId,
          grantId: "grant-1",
          target: {
            actorId: input.target.actorId,
            endpointId: "qa:target-1",
            channel: "qa",
            externalId: "target-1",
          },
          wait: {
            id: spec.waitId,
            ownerRef: spec.ownerRef,
            originMessageId: input.messageId,
            correlation: { endpointId: "qa:target-1", replyToMessageId: input.messageId },
            allowedActions: [...spec.allowedActions],
            expectedResponders: [...spec.expectedResponders],
            resolutionPolicy: spec.resolutionPolicy,
            status: "open",
            partial: false,
            replies: [],
            revision: 1,
            expiresAt: spec.expiresAt,
            followUpWindow: spec.followUpWindow,
            createdAt: input.at,
            updatedAt: input.at,
          },
          at: input.at,
        };
      },
    });

    const result = await tool.execute(
      makeCall({
        target: { actorId: "actor:target", endpointId: "qa:target-1" },
        body: "deal?",
        operation: "awaited",
        expectReply: { expiresInMs: 60_000, followUpWindow: 5_000 },
        // Model-supplied sessionId is executor-stripped in production; here we
        // emulate the executor's injection of the calling session.
        sessionId: "session-caller",
      }),
      context,
    );

    expect(result.isError).toBeUndefined();
    expect(sends2).toHaveLength(1);
    const spec = sends2[0]?.waitSpec;
    expect(spec).toMatchObject({
      ownerRef: { kind: "session", id: "session-caller" },
      allowedActions: ["report_result"],
      expectedResponders: ["actor:target"],
      resolutionPolicy: "first_reply",
      expiresAt: NOW + 60_000,
      followUpWindow: 5_000,
    });
    const output = JSON.parse(result.output);
    expect(output).toMatchObject({ kind: "sent", operation: "awaited", waitId: spec?.waitId });
  });

  test("awaited without expectReply uses the declared defaults (24h deadline, report_result, window 0)", async () => {
    const sends: Gateway.SendInput[] = [];
    const { tool } = makeTool({
      send: async (input) => {
        sends.push(input);
        return { ...sentReceipt(input), operation: "fire_and_forget" };
      },
    });

    await tool.execute(
      makeCall({
        target: { actorId: "actor:target" },
        body: "ping",
        operation: "awaited",
        sessionId: "session-caller",
      }),
      context,
    );

    expect(sends[0]?.waitSpec).toMatchObject({
      allowedActions: ["report_result"],
      expiresAt: NOW + DEFAULT_EXPECT_REPLY_EXPIRES_IN_MS,
      followUpWindow: 0,
    });
  });

  test("a denial receipt is a RESULT the agent can reason about, not an error", async () => {
    const { tool } = makeTool({
      send: async (input) => ({
        kind: "denied",
        code: "ungranted",
        messageId: input.messageId,
        senderId: input.senderId,
        targetActorId: input.target.actorId,
        reason: "no active sender-target grant",
        at: input.at,
      }),
    });

    const result = await tool.execute(
      makeCall({ target: { actorId: "actor:target" }, body: "hi", operation: "fire_and_forget" }),
      context,
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.output)).toEqual({
      kind: "denied",
      code: "ungranted",
      reason: "no active sender-target grant",
      messageId: expect.any(String),
      targetActorId: "actor:target",
    });
  });

  test("persona unset fails closed with a typed error result — never a throw", async () => {
    const { tool, sends } = makeTool({ personaActorId: undefined });

    const result = await tool.execute(
      makeCall({ target: { actorId: "actor:target" }, body: "hi", operation: "fire_and_forget" }),
      context,
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("persona not configured");
    expect(sends).toHaveLength(0);
  });

  test("awaited without a calling session is refused (ownerRef needs the session)", async () => {
    const { tool, sends } = makeTool();

    const result = await tool.execute(
      makeCall({ target: { actorId: "actor:target" }, body: "hi", operation: "awaited" }),
      context,
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("calling session context");
    expect(sends).toHaveLength(0);
  });

  test("expectReply with fire_and_forget is an input error", async () => {
    const { tool, sends } = makeTool();

    const result = await tool.execute(
      makeCall({
        target: { actorId: "actor:target" },
        body: "hi",
        operation: "fire_and_forget",
        expectReply: { expiresInMs: 1_000 },
      }),
      context,
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('expectReply requires operation "awaited"');
    expect(sends).toHaveLength(0);
  });

  test("a traceless direct call is refused", async () => {
    const { tool, sends } = makeTool();

    const result = await tool.execute(
      makeCall({ target: { actorId: "actor:target" }, body: "hi", operation: "fire_and_forget" }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("run trace context");
    expect(sends).toHaveLength(0);
  });

  test("a throwing send port surfaces as an error result, not an unhandled rejection", async () => {
    const { tool } = makeTool({
      send: async () => {
        throw new Error("existing-agent messaging is not registered — sends fail closed");
      },
    });

    const result = await tool.execute(
      makeCall({ target: { actorId: "actor:target" }, body: "hi", operation: "fire_and_forget" }),
      context,
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("sends fail closed");
  });
});
