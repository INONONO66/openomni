import { beforeEach, describe, expect, test } from "bun:test";
import { Ingress, Wait, type Command, type Gateway } from "@openomni/protocol";
import {
  ActorRegistry,
  PendingInteractionStore,
  Session,
  Storage,
  WorkItemStore,
} from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";
import { DispatchRuntime } from "../../src/dispatch/runtime";
import { createDefaultDispatchRuntime } from "../../src/dispatch/setup";
import { createBrainEngine, type BrainEngineDeps } from "../../src/ingress/engine";
import { IngressRoutingError } from "../../src/ingress/internal-route";
import { allocateTestAttempt } from "../dispatch/helpers";
import { seedPendingInteraction } from "../helpers/pending-interaction";

/**
 * Brain half of the pre-flip kernel wait-routing suite (#707): the
 * pending-interaction DELIVERY arm — the gateway router correlates and
 * records the decision (pinned in packages/channels/test/router/
 * kernel-routing-waits.test.ts); dispatch work placement stays brain
 * judgment, exercised here by driving the Deliver consumer with the exact
 * delivery shape the router produces.
 */

const correlation = {
  endpointId: "telegram:seller-1",
  channelId: "telegram:dm",
  tokenHash: "token-hash-1",
} satisfies Wait.Correlation;

let completionWriter: Storage.WorkItemCompletionWriter;

function replyEvent(
  id: string,
  payload: unknown = { action: "report_result", output: "SN-A2334" },
): Gateway.DeliveredEvent {
  return {
    id,
    traceId: "trace-test",
    surface: "telegram",
    channel: "telegram:dm",
    userId: "seller-1",
    mode: "direct",
    payload,
    // The router resolves the sender's registered identity BEFORE delivering
    // (resolveIngressActor is perimeter-side) — the delivered event carries
    // the resolved actor stamp the sender-match evidence folds over.
    meta: {
      correlation,
      actor: {
        id: "seller-1",
        role: "user",
        actorId: "actor-external-worker",
        kind: "human",
        trustTier: "assigned_worker",
        endpointId: correlation.endpointId,
        endpoint: {
          id: correlation.endpointId,
          actorId: "actor-external-worker",
          channel: "telegram",
          externalId: "seller-1",
        },
      },
    },
  };
}

/** The recorded decision the router delivers for a matched frozen row. */
function pendingInteractionDecision(
  event: Gateway.DeliveredEvent,
  sessionId: string,
  runId: string,
  pendingInteractionId: string,
): Ingress.RoutingDecisionPayload {
  const action = Wait.requestedWaitAction(event.payload);
  return Ingress.Events.RoutingDecision.schema.parse({
    traceId: event.traceId,
    time: Date.now(),
    inboundId: event.id,
    surface: event.surface,
    mode: "direct",
    stage: "wait_correlation",
    outcome: "route",
    target: `worker-session:${sessionId}`,
    sessionId,
    runId,
    pendingInteractionId,
    trustTier: "assigned_worker",
    inboundTreatment: "full_access",
    reason: "Inbound action matched a pending interaction",
    factsUsed: [
      `wait:pending_interaction:${pendingInteractionId}`,
      `wait.action:${action}`,
      `wait.session:${sessionId}`,
      `wait.run:${runId}`,
    ],
  });
}

function delivery(
  event: Gateway.DeliveredEvent,
  sessionId: string,
  runId: string,
  pendingInteractionId: string,
): Gateway.Deliver {
  return {
    sessionId,
    message: {
      messageId: event.id,
      traceId: event.traceId,
      surfaceKey: `${event.surface}::${event.channel ?? ""}`,
      text: typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload),
    },
    event,
    decision: pendingInteractionDecision(event, sessionId, runId, pendingInteractionId),
  };
}

function makeEngine(deps: BrainEngineDeps = {}) {
  return createBrainEngine({
    externalAgentResolver: async () => ({
      model: { provider: "test", id: "test-model" },
      toolConfig: { workspaceRoot: "/trusted/workspace" },
    }),
    ...deps,
  });
}

// PendingInteractionStore writes are frozen (#548) — historical rows are
// seeded at the adapter layer, exactly as pre-freeze rows persist on disk.
async function seedFrozenPending(
  id: string,
  runId: string,
  allowedActions: PendingInteractionStore.Record["allowedActions"] = ["report_result"],
): Promise<string> {
  const existingEndpoint = ActorRegistry.resolveEndpoint("telegram", "seller-1");
  const targetActorId = existingEndpoint?.identity.id ?? "actor-external-worker";
  if (!existingEndpoint) {
    ActorRegistry.registerIdentity({
      id: targetActorId,
      kind: "human",
      trustTier: "assigned_worker",
    });
    ActorRegistry.registerEndpoint({
      id: correlation.endpointId,
      actorId: targetActorId,
      channel: "telegram",
      externalId: "seller-1",
    });
  }
  const session = Session.create({
    traceId: "trace-test",
    title: id,
    model: { providerID: "test", modelID: "test-model" },
  });
  const workerRunAdapter = Storage.getAdapter().workerRunState;
  if (!workerRunAdapter) throw new Error("workerRunState sub-adapter missing");
  workerRunAdapter.create(session.id, {
    runId,
    agentName: "worker",
    status: "waiting_input",
    executorKind: "connector_endpoint",
    title: runId,
    prompt: "complete assigned work",
  });
  const workItem = await WorkItemStore.create(
    {
      name: `Connector run ${runId}`,
      sourceMessageId: `seed:${id}`,
      sourceChannel: "dispatch",
      intent: "worker.complete",
      goal: "complete assigned work",
      sessionId: session.id,
      workSessionId: session.id,
      workerRunId: runId,
      executorKind: "connector_endpoint",
      acceptanceCriteria: ["the assigned Worker reports terminal state"],
    },
    "trace-test",
  );
  await WorkItemStore.start(workItem.workItemId, "trace-test");
  await allocateTestAttempt(workItem.workItemId);
  seedPendingInteraction({
    id,
    workerRunId: runId,
    sessionId: session.id,
    endpointId: correlation.endpointId,
    channelId: correlation.channelId,
    correlation: { tokenHash: correlation.tokenHash },
    allowedActions,
    targetActorId,
    expiresAt: Number.MAX_SAFE_INTEGER,
    followUpWindow: 60_000,
  });
  return session.id;
}

async function captureError(action: Promise<unknown>): Promise<Error | undefined> {
  try {
    await action;
    return undefined;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return error;
  }
}

describe("BrainEngine pending-interaction delivery", () => {
  beforeEach(() => {
    Storage.reset();
    Bus.reset();
    completionWriter = Storage.initialize({ dbPath: ":memory:" });
  });

  test("dispatches one exact delivery through the injected shared DispatchRuntime", async () => {
    const sessionId = await seedFrozenPending("pi-exact", "run-exact");
    const runtime = new DispatchRuntime();
    const routed: Command.Request[] = [];
    let handlerWorkspaceRoot: string | undefined;
    let handlerContext: { sessionId?: string; runId?: string } | undefined;
    runtime.register("worker.complete", (command, context) => {
      routed.push(command);
      handlerWorkspaceRoot = context?.workspaceRoot;
      handlerContext = { sessionId: context?.sessionId, runId: context?.runId };
      return { output: "accepted" };
    });
    const engine = makeEngine({ dispatchRuntime: runtime });
    const event = replyEvent("inbound-exact");

    const result = await engine.deliver(delivery(event, sessionId, "run-exact", "pi-exact"));

    expect(routed).toHaveLength(1);
    expect(routed[0]).toMatchObject({
      action: "worker.complete",
      target: { kind: "worker", sessionId, runId: "run-exact" },
      sessionId,
      runId: "run-exact",
      actor: { sessionId, runId: "run-exact", workerRunId: "run-exact" },
    });
    // The bridge-embedded agent died with the flip; the resolver-supplied
    // AgentDef still carries the trusted workspace to the handler context.
    expect(handlerWorkspaceRoot).toBe("/trusted/workspace");
    expect(handlerContext).toEqual({ sessionId, runId: "run-exact" });
    if (result.kind === "dropped") throw new Error("shape");
    expect(result.sessionId).toBe(sessionId);
    expect(result).toMatchObject({ target: { kind: "worker", sessionId } });
    // #548: the store is frozen — routing leaves the legacy row as persisted.
    expect(PendingInteractionStore.get("pi-exact")?.status).toBe("open");
  });

  test("routes an allowed connector clarification through resident.ask", async () => {
    const sessionId = await seedFrozenPending("pi-connector-ask", "run-connector-ask", [
      "ask_clarification",
    ]);
    const runtime = new DispatchRuntime();
    const commands: Command.Request[] = [];
    runtime.register("resident.ask", (command) => {
      commands.push(command);
      return { output: "clarified" };
    });
    const engine = makeEngine({ dispatchRuntime: runtime });
    const event = replyEvent("inbound-connector-ask", {
      action: "ask_clarification",
      question: "Which connector?",
    });

    const result = await engine.deliver(
      delivery(event, sessionId, "run-connector-ask", "pi-connector-ask"),
    );

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      action: "resident.ask",
      sessionId,
      runId: "run-connector-ask",
      actor: { trustTier: "assigned_worker" },
    });
    if (result.kind === "dropped") throw new Error("shape");
    expect(result.sessionId).toBe(sessionId);
    expect(PendingInteractionStore.get("pi-connector-ask")?.status).toBe("open");
  });

  test("normalizes a plain-text worker reply for the default worker.complete handler", async () => {
    const sessionId = await seedFrozenPending("pi-plain-text", "run-plain-text");
    const workItem = WorkItemStore.list().find(
      (item) => item.workerRunId === "run-plain-text" && item.workSessionId === sessionId,
    );
    if (!workItem) throw new Error("missing seeded connector WorkItem");
    const engine = makeEngine({
      dispatchRuntime: createDefaultDispatchRuntime({ completionWriter }),
    });
    const event = replyEvent("inbound-plain-text", "completed successfully");

    const result = await engine.deliver(
      delivery(event, sessionId, "run-plain-text", "pi-plain-text"),
    );

    if (result.kind === "dropped") throw new Error("shape");
    expect(result.result.output).toBe("");
    // #548: the store is frozen — routing leaves the legacy row as persisted.
    expect(PendingInteractionStore.get("pi-plain-text")?.status).toBe("open");
    expect(WorkItemStore.get(workItem.workItemId)?.blockers).toEqual([
      expect.objectContaining({ description: "completion report is required" }),
    ]);
  });

  test("denies a shared-channel delivery from a different resolved sender", async () => {
    ActorRegistry.registerIdentity({
      id: "actor-shared-channel-intruder",
      kind: "human",
      trustTier: "observer",
    });
    ActorRegistry.registerEndpoint({
      id: "endpoint-shared-channel-intruder",
      actorId: "actor-shared-channel-intruder",
      channel: "telegram",
      externalId: "intruder-2",
    });
    const sessionId = await seedFrozenPending(
      "pi-shared-channel-victim",
      "run-shared-channel-victim",
    );
    const runtime = new DispatchRuntime();
    let dispatchExecutions = 0;
    runtime.register("worker.complete", () => {
      dispatchExecutions += 1;
      return { output: "must not execute" };
    });
    const engine = makeEngine({ dispatchRuntime: runtime });
    const event = {
      ...replyEvent("inbound-shared-channel-intruder"),
      userId: "intruder-2",
      // The router resolved the intruder's registered identity before
      // delivering — replicate its actor stamp.
      meta: {
        correlation,
        actor: {
          id: "intruder-2",
          role: "user",
          actorId: "actor-shared-channel-intruder",
          kind: "human",
          trustTier: "observer",
          endpointId: "endpoint-shared-channel-intruder",
        },
      },
    } satisfies Gateway.DeliveredEvent;

    const error = await captureError(
      engine.deliver(
        delivery(event, sessionId, "run-shared-channel-victim", "pi-shared-channel-victim"),
      ),
    );

    expect(error).toBeInstanceOf(IngressRoutingError);
    expect((error as IngressRoutingError).code).toBe("dispatch_route_invalid");
    expect(error?.message).toBe(
      "pending interaction sender does not match the assigned actor endpoint",
    );
    expect(dispatchExecutions).toBe(0);
    expect(PendingInteractionStore.get("pi-shared-channel-victim")?.status).toBe("open");
  });

  test("leaves an authorized exact interaction open when no handler is selected", async () => {
    const sessionId = await seedFrozenPending("pi-no-handler", "run-no-handler");
    const engine = makeEngine({ dispatchRuntime: new DispatchRuntime() });
    const event = replyEvent("inbound-no-handler");
    const input = delivery(event, sessionId, "run-no-handler", "pi-no-handler");

    const error = await captureError(engine.deliver(input));

    expect(error).toBeInstanceOf(IngressRoutingError);
    expect((error as IngressRoutingError).code).toBe("dispatch_failed");
    expect(error?.message).toBe("No dispatch handler registered for worker.complete");
    expect((error as IngressRoutingError).decision).toEqual(input.decision);
    expect(PendingInteractionStore.get("pi-no-handler")?.status).toBe("open");
  });

  test("fails closed without a dispatch runtime", async () => {
    const sessionId = await seedFrozenPending("pi-no-runtime", "run-no-runtime");
    const engine = makeEngine();
    const event = replyEvent("inbound-no-runtime");

    const error = await captureError(
      engine.deliver(delivery(event, sessionId, "run-no-runtime", "pi-no-runtime")),
    );

    expect(error).toBeInstanceOf(IngressRoutingError);
    expect((error as IngressRoutingError).code).toBe("dispatch_runtime_missing");
    expect(error?.message).toBe("dispatch runtime not configured");
  });

  test("does not expose structured Command handler output as channel text", async () => {
    const sessionId = await seedFrozenPending("pi-structured-output", "run-structured-output");
    const runtime = new DispatchRuntime();
    runtime.register("worker.complete", () => ({ output: { internal: "result" } }));
    const engine = makeEngine({ dispatchRuntime: runtime });
    const event = replyEvent("inbound-structured-output");

    const result = await engine.deliver(
      delivery(event, sessionId, "run-structured-output", "pi-structured-output"),
    );

    if (result.kind === "dropped") throw new Error("shape");
    expect(result.result.output).toBe("");
    expect(PendingInteractionStore.get("pi-structured-output")?.status).toBe("open");
  });

  test("fails with typed evidence for unsupported primitive Command output", async () => {
    const sessionId = await seedFrozenPending("pi-primitive-output", "run-primitive-output");
    const runtime = new DispatchRuntime();
    runtime.register("worker.complete", () => ({ output: 42 }));
    const engine = makeEngine({ dispatchRuntime: runtime });
    const event = replyEvent("inbound-primitive-output");
    const input = delivery(event, sessionId, "run-primitive-output", "pi-primitive-output");

    const error = await captureError(engine.deliver(input));

    expect(error).toBeInstanceOf(IngressRoutingError);
    expect((error as IngressRoutingError).code).toBe("dispatch_output_unsupported");
    expect(error?.message).toContain("type=number, value=42");
    expect((error as IngressRoutingError).decision).toMatchObject({
      stage: "wait_correlation",
      outcome: "route",
      pendingInteractionId: "pi-primitive-output",
    });
  });
});
