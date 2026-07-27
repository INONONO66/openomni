import { beforeEach, describe, expect, test } from "bun:test";
import { Dispatch, PolicyDecision, type Wait } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import type { AuthorityProjectionQueryPort } from "../../src/ingress/actor-resolver.js";
import type { DurableWaitV1, WaitKernelService } from "../../src/ingress/wait-correlation.js";
import { createResidentDispatchHandlers } from "../../src/dispatch/handlers/resident.js";
import type { DispatchPolicyRegistration } from "../../src/dispatch/policy-registration.js";
import { DispatchRuntime, submitPinnedPendingInteraction } from "../../src/dispatch/runtime.js";

const tokenHash = "a".repeat(64);
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

const authorityQueries: AuthorityProjectionQueryPort = {
  async query(request) {
    if (request.kind !== "authority.blacklist_match") {
      throw new Error(`unexpected authority query: ${request.kind}`);
    }
    return {
      kind: "authority.blacklist_match",
      entry: null,
      sourceEventId: "authority-1",
      sourceOwnerSeq: 1,
      sourceLedgerSeq: 1,
      sourceOwnerHash: "hash-1",
      asOfLedgerSeq: 1,
    };
  },
};

function waitHarness() {
  let current = pending;
  const accepted: Array<Record<string, unknown>> = [];
  const routed: Array<Record<string, unknown>> = [];
  const unavailable = async (): Promise<never> => {
    throw new Error("unexpected Wait operation");
  };
  const waitKernel: WaitKernelService = {
    async correlate() {
      return { kind: "match", candidate: { key: "wait:wait-1", wait: current } };
    },
    async revalidatePinned() {
      return { kind: "valid", wait: current };
    },
    async acceptResponse(input) {
      accepted.push(input);
      current = {
        ...pending,
        status: "resolved",
        resolvedAtDbMs: Date.now(),
        routingDeadlineDbMs: Date.now() + 30_000,
        routedDispatchId: "wait:wait-1:threshold",
        routedAction: input.action,
      };
      return current;
    },
    settle: unavailable,
    cancel: unavailable,
    stageAmbiguity: unavailable,
    async markRouted(input) {
      routed.push(input);
    },
  };
  return { waitKernel, accepted, routed };
}

function pendingInput(action: "report_result" | "ask_clarification") {
  return {
    action: Dispatch.Actions.ActorMessage,
    target: { kind: "surface" as const, id: "channel-1" },
    payload:
      action === "report_result"
        ? { action, output: "private result" }
        : { action, question: "private question" },
    correlation: {
      endpointId: "endpoint-1",
      channelId: "channel-1",
      tokenHash,
      threadId: "thread-1",
    },
    idempotencyKey: "transport-1",
  };
}

function actorOptions() {
  return { actorKind: "user" as const, actorId: "actor-1" };
}

function allowPolicy(): DispatchPolicyRegistration {
  return {
    kind: "point",
    name: "test.allow",
    pointIds: ["dispatch.action.pre"],
    effectCapabilities: { "dispatch.action.pre": [] },
    priority: 0,
    fn: () => PolicyDecision.allow({ policyId: "test.allow" }),
  };
}

const flushBus = () => new Promise((resolve) => queueMicrotask(resolve));

beforeEach(() => Bus.reset());

describe("DispatchRuntime", () => {
  test("routes an exact report_result through the narrow matched-Wait authority", async () => {
    const harness = waitHarness();
    const runtime = new DispatchRuntime({
      waitKernel: harness.waitKernel,
      authorityQueries,
    });
    let handledAction: string | undefined;
    runtime.register(Dispatch.Actions.WorkerComplete, (command) => {
      handledAction = command.action;
      return { output: { accepted: true } };
    });

    const result = await submitPinnedPendingInteraction(
      runtime,
      pendingInput("report_result"),
      pending,
      actorOptions(),
    );

    expect(result.status).toBe("completed");
    expect(result.handler).toBe(Dispatch.Actions.WorkerComplete);
    expect(result.dispatchId).toBe("wait:wait-1:threshold");
    expect(handledAction).toBe(Dispatch.Actions.WorkerComplete);
    expect(harness.accepted).toHaveLength(1);
    expect(harness.routed).toEqual([
      { waitId: "wait-1", dispatchId: "wait:wait-1:threshold", action: "report_result" },
    ]);
  });

  test("routes ask_clarification as a native RT-04 receipt without running Resident", async () => {
    const harness = waitHarness();
    const runtime = new DispatchRuntime({
      waitKernel: harness.waitKernel,
      authorityQueries,
    });
    runtime.register(
      Dispatch.Actions.ResidentAsk,
      createResidentDispatchHandlers({ waitKernel: harness.waitKernel })["resident.ask"],
    );

    const result = await submitPinnedPendingInteraction(
      runtime,
      pendingInput("ask_clarification"),
      pending,
      actorOptions(),
    );

    expect(result.status).toBe("completed");
    expect(result.handler).toBe(Dispatch.Actions.ResidentAsk);
    expect(result.output).toEqual({
      waitId: "wait-1",
      action: "ask_clarification",
      routed: true,
    });
    expect(harness.routed).toEqual([
      {
        waitId: "wait-1",
        dispatchId: "wait:wait-1:threshold",
        action: "ask_clarification",
      },
    ]);
  });

  test("denies inexact pending replies before any routed handler", async () => {
    const cases: readonly {
      readonly correlation?: ReturnType<typeof pendingInput>["correlation"];
      readonly actorId?: string;
      readonly payload?: unknown;
    }[] = [
      {
        correlation: {
          endpointId: "endpoint-1",
          channelId: "channel-1",
          tokenHash: "b".repeat(64),
          threadId: "thread-1",
        },
      },
      { actorId: "actor-2" },
      { payload: { action: "decline_task" } },
    ];

    for (const item of cases) {
      const harness = waitHarness();
      const runtime = new DispatchRuntime({ waitKernel: harness.waitKernel, authorityQueries });
      let handlerCalls = 0;
      runtime.register(Dispatch.Actions.WorkerComplete, () => {
        handlerCalls += 1;
        return { output: "unexpected" };
      });
      const base = pendingInput("report_result");
      const result = await runtime.submit(
        {
          ...base,
          ...(item.payload === undefined ? {} : { payload: item.payload }),
          ...(item.correlation === undefined ? {} : { correlation: item.correlation }),
        },
        { actorKind: "user", actorId: item.actorId ?? "actor-1" },
      );

      expect(result.status).toBe("denied");
      expect(handlerCalls).toBe(0);
      expect(harness.accepted).toHaveLength(0);
      expect(harness.routed).toHaveLength(0);
    }
  });

  test("keeps Worker authority fail-closed while Resident alone may spawn", async () => {
    const harness = waitHarness();
    const runtime = new DispatchRuntime({ waitKernel: harness.waitKernel, authorityQueries });
    let spawnCalls = 0;
    let workerCalls = 0;
    runtime.register(Dispatch.Actions.WorkerSpawn, () => {
      spawnCalls += 1;
      return { output: "spawned" };
    });
    runtime.register(Dispatch.Actions.WorkerCancel, () => {
      workerCalls += 1;
      return { output: "cancelled" };
    });
    runtime.register(Dispatch.Actions.WorkerComplete, () => {
      workerCalls += 1;
      return { output: "completed" };
    });
    runtime.register(Dispatch.Actions.ResidentAsk, () => {
      workerCalls += 1;
      return { output: "asked" };
    });

    const residentSpawn = await runtime.submit(
      { action: Dispatch.Actions.WorkerSpawn, target: { kind: "worker" }, payload: {} },
      { actorKind: "resident", actorId: "resident:main" },
    );
    const workerSpawn = await runtime.submit(
      { action: Dispatch.Actions.WorkerSpawn, target: { kind: "worker" }, payload: {} },
      { actorKind: "worker", actorId: "worker:1" },
    );
    const workerCancel = await runtime.submit(
      { action: Dispatch.Actions.WorkerCancel, target: { kind: "worker", id: "run-1" } },
      { actorKind: "worker", actorId: "worker:1" },
    );
    const genericWorkerComplete = await runtime.submit(
      { action: Dispatch.Actions.WorkerComplete, target: { kind: "worker", id: "run-1" } },
      { actorKind: "worker", actorId: "worker:1" },
    );
    const unauthenticatedResidentAsk = await runtime.submit(
      { action: Dispatch.Actions.ResidentAsk, target: { kind: "resident" } },
      { actorKind: "worker", actorId: "worker:1" },
    );

    expect(residentSpawn.status).toBe("completed");
    expect(workerSpawn.status).toBe("denied");
    expect(workerCancel.status).toBe("denied");
    expect(genericWorkerComplete.status).toBe("denied");
    expect(unauthenticatedResidentAsk.status).toBe("denied");
    expect(spawnCalls).toBe(1);
    expect(workerCalls).toBe(0);
  });

  test("orders lifecycle events and keeps Bus audit envelopes confidential", async () => {
    const harness = waitHarness();
    const events: string[] = [];
    const envelopes: Array<Record<string, unknown>> = [];
    Bus.observe((event, data) => {
      if (event.name.startsWith("dispatch.")) {
        events.push(event.name);
        envelopes.push(data as Record<string, unknown>);
      }
    });
    const runtime = new DispatchRuntime({
      waitKernel: harness.waitKernel,
      authorityQueries,
      includeDefaultPolicies: false,
      policies: [allowPolicy()],
    });
    runtime.register("custom.private", () => ({ output: "private result" }));

    const result = await runtime.submit(
      {
        action: "custom.private",
        target: { kind: "system" },
        payload: "private payload",
      },
      { actorKind: "system", actorId: "system:test" },
    );
    await flushBus();

    expect(result.status).toBe("completed");
    expect(events).toEqual([
      "dispatch.submitted",
      "dispatch.authorized",
      "dispatch.routed",
      "dispatch.completed",
    ]);
    expect(envelopes.some((event) => "payloadSummary" in event)).toBe(false);
    expect(envelopes.some((event) => "resultSummary" in event)).toBe(false);
    expect(JSON.stringify(envelopes)).not.toContain("private payload");
    expect(JSON.stringify(envelopes)).not.toContain("private result");
  });

  test("fails an unknown handler without routing", async () => {
    const harness = waitHarness();
    const events: string[] = [];
    Bus.observe((event) => events.push(event.name));
    const runtime = new DispatchRuntime({
      waitKernel: harness.waitKernel,
      authorityQueries,
      includeDefaultPolicies: false,
      policies: [allowPolicy()],
    });

    const result = await runtime.submit(
      { action: "custom.missing", target: { kind: "system" } },
      { actorKind: "system", actorId: "system:test" },
    );
    await flushBus();

    expect(result.status).toBe("failed");
    expect(result.error).toContain("No dispatch handler registered for custom.missing");
    expect(events).not.toContain("dispatch.routed");
  });

  test("forwards native wait and timeout lifecycle controls to the handler", async () => {
    const harness = waitHarness();
    const runtime = new DispatchRuntime({
      waitKernel: harness.waitKernel,
      authorityQueries,
      includeDefaultPolicies: false,
      policies: [allowPolicy()],
    });
    let context: { wait?: boolean; timeoutMs?: number } | undefined;
    runtime.register("custom.wait", (_command, handlerContext) => {
      context = { wait: handlerContext?.wait, timeoutMs: handlerContext?.timeoutMs };
      return { output: "ok" };
    });

    const result = await runtime.submit(
      { action: "custom.wait", target: { kind: "system" }, wait: true, timeoutMs: 25 },
      { actorKind: "system", actorId: "system:test" },
    );

    expect(result.status).toBe("completed");
    expect(context).toEqual({ wait: true, timeoutMs: 25 });
  });
});
