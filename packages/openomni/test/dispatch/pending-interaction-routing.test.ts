import { describe, expect, test } from "bun:test";
import { Dispatch, type Wait } from "@openomni/protocol";
import {
  markRoutedPendingInteraction,
  routePendingInteraction,
} from "../../src/dispatch/pending-interaction-routing.js";
import type { DurableWaitV1, WaitKernelService } from "../../src/ingress/wait-correlation.js";

const tokenHash = "a".repeat(64);
const routedDispatchId = "wait:wait-1:threshold";
const responder = {
  version: "wait-responder-ref-v1",
  actorId: "actor-1",
  endpointId: "endpoint-1",
} as const;
const opened: Wait.OpenedV1 = {
  version: "wait.opened.v1",
  waitId: "wait-1",
  ownerRef: { version: "wait-owner-ref-v1", kind: "workItem", id: "work-1" },
  expectedResponders: [responder],
  targetActorId: "actor-1",
  endpointId: "endpoint-1",
  channelId: "channel-1",
  correlation: { version: "wait-correlation-v1", tokenHash, threadId: "thread-1" },
  allowedActions: ["report_result", "ask_clarification"],
  resolutionPolicy: "first-response",
  quorum: { version: "wait-quorum-v1", required: 1, total: 1 },
  status: "open",
  deadline: Date.now() + 60_000,
  partial: false,
  followUpWindow: 0,
};
const pending: DurableWaitV1 = {
  waitId: "wait-1",
  revision: "1",
  opened,
  status: "open",
  route: { kind: "worker", sessionId: "session-1", runId: "run-1" },
};
const resolved: DurableWaitV1 = {
  ...pending,
  status: "resolved",
  resolvedAtDbMs: Date.now(),
  routingDeadlineDbMs: Date.now() + 30_000,
  routedDispatchId,
  routedAction: "report_result",
};

function command(overrides: Partial<Dispatch.Command> = {}): Dispatch.Command {
  return Dispatch.Command.parse({
    action: Dispatch.Actions.ActorMessage,
    target: { kind: "surface", id: "channel-1" },
    payload: { action: "report_result", output: "done" },
    correlation: {
      endpointId: "endpoint-1",
      channelId: "channel-1",
      tokenHash,
      threadId: "thread-1",
    },
    idempotencyKey: "transport-1",
    dispatchId: "random-runtime-id",
    actor: { kind: "user", actorId: "actor-1" },
    submittedAt: Date.now(),
    ...overrides,
  });
}

function service() {
  const accepted: Array<Record<string, unknown>> = [];
  const routed: Array<Record<string, unknown>> = [];
  const unavailable = async (): Promise<never> => {
    throw new Error("not used");
  };
  const waitKernel: WaitKernelService = {
    correlate: unavailable,
    revalidatePinned: unavailable,
    acceptResponse: async (input) => {
      accepted.push(input);
      return {
        ...resolved,
        routedAction: input.action,
      };
    },
    settle: unavailable,
    cancel: unavailable,
    stageAmbiguity: unavailable,
    markRouted: async (input) => {
      routed.push(input);
    },
  };
  return { waitKernel, accepted, routed };
}

describe("pending interaction Wait routing", () => {
  test("reuses the threshold dispatch id and duplicate transport identity", async () => {
    const harness = service();
    const first = await routePendingInteraction(harness.waitKernel, command(), pending);
    const duplicate = await routePendingInteraction(harness.waitKernel, command(), pending);

    expect(first.dispatchId).toBe(routedDispatchId);
    expect(duplicate.dispatchId).toBe(routedDispatchId);
    expect(first.action).toBe(Dispatch.Actions.WorkerComplete);
    expect(harness.accepted).toEqual([
      expect.objectContaining({ waitId: "wait-1", transportId: "transport-1", responder }),
      expect.objectContaining({ waitId: "wait-1", transportId: "transport-1", responder }),
    ]);

    await markRoutedPendingInteraction(harness.waitKernel, first);
    expect(harness.routed).toEqual([
      { waitId: "wait-1", dispatchId: routedDispatchId, action: "report_result" },
    ]);
  });

  test("routes clarification through the native resolved Wait receipt", async () => {
    const harness = service();
    const clarification = command({
      payload: { action: "ask_clarification", question: "Which environment?" },
    });

    const routed = await routePendingInteraction(harness.waitKernel, clarification, pending);

    expect(routed.dispatchId).toBe(routedDispatchId);
    expect(routed.action).toBe(Dispatch.Actions.ResidentAsk);
    expect(routed.target).toEqual({ kind: "resident", sessionId: "session-1" });
    expect(routed.actor).toEqual(
      expect.objectContaining({
        kind: "worker",
        reason: "wait.match",
        labels: expect.arrayContaining(["actor.assigned_worker", "wait.wait-1"]),
      }),
    );
    expect(harness.accepted).toEqual([
      expect.objectContaining({
        waitId: "wait-1",
        transportId: "transport-1",
        action: "ask_clarification",
        responder,
      }),
    ]);

    await markRoutedPendingInteraction(harness.waitKernel, routed);
    expect(harness.routed).toEqual([
      { waitId: "wait-1", dispatchId: routedDispatchId, action: "ask_clarification" },
    ]);
  });

  test("rejects wrong closed correlation, responder, and action before Wait acceptance", async () => {
    const harness = service();
    const wrongToken = command({
      correlation: {
        endpointId: "endpoint-1",
        channelId: "channel-1",
        tokenHash: "b".repeat(64),
        threadId: "thread-1",
      },
    });
    const wrongResponder = command({ actor: { kind: "user", actorId: "actor-2" } });
    const wrongAction = command({ payload: { action: "decline_task" } });

    expect(await routePendingInteraction(harness.waitKernel, wrongToken, pending)).toBe(wrongToken);
    expect(await routePendingInteraction(harness.waitKernel, wrongResponder, pending)).toBe(
      wrongResponder,
    );
    expect(await routePendingInteraction(harness.waitKernel, wrongAction, pending)).toBe(
      wrongAction,
    );
    expect(harness.accepted).toEqual([]);
  });
});
