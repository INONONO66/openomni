import { beforeEach, describe, expect, test } from "bun:test";
import type { PolicyDecision, Dispatch as DispatchProtocol } from "@openomni/protocol";
import { PendingInteractionStore, Storage } from "@openomni/session";
import { DispatchRuntime } from "../../src/dispatch/runtime";
import { createWorkerRunFixture, resetDispatchTestState } from "./runtime-test-fixtures";

describe("DispatchRuntime", () => {
  beforeEach(resetDispatchTestState);

  test("routes actor.message through a matching PendingInteraction before authorization", async () => {
    const decisions: PolicyDecision[] = [];
    const runtime = new DispatchRuntime({
      onPolicyDecision: (decision) => {
        decisions.push(decision);
      },
    });
    let routedCommand: DispatchProtocol.Command | undefined;
    runtime.register("worker.complete", (command) => {
      routedCommand = command;
      return { output: { routed: true, sessionId: command.sessionId, runId: command.runId } };
    });

    Storage.initialize({ dbPath: ":memory:" });
    const session = await createWorkerRunFixture("run-pi");
    PendingInteractionStore.create({
      id: "pi-dispatch-1",
      workerRunId: "run-pi",
      sessionId: session.id,
      endpointId: "telegram:seller-1",
      channelId: "telegram:dm",
      correlation: { replyToMessageId: "message-out-1" },
      allowedActions: ["report_result"],
      expiresAt: Date.now() + 60_000,
      followUpWindow: 60_000,
    });

    const result = await runtime.submit(
      {
        action: "actor.message",
        target: { kind: "surface", id: "telegram:dm" },
        payload: {
          action: "report_result",
          result: {
            runId: "run-pi",
            sessionId: session.id,
            status: "succeeded",
            output: "SN-A2334",
            finishReason: "stop",
          },
        },
        correlation: {
          endpointId: "telegram:seller-1",
          channelId: "telegram:dm",
          replyToMessageId: "message-out-1",
        },
      },
      {
        actorKind: "unknown",
        actorId: "telegram:seller-1",
      },
    );

    const authority = decisions.find(
      (decision) => decision.policyId === "dispatch.default-authority",
    );
    expect(result.status).toBe("completed");
    expect(result.handler).toBe("worker.complete");
    expect(routedCommand?.action).toBe("worker.complete");
    expect(routedCommand?.target).toMatchObject({
      kind: "worker",
      runId: "run-pi",
      sessionId: session.id,
    });
    expect(routedCommand?.actor.trustTier).toBe("assigned_worker");
    expect(PendingInteractionStore.get("pi-dispatch-1")?.status).toBe("resolved");
    expect(authority?.factsUsed).toContain("effective_authority.pending_interaction_scope.allow");
    expect(authority?.factsUsed).toContain("pending_interaction.pi-dispatch-1");
  });

  test("routes PendingInteraction clarification messages to resident.ask", async () => {
    const runtime = new DispatchRuntime();
    let routedCommand: DispatchProtocol.Command | undefined;
    runtime.register("resident.ask", (command) => {
      routedCommand = command;
      return { output: "resident answer" };
    });

    Storage.initialize({ dbPath: ":memory:" });
    const session = await createWorkerRunFixture("run-pi-clarification");
    PendingInteractionStore.create({
      id: "pi-dispatch-clarification",
      workerRunId: "run-pi-clarification",
      sessionId: session.id,
      endpointId: "telegram:seller-clarification",
      channelId: "telegram:dm",
      correlation: { replyToMessageId: "message-out-clarification" },
      allowedActions: ["ask_clarification"],
      expiresAt: Date.now() + 60_000,
      followUpWindow: 60_000,
    });

    const result = await runtime.submit(
      {
        action: "actor.message",
        target: { kind: "surface", id: "telegram:dm" },
        payload: { action: "ask_clarification", question: "Which branch should I use?" },
        correlation: {
          endpointId: "telegram:seller-clarification",
          channelId: "telegram:dm",
          replyToMessageId: "message-out-clarification",
        },
      },
      {
        actorKind: "unknown",
        actorId: "telegram:seller-clarification",
      },
    );

    expect(result.status).toBe("completed");
    expect(result.handler).toBe("resident.ask");
    expect(routedCommand?.action).toBe("resident.ask");
    expect(routedCommand?.target).toMatchObject({
      kind: "resident",
      sessionId: session.id,
    });
    expect(routedCommand?.wait).toBe(true);
    expect(routedCommand?.actor.trustTier).toBe("assigned_worker");
    expect(PendingInteractionStore.get("pi-dispatch-clarification")?.status).toBe("resolved");
  });

  test("denies unmatched actor.message from unknown actors", async () => {
    const runtime = new DispatchRuntime();
    let called = false;
    runtime.register("actor.reply", () => {
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
        sessionId: "session-unmatched",
        runId: "run-unmatched",
        actorKind: "unknown",
        actorId: "telegram:seller-1",
      },
    );

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("dispatch.actor.required");
    expect(called).toBe(false);
  });
});
