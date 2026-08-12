import { describe, expect, test } from "bun:test";
import { Communication, Dispatch } from "../../src/index.js";
import { Envelope } from "../../src/communication/envelope.js";

describe("Communication protocol schemas", () => {
  test("Envelope accepts normalized adapter/delivery fields", () => {
    const parsed = Envelope.parse({
      id: "env-1",
      direction: "inbound",
      surface: "discord",
      endpointId: "guild-1",
      channelId: "channel-1",
      threadId: "thread-1",
      externalMessageId: "message-1",
      replyToMessageId: "message-0",
      correlationToken: "token",
      actorId: "actor-1",
      payload: { text: "hello" },
      receivedAt: 1,
    });

    expect(parsed.surface).toBe("discord");
    expect(parsed.payload).toEqual({ text: "hello" });
  });

  test("PendingAsk captures durable correlation state", () => {
    const parsed = Communication.PendingAsk.Record.parse({
      id: "ask-1",
      originSessionId: "session-1",
      originRunId: "run-1",
      originActorKind: "worker",
      targetKind: "resident",
      correlation: { externalMessageId: "m-1", threadId: "t-1" },
      status: "open",
      createdAt: 1,
      updatedAt: 1,
    });

    expect(parsed.status).toBe("open");
    expect(parsed.correlation.threadId).toBe("t-1");
  });

  test("PendingInteraction captures worker-owned reply routing state", () => {
    const parsed = Communication.PendingInteraction.Record.parse({
      id: "pi-1",
      workerRunId: "run-1",
      sessionId: "session-1",
      endpointId: "telegram:seller-1",
      channelId: "telegram:dm",
      correlation: { replyToMessageId: "m-1", tokenHash: "tok-1" },
      allowedActions: ["report_result", "ask_clarification"],
      status: "open",
      createdAt: 1,
      updatedAt: 1,
      expiresAt: 100,
      followUpWindow: 60,
    });

    expect(parsed.allowedActions).toEqual(["report_result", "ask_clarification"]);
    expect(parsed.correlation.replyToMessageId).toBe("m-1");
  });

  test("Dispatch actor.message accepts structured correlation hints", () => {
    const parsed = Dispatch.Input.parse({
      action: Dispatch.Actions.ActorMessage,
      target: { kind: "surface", id: "telegram:dm" },
      payload: "reply",
      correlation: {
        endpointId: "telegram:seller-1",
        channelId: "telegram:dm",
        replyToMessageId: "m-1",
      },
    });

    expect(parsed.correlation).toMatchObject({ replyToMessageId: "m-1" });
  });

  test("WorkerGrant defaults external task creation to false", () => {
    const parsed = Communication.WorkerGrant.Record.parse({
      id: "grant-1",
      workerRunId: "run-1",
      status: "active",
      version: 1,
      allowedActions: ["resident.ask"],
      createdAt: 1,
      updatedAt: 1,
    });

    expect(parsed.canCreateExternalTasks).toBe(false);
  });
});
