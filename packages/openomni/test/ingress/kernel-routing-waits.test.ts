import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  IngressEvent,
  type Communication,
  type Dispatch as DispatchProtocol,
  type Ingress,
} from "@openomni/protocol";
import {
  ActorRegistry,
  BlacklistStore,
  Bus,
  PendingAskStore,
  PendingInteractionStore,
  Session,
  WorkerRun,
} from "@openomni/session";
import { DispatchRuntime } from "../../src/dispatch/runtime";
import { applySelectedWaitEffect, IngressEngine } from "../../src/ingress/engine";
import { IngressEventProjector } from "../../src/ingress/event-projector";
import { IngressRoutingError } from "../../src/ingress/routing-execution";
import {
  resetKernelRoutingState,
  residentExecutions,
  routingDecisions,
} from "./_kernel-routing-fixture";

const correlation = {
  endpointId: "telegram:seller-1",
  channelId: "telegram:dm",
  tokenHash: "token-hash-1",
} satisfies DispatchProtocol.Correlation;

function replyEvent(
  id: string,
  payload: unknown = { action: "report_result", output: "SN-A2334" },
): Ingress.DirectEvent {
  return {
    id,
    surface: "telegram",
    channel: "telegram:dm",
    userId: "seller-1",
    mode: "direct",
    payload,
    meta: { correlation },
    agent: {
      model: { provider: "test", id: "test-model" },
      toolConfig: { workspaceRoot: "/trusted/workspace" },
    },
  };
}

async function createPending(
  id: string,
  runId: string,
  allowedActions: PendingInteractionStore.Record["allowedActions"] = ["report_result"],
): Promise<string> {
  const session = Session.create({
    title: id,
    model: { providerID: "test", modelID: "test-model" },
  });
  await WorkerRun.create(session.id, {
    runId,
    title: runId,
    prompt: "complete assigned work",
  });
  PendingInteractionStore.create({
    id,
    workerRunId: runId,
    sessionId: session.id,
    endpointId: correlation.endpointId,
    channelId: correlation.channelId,
    correlation: { tokenHash: correlation.tokenHash },
    allowedActions,
    targetActorId: "actor-external-worker",
    expiresAt: Number.MAX_SAFE_INTEGER,
    followUpWindow: 60_000,
  });
  return session.id;
}

function createPendingAsk(
  id: string,
  sessionId: string,
  askCorrelation: Communication.PendingAsk.Create["correlation"],
  originRunId: string | null = `run-${id}`,
): Communication.PendingAsk.Record {
  const session = Session.create({
    title: sessionId,
    model: { providerID: "test", modelID: "test-model" },
  });
  return PendingAskStore.create({
    id,
    originSessionId: session.id,
    ...(originRunId === null ? {} : { originRunId }),
    originActorKind: "worker",
    targetKind: "external_actor",
    endpointId: correlation.endpointId,
    channelId: correlation.channelId,
    correlation: askCorrelation,
  });
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

describe("IngressEngine wait routing", () => {
  beforeEach(resetKernelRoutingState);

  test("dispatches one exact reply through the injected shared DispatchRuntime", async () => {
    const sessionId = await createPending("pi-exact", "run-exact");
    const runtime = new DispatchRuntime();
    const routed: DispatchProtocol.Command[] = [];
    const order: string[] = [];
    const actualPublish = Bus.publish;
    const publish = spyOn(Bus, "publish").mockImplementation((event, data) => {
      if (event === IngressEvent.RoutingDecision) order.push("publish");
      actualPublish(event, data);
    });
    let handlerWorkspaceRoot: string | undefined;
    runtime.register("worker.complete", (command, context) => {
      order.push("execute");
      routed.push(command);
      handlerWorkspaceRoot = context?.workspaceRoot;
      return { output: "accepted" };
    });
    IngressEngine.setDispatchRuntime(runtime);
    const observed = routingDecisions();

    let result: Ingress.IngressResult;
    try {
      result = await IngressEngine.ingest(replyEvent("inbound-exact"));
    } finally {
      observed.unsubscribe();
      publish.mockRestore();
    }

    expect(observed.decisions).toHaveLength(1);
    const decision = IngressEvent.RoutingDecision.schema.parse(observed.decisions[0]);
    expect(decision).toMatchObject({
      stage: "wait_correlation",
      outcome: "route",
      sessionId,
      runId: "run-exact",
      pendingInteractionId: "pi-exact",
    });
    expect(order).toEqual(["publish", "execute"]);
    expect(routed).toHaveLength(1);
    expect(handlerWorkspaceRoot).toBe("/trusted/workspace");
    expect(result.sessionId).toBe(sessionId);
    expect(PendingInteractionStore.get("pi-exact")?.status).toBe("resolved");
  });

  test("normalizes a plain-text worker reply to report_result", async () => {
    await createPending("pi-plain-text", "run-plain-text");
    const runtime = new DispatchRuntime();
    const actions: string[] = [];
    runtime.register("worker.complete", (command) => {
      actions.push(command.action);
      return { output: "accepted" };
    });
    IngressEngine.setDispatchRuntime(runtime);

    await IngressEngine.ingest(replyEvent("inbound-plain-text", "completed successfully"));

    expect(actions).toEqual(["worker.complete"]);
    expect(PendingInteractionStore.get("pi-plain-text")?.status).toBe("resolved");
  });

  test("does not execute a valid action that the matched interaction denies", async () => {
    await createPending("pi-denied-action", "run-denied-action", ["report_result"]);
    const runtime = new DispatchRuntime();
    let calls = 0;
    runtime.register("resident.ask", () => {
      calls += 1;
      return { output: "must not execute" };
    });
    IngressEngine.setDispatchRuntime(runtime);
    const observed = routingDecisions();

    let error: Error | undefined;
    try {
      error = await captureError(
        IngressEngine.ingest(
          replyEvent("inbound-denied-action", { action: "ask_clarification", question: "Why?" }),
        ),
      );
    } finally {
      observed.unsubscribe();
    }

    expect(error).toBeInstanceOf(IngressRoutingError);
    expect((error as IngressRoutingError).code).toBe("route_blocked");
    expect(observed.decisions).toHaveLength(1);
    expect(observed.decisions[0]).toMatchObject({
      stage: "channel_ceiling",
      outcome: "block",
      factsUsed: [
        "wait:pending_interaction:pi-denied-action",
        "wait.action:ask_clarification",
        "wait.action:disallowed",
        "channel:missing",
      ],
    });
    expect(calls).toBe(0);
    expect(PendingInteractionStore.get("pi-denied-action")?.status).toBe("open");
  });

  test("routes an allowed connector clarification through resident.ask", async () => {
    const sessionId = await createPending("pi-connector-ask", "run-connector-ask", [
      "ask_clarification",
    ]);
    const runtime = new DispatchRuntime();
    const commands: DispatchProtocol.Command[] = [];
    runtime.register("resident.ask", (command) => {
      commands.push(command);
      return { output: "clarified" };
    });
    IngressEngine.setDispatchRuntime(runtime);

    const result = await IngressEngine.ingest(
      replyEvent("inbound-connector-ask", {
        action: "ask_clarification",
        question: "Which connector?",
      }),
    );

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      action: "resident.ask",
      sessionId,
      runId: "run-connector-ask",
      actor: { trustTier: "assigned_worker" },
    });
    expect(result.sessionId).toBe(sessionId);
    expect(PendingInteractionStore.get("pi-connector-ask")?.status).toBe("resolved");
  });

  test.each([
    "attach_artifact",
    "decline_task",
  ] as const)("rejects allowed but unsupported %s ingress actions before dispatch", async (action) => {
    const suffix = action.replace("_", "-");
    const interactionId = `pi-unsupported-${suffix}`;
    await createPending(interactionId, `run-unsupported-${suffix}`, [action]);
    const runtime = new DispatchRuntime();
    let dispatchExecutions = 0;
    runtime.register("actor.message", () => {
      dispatchExecutions += 1;
      return { output: "must not execute" };
    });
    IngressEngine.setDispatchRuntime(runtime);
    const observed = routingDecisions();

    let error: Error | undefined;
    try {
      error = await captureError(
        IngressEngine.ingest(replyEvent(`inbound-unsupported-${suffix}`, { action })),
      );
    } finally {
      observed.unsubscribe();
    }

    expect(error).toBeInstanceOf(IngressRoutingError);
    expect((error as IngressRoutingError).code).toBe("route_blocked");
    expect(observed.decisions).toHaveLength(1);
    expect(observed.decisions[0]).toMatchObject({
      stage: "channel_ceiling",
      outcome: "block",
      factsUsed: [
        `wait:pending_interaction:${interactionId}`,
        `wait.action:${action}`,
        "wait.action:unsupported_ingress_command",
      ],
    });
    expect(dispatchExecutions).toBe(0);
    expect(PendingInteractionStore.get(interactionId)?.status).toBe("open");
  });

  test("pins a poisoned PendingInteraction event to the matched session and run", async () => {
    const sessionId = await createPending("pi-poisoned", "run-poisoned");
    const runtime = new DispatchRuntime();
    let submittedCommand: DispatchProtocol.Command | undefined;
    let handlerContext: { sessionId?: string; runId?: string } | undefined;
    runtime.register("worker.complete", (command, context) => {
      submittedCommand = command;
      handlerContext = { sessionId: context?.sessionId, runId: context?.runId };
      return { output: "accepted" };
    });
    IngressEngine.setDispatchRuntime(runtime);
    const observed = routingDecisions();
    const inbound = {
      ...replyEvent("inbound-poisoned"),
      target: { kind: "worker", sessionId: "stale-target-session" },
      meta: {
        correlation,
        target: { kind: "worker", sessionId: "stale-meta-session" },
      },
      runtime: {
        durableSessionId: "stale-runtime-session",
        runId: "stale-runtime-run",
        activationId: "stale-activation",
      },
    } satisfies Ingress.DirectEvent;

    let result: Ingress.IngressResult;
    try {
      result = await IngressEngine.ingest(inbound);
    } finally {
      observed.unsubscribe();
    }

    expect(observed.decisions).toHaveLength(1);
    const decision = IngressEvent.RoutingDecision.schema.parse(observed.decisions[0]);
    expect(decision).toMatchObject({
      stage: "wait_correlation",
      outcome: "route",
      target: `worker-session:${sessionId}`,
      sessionId,
      runId: "run-poisoned",
      pendingInteractionId: "pi-poisoned",
    });
    expect(submittedCommand).toMatchObject({
      action: "worker.complete",
      target: { kind: "worker", sessionId, runId: "run-poisoned" },
      sessionId,
      runId: "run-poisoned",
      actor: { sessionId, runId: "run-poisoned", workerRunId: "run-poisoned" },
    });
    expect(handlerContext).toEqual({ sessionId, runId: "run-poisoned" });
    expect(result).toMatchObject({
      target: { kind: "worker", sessionId },
      sessionId,
    });
    expect(PendingInteractionStore.get("pi-poisoned")?.status).toBe("resolved");
  });

  test("routes a PendingAsk private external-message match to its owner session and run", async () => {
    const ask = createPendingAsk("ask-external-message", "session-external-message", {
      externalMessageId: "inbound-external-message",
    });
    const observed = routingDecisions();
    const project = spyOn(IngressEventProjector, "project");
    const inbound = {
      ...replyEvent("inbound-external-message", "answer from external worker"),
      target: { kind: "worker", sessionId: "stale-target-session" },
      meta: {
        correlation,
        target: { kind: "worker", sessionId: "stale-meta-session" },
      },
      runtime: {
        durableSessionId: "stale-runtime-session",
        runId: "stale-runtime-run",
      },
    } satisfies Ingress.DirectEvent;

    let result: Ingress.IngressResult;
    let projectedEvent: Parameters<typeof IngressEventProjector.project>[0] | undefined;
    try {
      result = await IngressEngine.ingest(inbound);
      expect(project).toHaveBeenCalledTimes(1);
      const projectedCall = project.mock.calls[0];
      if (projectedCall === undefined) throw new Error("expected projector call");
      [projectedEvent] = projectedCall;
    } finally {
      observed.unsubscribe();
      project.mockRestore();
    }

    expect(observed.decisions).toHaveLength(1);
    expect(observed.decisions[0]).toMatchObject({
      stage: "wait_correlation",
      outcome: "route",
      target: "resident",
      sessionId: ask.originSessionId,
      runId: ask.originRunId,
    });
    expect(observed.decisions[0]).not.toHaveProperty("actorId");
    expect(observed.decisions[0]).not.toHaveProperty("trustTier");
    if (projectedEvent === undefined) throw new Error("expected projected event");
    expect(projectedEvent.target).toEqual({ kind: "resident" });
    expect(projectedEvent.meta).not.toHaveProperty("target");
    expect(projectedEvent.meta?.pendingAsk).toMatchObject({
      id: ask.id,
      originSessionId: ask.originSessionId,
      originRunId: ask.originRunId,
    });
    expect(projectedEvent.runtime).toMatchObject({
      durableSessionId: ask.originSessionId,
      runId: ask.originRunId,
    });
    expect(result.sessionId).toBe(ask.originSessionId);
    expect(PendingAskStore.get(ask.id)?.status).toBe("open");
  });

  test("pins a stale-target PendingAsk to the published Resident route", async () => {
    const ask = createPendingAsk(
      "ask-without-run",
      "session-without-run",
      { externalMessageId: "inbound-without-run" },
      null,
    );
    const project = spyOn(IngressEventProjector, "project");
    const inbound = {
      ...replyEvent("inbound-without-run", "answer without an origin run"),
      target: { kind: "worker", sessionId: "stale-target-session" },
      meta: {
        correlation,
        target: { kind: "worker", sessionId: "stale-meta-session" },
      },
      runtime: {
        durableSessionId: "stale-runtime-session",
        runId: "stale-runtime-run",
        activationId: "inbound-activation",
      },
    } satisfies Ingress.DirectEvent;

    let result: Ingress.IngressResult;
    let projectedEvent: Parameters<typeof IngressEventProjector.project>[0] | undefined;
    let projectedSessionId: string | undefined;
    try {
      result = await IngressEngine.ingest(inbound);
      expect(project).toHaveBeenCalledTimes(1);
      const projectedCall = project.mock.calls[0];
      if (projectedCall === undefined) throw new Error("expected projector call");
      [projectedEvent, projectedSessionId] = projectedCall;
    } finally {
      project.mockRestore();
    }

    if (projectedEvent === undefined) throw new Error("expected projected event");
    expect(projectedEvent.target).toEqual({ kind: "resident" });
    expect(projectedEvent.meta).not.toHaveProperty("target");
    expect(projectedEvent.meta?.pendingAsk).toEqual({
      id: ask.id,
      originSessionId: ask.originSessionId,
      originActorKind: ask.originActorKind,
      targetKind: ask.targetKind,
      status: ask.status,
      ambiguous: false,
    });
    expect(projectedEvent.runtime).toEqual({
      durableSessionId: ask.originSessionId,
      activationId: "inbound-activation",
    });
    expect(projectedSessionId).toBe(ask.originSessionId);
    expect(result.sessionId).toBe(ask.originSessionId);
    expect(residentExecutions).toEqual(["executed"]);
  });

  test("does not guess or mutate for PI-only ambiguity", async () => {
    await createPending("pi-ambiguous-a", "run-ambiguous-a");
    await createPending("pi-ambiguous-b", "run-ambiguous-b");
    const runtime = new DispatchRuntime();
    let calls = 0;
    runtime.register("worker.complete", () => {
      calls += 1;
      return { output: "must not execute" };
    });
    IngressEngine.setDispatchRuntime(runtime);
    const observed = routingDecisions();

    let error: Error | undefined;
    try {
      error = await captureError(IngressEngine.ingest(replyEvent("inbound-pi-ambiguous")));
    } finally {
      observed.unsubscribe();
    }

    expect(error).toBeInstanceOf(IngressRoutingError);
    expect((error as IngressRoutingError).code).toBe("route_ambiguous");
    expect(observed.decisions[0]).toMatchObject({
      stage: "wait_correlation",
      outcome: "ambiguous",
      candidateInteractionIds: [
        "pending_interaction:pi-ambiguous-a",
        "pending_interaction:pi-ambiguous-b",
      ],
    });
    expect(calls).toBe(0);
    expect(PendingInteractionStore.get("pi-ambiguous-a")?.status).toBe("open");
    expect(PendingInteractionStore.get("pi-ambiguous-b")?.status).toBe("open");
  });

  test("fails closed for combined PendingInteraction and PendingAsk matches", async () => {
    await createPending("pi-combined", "run-combined");
    createPendingAsk("ask-combined", "session-ask-combined", {
      tokenHash: correlation.tokenHash,
    });
    const observed = routingDecisions();

    let error: Error | undefined;
    try {
      error = await captureError(IngressEngine.ingest(replyEvent("inbound-combined")));
    } finally {
      observed.unsubscribe();
    }

    expect(error).toBeInstanceOf(IngressRoutingError);
    expect((error as IngressRoutingError).code).toBe("route_ambiguous");
    expect(observed.decisions[0]).toMatchObject({
      stage: "wait_correlation",
      outcome: "ambiguous",
      candidateInteractionIds: ["pending_ask:ask-combined", "pending_interaction:pi-combined"],
    });
    expect(PendingAskStore.get("ask-combined")?.status).toBe("ambiguous");
    expect(PendingInteractionStore.get("pi-combined")?.status).toBe("open");
  });

  test("publishes selected wait ambiguity before marking both asks", async () => {
    createPendingAsk("ask-selected-a", "session-selected-a", {
      tokenHash: correlation.tokenHash,
    });
    createPendingAsk("ask-selected-b", "session-selected-b", {
      tokenHash: correlation.tokenHash,
    });
    const runtime = new DispatchRuntime();
    let dispatchExecutions = 0;
    runtime.register("worker.complete", () => {
      dispatchExecutions += 1;
      return { output: "must not execute" };
    });
    IngressEngine.setDispatchRuntime(runtime);
    const observed = routingDecisions();
    const order: string[] = [];
    const actualPublish = Bus.publish;
    const publish = spyOn(Bus, "publish").mockImplementation((event, data) => {
      if (event === IngressEvent.RoutingDecision) order.push("publish");
      actualPublish(event, data);
    });
    const actualMarkAmbiguous = PendingAskStore.markAmbiguous;
    const mark = spyOn(PendingAskStore, "markAmbiguous").mockImplementation((id) => {
      order.push(`mark:${id}`);
      return actualMarkAmbiguous(id);
    });

    let error: Error | undefined;
    try {
      error = await captureError(IngressEngine.ingest(replyEvent("inbound-selected-ambiguity")));
    } finally {
      observed.unsubscribe();
      publish.mockRestore();
      mark.mockRestore();
    }

    expect(error).toBeInstanceOf(IngressRoutingError);
    expect((error as IngressRoutingError).code).toBe("route_ambiguous");
    expect(observed.decisions).toHaveLength(1);
    const decision = IngressEvent.RoutingDecision.schema.parse(observed.decisions[0]);
    expect(decision).toMatchObject({
      stage: "wait_correlation",
      outcome: "ambiguous",
      candidateInteractionIds: ["pending_ask:ask-selected-a", "pending_ask:ask-selected-b"],
      factsUsed: [
        "wait.candidate:pending_ask:ask-selected-a",
        "wait.candidate:pending_ask:ask-selected-b",
      ],
    });
    expect(order).toEqual(["publish", "mark:ask-selected-a", "mark:ask-selected-b"]);
    expect(PendingAskStore.get("ask-selected-a")?.status).toBe("ambiguous");
    expect(PendingAskStore.get("ask-selected-b")?.status).toBe("ambiguous");
    expect(residentExecutions).toEqual([]);
    expect(dispatchExecutions).toBe(0);
  });

  test("blocks the resolved actor endpoint even when correlation names another endpoint", async () => {
    ActorRegistry.registerIdentity({
      id: "actor-seller-resolved",
      kind: "human",
      trustTier: "assigned_worker",
      relationship: "external_agent",
    });
    ActorRegistry.registerEndpoint({
      id: "endpoint-seller-resolved",
      actorId: "actor-seller-resolved",
      channel: "telegram",
      externalId: "seller-1",
    });
    BlacklistStore.put({
      id: "blacklist-resolved-endpoint",
      kind: "endpoint",
      value: "endpoint-seller-resolved",
      createdBy: "actor-owner",
    });
    await createPending("pi-resolved-endpoint", "run-resolved-endpoint");
    const runtime = new DispatchRuntime();
    let dispatchExecutions = 0;
    runtime.register("worker.complete", () => {
      dispatchExecutions += 1;
      return { output: "must not execute" };
    });
    IngressEngine.setDispatchRuntime(runtime);
    const observed = routingDecisions();

    let error: Error | undefined;
    try {
      error = await captureError(IngressEngine.ingest(replyEvent("inbound-resolved-endpoint")));
    } finally {
      observed.unsubscribe();
    }

    expect(error).toBeInstanceOf(IngressRoutingError);
    expect((error as IngressRoutingError).code).toBe("route_blocked");
    expect(observed.decisions).toHaveLength(1);
    expect(observed.decisions[0]).toMatchObject({
      stage: "blacklist",
      outcome: "drop",
      factsUsed: [
        "blacklist:blacklist-resolved-endpoint",
        "blacklist.kind:endpoint",
        "blacklist.reason:blacklist.endpoint.endpoint-seller-resolved",
      ],
    });
    expect(dispatchExecutions).toBe(0);
    expect(PendingInteractionStore.get("pi-resolved-endpoint")?.status).toBe("open");
  });

  test("blacklist suppresses gathered two-Ask ambiguity effects and execution", async () => {
    createPendingAsk("ask-blacklist-a", "session-blacklist-a", {
      tokenHash: correlation.tokenHash,
    });
    createPendingAsk("ask-blacklist-b", "session-blacklist-b", {
      tokenHash: correlation.tokenHash,
    });
    BlacklistStore.put({
      id: "blacklist-seller-1",
      kind: "endpoint",
      value: correlation.endpointId,
      createdBy: "actor-owner",
    });
    const runtime = new DispatchRuntime();
    let dispatchExecutions = 0;
    runtime.register("worker.complete", () => {
      dispatchExecutions += 1;
      return { output: "must not execute" };
    });
    IngressEngine.setDispatchRuntime(runtime);
    const pendingInteractionReads = spyOn(PendingInteractionStore, "findByCorrelation");
    const pendingAskReads = spyOn(PendingAskStore, "findByCorrelation");
    const markCalls: string[] = [];
    const actualMarkAmbiguous = PendingAskStore.markAmbiguous;
    const mark = spyOn(PendingAskStore, "markAmbiguous").mockImplementation((id) => {
      markCalls.push(id);
      return actualMarkAmbiguous(id);
    });
    const observed = routingDecisions();

    let pendingInteractionQueries: DispatchProtocol.Correlation[] = [];
    let pendingAskQueries: Communication.PendingAsk.CorrelationQuery[] = [];
    let error: Error | undefined;
    try {
      error = await captureError(
        IngressEngine.ingest({
          ...replyEvent("inbound-blacklisted"),
          meta: {
            correlation: {
              ...correlation,
              replyToMessageId: "reply-blacklisted",
              threadId: "thread-blacklisted",
              externalConversationId: "conversation-blacklisted",
            },
          },
        }),
      );
      pendingInteractionQueries = pendingInteractionReads.mock.calls.map(([query]) => query);
      pendingAskQueries = pendingAskReads.mock.calls.map(([query]) => query);
    } finally {
      observed.unsubscribe();
      mark.mockRestore();
      pendingInteractionReads.mockRestore();
      pendingAskReads.mockRestore();
    }

    expect(error).toBeInstanceOf(IngressRoutingError);
    expect((error as IngressRoutingError).code).toBe("route_blocked");
    expect(observed.decisions).toHaveLength(1);
    const decision = IngressEvent.RoutingDecision.schema.parse(observed.decisions[0]);
    expect(decision).toMatchObject({
      stage: "blacklist",
      outcome: "drop",
      factsUsed: [
        "blacklist:blacklist-seller-1",
        "blacklist.kind:endpoint",
        "blacklist.reason:blacklist.endpoint.telegram:seller-1",
      ],
    });
    expect(pendingInteractionQueries).toEqual([
      {
        endpointId: correlation.endpointId,
        channelId: correlation.channelId,
        replyToMessageId: "reply-blacklisted",
      },
      {
        endpointId: correlation.endpointId,
        channelId: correlation.channelId,
        threadId: "thread-blacklisted",
      },
      correlation,
      {
        endpointId: correlation.endpointId,
        channelId: correlation.channelId,
        externalConversationId: "conversation-blacklisted",
      },
    ]);
    expect(pendingAskQueries).toEqual([
      {
        endpointId: correlation.endpointId,
        channelId: correlation.channelId,
        tokenHash: correlation.tokenHash,
      },
      {
        endpointId: correlation.endpointId,
        channelId: correlation.channelId,
        externalConversationId: "conversation-blacklisted",
      },
      {
        endpointId: correlation.endpointId,
        channelId: correlation.channelId,
        replyToMessageId: "reply-blacklisted",
      },
      {
        endpointId: correlation.endpointId,
        channelId: correlation.channelId,
        threadId: "thread-blacklisted",
      },
      {
        endpointId: correlation.endpointId,
        channelId: correlation.channelId,
        externalMessageId: "inbound-blacklisted",
      },
    ]);
    expect(markCalls).toEqual([]);
    expect(PendingAskStore.get("ask-blacklist-a")?.status).toBe("open");
    expect(PendingAskStore.get("ask-blacklist-b")?.status).toBe("open");
    expect(residentExecutions).toEqual([]);
    expect(dispatchExecutions).toBe(0);
  });

  test("rejects a non-selected executable wait effect before mutation", () => {
    const decision = IngressEvent.RoutingDecision.schema.parse({
      traceId: "trace-non-selected-effect",
      time: 1,
      inboundId: "inbound-non-selected-effect",
      surface: "telegram",
      mode: "direct",
      stage: "blacklist",
      outcome: "drop",
      reason: "Inbound principal matched the blacklist",
      factsUsed: ["blacklist:blacklist-test", "blacklist.kind:endpoint"],
    });
    const mark = spyOn(PendingAskStore, "markAmbiguous");

    try {
      expect(() =>
        applySelectedWaitEffect({
          decision,
          waitEffect: {
            kind: "mark_pending_asks_ambiguous",
            pendingAskIds: ["ask-must-not-change"],
          },
        }),
      ).toThrow("non-wait-ambiguous decision carried an executable wait effect");
      expect(mark).not.toHaveBeenCalled();
    } finally {
      mark.mockRestore();
    }
  });

  test("leaves an authorized exact interaction open when no handler is selected", async () => {
    const sessionId = await createPending("pi-no-handler", "run-no-handler");
    IngressEngine.setDispatchRuntime(new DispatchRuntime());
    const observed = routingDecisions();

    let error: Error | undefined;
    try {
      error = await captureError(IngressEngine.ingest(replyEvent("inbound-no-handler")));
    } finally {
      observed.unsubscribe();
    }

    expect(error).toBeInstanceOf(IngressRoutingError);
    expect((error as IngressRoutingError).code).toBe("dispatch_failed");
    expect(error?.message).toBe("No dispatch handler registered for worker.complete");
    expect(observed.decisions).toHaveLength(1);
    const decision = IngressEvent.RoutingDecision.schema.parse(observed.decisions[0]);
    expect(decision).toMatchObject({
      stage: "wait_correlation",
      outcome: "route",
      target: `worker-session:${sessionId}`,
      sessionId,
      runId: "run-no-handler",
      pendingInteractionId: "pi-no-handler",
    });
    expect((error as IngressRoutingError).decision).toEqual(decision);
    expect(PendingInteractionStore.get("pi-no-handler")?.status).toBe("open");
  });

  test("does not expose structured Dispatch handler output as channel text", async () => {
    await createPending("pi-structured-output", "run-structured-output");
    const runtime = new DispatchRuntime();
    runtime.register("worker.complete", () => ({ output: { internal: "result" } }));
    IngressEngine.setDispatchRuntime(runtime);

    const result = await IngressEngine.ingest(replyEvent("inbound-structured-output"));

    expect(result.result.output).toBe("");
    expect(PendingInteractionStore.get("pi-structured-output")?.status).toBe("resolved");
  });

  test("fails with typed evidence for unsupported primitive Dispatch output", async () => {
    await createPending("pi-primitive-output", "run-primitive-output");
    const runtime = new DispatchRuntime();
    runtime.register("worker.complete", () => ({ output: 42 }));
    IngressEngine.setDispatchRuntime(runtime);

    const error = await captureError(IngressEngine.ingest(replyEvent("inbound-primitive-output")));

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
