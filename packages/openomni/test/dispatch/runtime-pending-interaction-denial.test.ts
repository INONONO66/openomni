import { beforeEach, describe, expect, test } from "bun:test";
import { PendingInteractionStore, Storage } from "@openomni/session";
import { DispatchRuntime } from "../../src/dispatch/runtime";
import {
  createWorkerRunFixture,
  resetDispatchTestState,
  seedPendingInteraction,
} from "./runtime-test-fixtures";

describe("DispatchRuntime", () => {
  beforeEach(resetDispatchTestState);

  test("denies unmatched actor.message even from otherwise trusted actors", async () => {
    const runtime = new DispatchRuntime();
    let called = false;
    runtime.register("actor.message", () => {
      called = true;
      return { output: "should not route" };
    });

    Storage.initialize({ dbPath: ":memory:" });
    const result = await runtime.submit(
      {
        action: "actor.message",
        target: { kind: "surface", id: "telegram:dm" },
        payload: "hello",
        correlation: {
          endpointId: "telegram:seller-1",
          channelId: "telegram:dm",
          replyToMessageId: "unknown-message",
        },
      },
      {
        sessionId: "session-unmatched-trusted",
        runId: "run-unmatched-trusted",
        actorKind: "resident",
        actorId: "resident:main",
      },
    );

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("dispatch.pending_interaction.required");
    expect(called).toBe(false);
  });

  test("denies actor.message from unknown actors before PendingInteraction action checks", async () => {
    const runtime = new DispatchRuntime();
    let called = false;
    runtime.register("actor.message", () => {
      called = true;
      return { output: "should not route" };
    });

    Storage.initialize({ dbPath: ":memory:" });
    const session = await createWorkerRunFixture("run-pi-disallowed");
    seedPendingInteraction({
      id: "pi-dispatch-disallowed",
      workerRunId: "run-pi-disallowed",
      sessionId: session.id,
      endpointId: "telegram:seller-2",
      channelId: "telegram:dm",
      correlation: { replyToMessageId: "message-out-2" },
      allowedActions: ["ask_clarification"],
      expiresAt: Date.now() + 60_000,
      followUpWindow: 60_000,
    });

    const result = await runtime.submit(
      {
        action: "actor.message",
        target: { kind: "surface", id: "telegram:dm" },
        payload: "SN-A2334",
        correlation: {
          endpointId: "telegram:seller-2",
          channelId: "telegram:dm",
          replyToMessageId: "message-out-2",
        },
      },
      {
        sessionId: "session-disallowed",
        runId: "run-disallowed",
        actorKind: "unknown",
        actorId: "telegram:seller-2",
      },
    );

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("dispatch.actor.required");
    expect(PendingInteractionStore.get("pi-dispatch-disallowed")?.status).toBe("open");
    expect(called).toBe(false);
  });

  test("denies disallowed actor.message even from otherwise trusted actors", async () => {
    const runtime = new DispatchRuntime();
    let called = false;
    runtime.register("actor.message", () => {
      called = true;
      return { output: "should not route" };
    });

    Storage.initialize({ dbPath: ":memory:" });
    const session = await createWorkerRunFixture("run-pi-disallowed-trusted");
    seedPendingInteraction({
      id: "pi-dispatch-disallowed-trusted",
      workerRunId: "run-pi-disallowed-trusted",
      sessionId: session.id,
      endpointId: "telegram:seller-3",
      channelId: "telegram:dm",
      correlation: { replyToMessageId: "message-out-3" },
      allowedActions: ["ask_clarification"],
      expiresAt: Date.now() + 60_000,
      followUpWindow: 60_000,
    });

    const result = await runtime.submit(
      {
        action: "actor.message",
        target: { kind: "surface", id: "telegram:dm" },
        payload: "SN-A2334",
        correlation: {
          endpointId: "telegram:seller-3",
          channelId: "telegram:dm",
          replyToMessageId: "message-out-3",
        },
      },
      {
        sessionId: "session-disallowed-trusted",
        runId: "run-disallowed-trusted",
        actorKind: "resident",
        actorId: "resident:main",
      },
    );

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("dispatch.pending_interaction.required");
    expect(PendingInteractionStore.get("pi-dispatch-disallowed-trusted")?.status).toBe("open");
    expect(called).toBe(false);
  });
});
