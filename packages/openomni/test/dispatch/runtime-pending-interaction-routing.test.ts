import { beforeEach, describe, expect, test } from "bun:test";
import type { PolicyDecision, Dispatch as DispatchProtocol } from "@openomni/protocol";
import { PendingInteractionStore, Storage } from "@openomni/session";
import { DispatchRuntime, submitPinnedPendingInteraction } from "../../src/dispatch/runtime";
import {
  createWorkerRunFixture,
  resetDispatchTestState,
  seedPendingInteraction,
} from "./runtime-test-fixtures";

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
    seedPendingInteraction({
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
          workItemHash: "unrelated-work-item",
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
    expect(routedCommand?.payload).toEqual({
      result: {
        runId: "run-pi",
        sessionId: session.id,
        status: "succeeded",
        output: "SN-A2334",
        finishReason: "stop",
      },
    });
    expect(routedCommand?.actor.trustTier).toBe("assigned_worker");
    // #548: the store is frozen — routing leaves the legacy row as persisted.
    expect(PendingInteractionStore.get("pi-dispatch-1")?.status).toBe("open");
    expect(authority?.factsUsed).toContain("effective_authority.pending_interaction_scope.allow");
    expect(authority?.factsUsed).toContain("pending_interaction.pi-dispatch-1");
  });

  test("scoped fallback routes a token-mismatch correlation whose sender proves the endpoint", async () => {
    // INTENTIONAL (#215 single-lookup cutover): the unified correlation
    // lookup widened the legacy dispatch path — a correlation whose tokenHash
    // matches nothing no longer dead-ends; it falls back to the scoped
    // endpoint+channel level and still finds the row. The bearer token is one
    // correlation precedence level, not a credential gate: authorization for
    // legacy PendingInteraction rows is carried by the sender matcher
    // (endpoint proof / pinned actor identity), which this sender satisfies.
    const runtime = new DispatchRuntime();
    let routedCommand: DispatchProtocol.Command | undefined;
    runtime.register("worker.complete", (command) => {
      routedCommand = command;
      return { output: "accepted" };
    });

    Storage.initialize({ dbPath: ":memory:" });
    const session = await createWorkerRunFixture("run-pi-token-mismatch");
    seedPendingInteraction({
      id: "pi-dispatch-token-mismatch",
      workerRunId: "run-pi-token-mismatch",
      sessionId: session.id,
      endpointId: "telegram:seller-1",
      channelId: "telegram:dm",
      correlation: { tokenHash: "token-right" },
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
            runId: "run-pi-token-mismatch",
            sessionId: session.id,
            status: "succeeded",
            output: "SN-B7710",
            finishReason: "stop",
          },
        },
        correlation: {
          endpointId: "telegram:seller-1",
          channelId: "telegram:dm",
          tokenHash: "token-wrong",
        },
      },
      {
        actorKind: "unknown",
        actorId: "telegram:seller-1",
      },
    );

    expect(result.status).toBe("completed");
    expect(result.handler).toBe("worker.complete");
    expect(routedCommand?.action).toBe("worker.complete");
    // #548: the store is frozen — routing leaves the legacy row as persisted.
    expect(PendingInteractionStore.get("pi-dispatch-token-mismatch")?.status).toBe("open");
  });

  test("token mismatch with no endpoint or actor proof stays unrouted and is denied", async () => {
    const runtime = new DispatchRuntime();
    let routed = false;
    runtime.register("worker.complete", () => {
      routed = true;
      return { output: "accepted" };
    });

    Storage.initialize({ dbPath: ":memory:" });
    const session = await createWorkerRunFixture("run-pi-no-proof");
    seedPendingInteraction({
      id: "pi-dispatch-no-proof",
      workerRunId: "run-pi-no-proof",
      sessionId: session.id,
      endpointId: "telegram:seller-1",
      channelId: "telegram:dm",
      correlation: { tokenHash: "token-right" },
      allowedActions: ["report_result"],
      expiresAt: Date.now() + 60_000,
      followUpWindow: 60_000,
    });

    const result = await runtime.submit(
      {
        action: "actor.message",
        target: { kind: "surface", id: "telegram:dm" },
        payload: { action: "report_result", output: "SN-FORGED" },
        correlation: {
          endpointId: "telegram:seller-1",
          channelId: "telegram:dm",
          tokenHash: "token-wrong",
        },
      },
      {
        actorKind: "unknown",
        actorId: "telegram:intruder-9",
      },
    );

    expect(routed).toBe(false);
    expect(result.status).toBe("denied");
    expect(PendingInteractionStore.get("pi-dispatch-no-proof")?.status).toBe("open");
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
    seedPendingInteraction({
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
    // #548: the store is frozen — routing leaves the legacy row as persisted.
    expect(PendingInteractionStore.get("pi-dispatch-clarification")?.status).toBe("open");
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

  test("fails closed when a pinned interaction is cancelled during authorization", async () => {
    Storage.initialize({ dbPath: ":memory:" });
    const session = await createWorkerRunFixture("run-pi-cancel-race");
    const pinned = seedPendingInteraction({
      id: "pi-dispatch-cancel-race",
      workerRunId: "run-pi-cancel-race",
      sessionId: session.id,
      endpointId: "telegram:worker-cancelled",
      channelId: "telegram:dm",
      correlation: { replyToMessageId: "message-cancel-race" },
      allowedActions: ["report_result"],
      expiresAt: Date.now() + 60_000,
      followUpWindow: 60_000,
    });
    let called = false;
    const runtime = new DispatchRuntime({
      onPolicyDecision: (decision) => {
        // The store is frozen (#548): emulate an out-of-band persisted
        // cancellation at the adapter layer, as a pre-freeze writer did.
        if (decision.verdict === "allow") {
          Storage.get().pendingInteraction?.set({
            ...pinned,
            status: "cancelled",
            cancelledAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
      },
    });
    runtime.register("worker.complete", () => {
      called = true;
      return { output: "must not execute" };
    });

    const result = await submitPinnedPendingInteraction(
      runtime,
      {
        action: "actor.message",
        target: { kind: "surface", id: "telegram:dm" },
        payload: { action: "report_result", result: "stale result" },
      },
      pinned,
      {
        actorKind: "unknown",
        actorId: pinned.endpointId,
      },
    );

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("dispatch.pending_interaction.inactive");
    expect(called).toBe(false);
    expect(PendingInteractionStore.get(pinned.id)?.status).toBe("cancelled");
  });

  test("fails closed when a pinned identity is replaced during authorization", async () => {
    Storage.initialize({ dbPath: ":memory:" });
    const session = await createWorkerRunFixture("run-pi-replacement-race");
    const pinned = seedPendingInteraction({
      id: "pi-dispatch-replacement-race",
      workerRunId: "run-pi-replacement-race",
      sessionId: session.id,
      targetActorId: "worker:original",
      endpointId: "telegram:worker-original",
      channelId: "telegram:dm",
      correlation: { replyToMessageId: "message-replacement-race" },
      allowedActions: ["report_result"],
      expiresAt: Date.now() + 60_000,
      followUpWindow: 60_000,
    });
    let called = false;
    let replaced = false;
    const runtime = new DispatchRuntime({
      onPolicyDecision: (decision) => {
        if (decision.verdict !== "allow" || replaced) return;
        replaced = true;
        Storage.get().pendingInteraction?.set({
          ...pinned,
          targetActorId: "worker:replacement",
          endpointId: "telegram:worker-replacement",
          updatedAt: Date.now(),
        });
      },
    });
    runtime.register("worker.complete", () => {
      called = true;
      return { output: "must not execute" };
    });

    const result = await submitPinnedPendingInteraction(
      runtime,
      {
        action: "actor.message",
        target: { kind: "surface", id: "telegram:dm" },
        payload: { action: "report_result", result: "stale identity result" },
      },
      pinned,
      {
        actorKind: "user",
        actorId: "worker:original",
      },
    );

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("dispatch.pending_interaction.identity_mismatch");
    expect(called).toBe(false);
    expect(PendingInteractionStore.get(pinned.id)?.targetActorId).toBe("worker:replacement");
  });
});
