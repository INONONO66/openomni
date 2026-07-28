import { beforeEach, describe, expect, test } from "bun:test";
import { BlacklistStore, PendingInteractionStore, Storage } from "@openomni/session";
import { DispatchRuntime } from "../../src/dispatch/runtime";
import { createWorkerRunFixture, resetDispatchTestState } from "./runtime-test-fixtures";

describe("DispatchRuntime", () => {
  beforeEach(resetDispatchTestState);

  test("blocks blacklisted PendingInteraction endpoint matches before handler execution", async () => {
    const runtime = new DispatchRuntime();
    let called = false;
    runtime.register("actor.reply", () => {
      called = true;
      return { output: "should not route" };
    });

    Storage.initialize({ dbPath: ":memory:" });
    BlacklistStore.put({
      id: "bl-pi-endpoint",
      kind: "endpoint",
      value: "telegram:blocked-seller",
      reason: "blocked pending interaction endpoint",
      createdBy: "act_owner",
    });
    const session = await createWorkerRunFixture("run-pi-blacklisted-endpoint");
    PendingInteractionStore.create({
      id: "pi-dispatch-blacklisted-endpoint",
      workerRunId: "run-pi-blacklisted-endpoint",
      sessionId: session.id,
      endpointId: "telegram:blocked-seller",
      channelId: "telegram:dm",
      correlation: { replyToMessageId: "message-out-bl-endpoint" },
      allowedActions: ["report_result"],
      expiresAt: Date.now() + 60_000,
      followUpWindow: 60_000,
    });

    const result = await runtime.submit(
      {
        action: "actor.message",
        target: { kind: "surface", id: "telegram:dm" },
        payload: "SN-A2334",
        correlation: {
          endpointId: "telegram:blocked-seller",
          channelId: "telegram:dm",
          replyToMessageId: "message-out-bl-endpoint",
        },
      },
      {
        actorKind: "unknown",
        actorId: "telegram:blocked-seller",
      },
    );

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("blocked pending interaction endpoint");
    expect(PendingInteractionStore.get("pi-dispatch-blacklisted-endpoint")?.status).toBe("open");
    expect(called).toBe(false);
  });

  test("blocks blacklisted PendingInteraction channel matches before handler execution", async () => {
    const runtime = new DispatchRuntime();
    let called = false;
    runtime.register("actor.reply", () => {
      called = true;
      return { output: "should not route" };
    });

    Storage.initialize({ dbPath: ":memory:" });
    BlacklistStore.put({
      id: "bl-pi-channel",
      kind: "channel",
      value: "telegram:blocked-dm",
      reason: "blocked pending interaction channel",
      createdBy: "act_owner",
    });
    const session = await createWorkerRunFixture("run-pi-blacklisted-channel");
    PendingInteractionStore.create({
      id: "pi-dispatch-blacklisted-channel",
      workerRunId: "run-pi-blacklisted-channel",
      sessionId: session.id,
      endpointId: "telegram:seller-4",
      channelId: "telegram:blocked-dm",
      correlation: { replyToMessageId: "message-out-bl-channel" },
      allowedActions: ["report_result"],
      expiresAt: Date.now() + 60_000,
      followUpWindow: 60_000,
    });

    const result = await runtime.submit(
      {
        action: "actor.message",
        target: { kind: "surface", id: "telegram:blocked-dm" },
        payload: "SN-A2334",
        correlation: {
          endpointId: "telegram:seller-4",
          channelId: "telegram:blocked-dm",
          replyToMessageId: "message-out-bl-channel",
        },
      },
      {
        actorKind: "unknown",
        actorId: "telegram:seller-4",
      },
    );

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("blocked pending interaction channel");
    expect(PendingInteractionStore.get("pi-dispatch-blacklisted-channel")?.status).toBe("open");
    expect(called).toBe(false);
  });

  test("denies forged direct actor.reply labels without a routed PendingInteraction match", async () => {
    const runtime = new DispatchRuntime();
    let called = false;
    runtime.register("actor.reply", () => {
      called = true;
      return { output: "should not route" };
    });

    Storage.initialize({ dbPath: ":memory:" });
    const session = await createWorkerRunFixture("run-pi-forged");
    PendingInteractionStore.create({
      id: "pi-dispatch-forged",
      workerRunId: "run-pi-forged",
      sessionId: session.id,
      endpointId: "telegram:seller-forged",
      channelId: "telegram:dm",
      correlation: { replyToMessageId: "message-out-forged" },
      allowedActions: ["report_result"],
      expiresAt: Date.now() + 60_000,
      followUpWindow: 60_000,
    });

    const result = await runtime.submit(
      {
        action: "actor.reply",
        target: { kind: "worker", runId: "run-pi-forged", sessionId: session.id },
        payload: "SN-A2334",
      },
      {
        actorKind: "worker",
        actorId: "telegram:seller-forged",
        sessionId: session.id,
        runId: "run-pi-forged",
        trustTier: "assigned_worker",
        labels: ["pending_interaction.pi-dispatch-forged"],
      },
    );

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("dispatch.pending_interaction.match.required");
    expect(PendingInteractionStore.get("pi-dispatch-forged")?.status).toBe("open");
    expect(called).toBe(false);
  });
});
