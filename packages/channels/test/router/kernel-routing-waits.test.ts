import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Communication, Ingress, type Gateway, type Wait } from "@openomni/protocol";
import {
  ActorRegistry,
  BlacklistStore,
  PendingAskStore,
  PendingInteractionStore,
  Session,
  Storage,
  WaitStore,
} from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";
import { IngressRoutingError } from "../../src/router/routing-resolution";
import { createExistingAgentMessaging } from "../../src/router/messaging/send";
import { WaitService } from "../../src/router/wait/index";
import { seedPendingInteraction } from "../helpers/pending-interaction";
import { deliveries, kernelRouter, resetRouterState, routingDecisions } from "./_router-fixture";

/**
 * Router half of the pre-flip kernel wait-routing suite (#707): everything up
 * to the Deliver seam — correlation, decision recording, wait folds
 * (attachReply/expiry), ambiguity, blacklist suppression, and the projected
 * delivery shape. The dispatch-execution half (pending-interaction command
 * placement) is brain-side and lives in
 * the removed product pipeline; the surviving perimeter behavior is pinned here.
 */

const correlation = {
  endpointId: "telegram:seller-1",
  channelId: "telegram:dm",
  tokenHash: "token-hash-1",
} satisfies Wait.Correlation;

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
    meta: { correlation },
  };
}

// PendingInteractionStore writes are frozen (#548) — historical rows are
// seeded at the adapter layer, exactly as pre-freeze rows persist on disk.
// The router half needs no WorkItem/attempt scaffolding: dispatch placement
// is past the seam.
function seedFrozenPending(
  id: string,
  runId: string,
  allowedActions: PendingInteractionStore.Record["allowedActions"] = ["report_result"],
): string {
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

// PendingAskStore writes are frozen (#510 D2a) — historical rows are seeded
// at the adapter layer, exactly as pre-freeze rows persist on disk.
function createPendingAsk(
  id: string,
  sessionTitle: string,
  askCorrelation: Communication.PendingAsk.Record["correlation"],
  originRunId: string | null = `run-${id}`,
): Communication.PendingAsk.Record {
  const session = Session.create({
    traceId: "trace-test",
    title: sessionTitle,
    model: { providerID: "test", modelID: "test-model" },
  });
  const record = Communication.PendingAsk.Record.parse({
    id,
    originSessionId: session.id,
    ...(originRunId === null ? {} : { originRunId }),
    originActorKind: "worker",
    targetKind: "external_actor",
    endpointId: correlation.endpointId,
    channelId: correlation.channelId,
    correlation: askCorrelation,
    status: "open",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const adapter = Storage.getAdapter().pendingAsk;
  if (!adapter) throw new Error("pendingAsk adapter missing");
  adapter.create(record);
  return record;
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

describe("GatewayRouter wait routing", () => {
  beforeEach(resetRouterState);

  test("delivers one exact pending-interaction reply after the recorded decision", async () => {
    const sessionId = seedFrozenPending("pi-exact", "run-exact");
    const order: string[] = [];
    const actualPublish = Bus.publish;
    const publish = spyOn(Bus, "publish").mockImplementation((event, data) => {
      if (event === Ingress.Events.RoutingDecision) order.push("publish");
      actualPublish(event, data);
    });

    let result: Ingress.IngressResult;
    try {
      result = await kernelRouter().ingest(replyEvent("inbound-exact"));
      if (deliveries.length > 0) order.push("deliver");
    } finally {
      publish.mockRestore();
    }

    expect(routingDecisions()).toHaveLength(1);
    const decision = Ingress.Events.RoutingDecision.schema.parse(routingDecisions()[0]);
    expect(decision).toMatchObject({
      stage: "wait_correlation",
      outcome: "route",
      sessionId,
      runId: "run-exact",
      pendingInteractionId: "pi-exact",
    });
    // Record-before-act: the decision published (post-append) before deliver.
    expect(order).toEqual(["publish", "deliver"]);
    expect(deliveries).toHaveLength(1);
    // Dispatch placement is brain judgment: the event crosses untouched, with
    // the recorded decision carrying the routed worker context.
    expect(deliveries[0]?.decision).toEqual(decision);
    expect(deliveries[0]?.event.meta?.correlation).toEqual(correlation);
    if (result.kind === "dropped") throw new Error("shape");
    expect(result.sessionId).toBe(sessionId);
    // #548: the store is frozen — routing leaves the legacy row as persisted.
    expect(PendingInteractionStore.get("pi-exact")?.status).toBe("open");
  });

  test("does not deliver a valid action that the matched interaction denies", async () => {
    seedFrozenPending("pi-denied-action", "run-denied-action", ["report_result"]);

    const error = await captureError(
      kernelRouter().ingest(
        replyEvent("inbound-denied-action", { action: "ask_clarification", question: "Why?" }),
      ),
    );

    expect(error).toBeInstanceOf(IngressRoutingError);
    expect((error as IngressRoutingError).code).toBe("route_blocked");
    expect(error?.message).toBe("Matched wait does not allow the requested action");
    expect(routingDecisions()).toHaveLength(1);
    // #548 pin flip: the legacy fallthrough to surface routing is removed —
    // a matched frozen row with a disallowed action blocks at the
    // wait_correlation stage exactly like a durable wait.
    expect(routingDecisions()[0]).toMatchObject({
      stage: "wait_correlation",
      outcome: "block",
      factsUsed: [
        "wait:pending_interaction:pi-denied-action",
        "wait.action:ask_clarification",
        "wait.action:disallowed",
      ],
    });
    expect(deliveries).toHaveLength(0);
    expect(PendingInteractionStore.get("pi-denied-action")?.status).toBe("open");
  });

  test("blocks an explicitly invalid action on a matched frozen legacy row instead of coercing to report_result", async () => {
    seedFrozenPending("pi-invalid-action", "run-invalid-action", ["report_result"]);

    const error = await captureError(
      kernelRouter().ingest(
        replyEvent("inbound-invalid-action", { action: "unknown", output: "SN-A2334" }),
      ),
    );

    expect(error).toBeInstanceOf(IngressRoutingError);
    expect((error as IngressRoutingError).code).toBe("route_blocked");
    expect(error?.message).toBe("Matched wait does not allow the requested action");
    expect(routingDecisions()).toHaveLength(1);
    expect(routingDecisions()[0]).toMatchObject({
      stage: "wait_correlation",
      outcome: "block",
      factsUsed: [
        "wait:pending_interaction:pi-invalid-action",
        "wait.action:invalid",
        "wait.action:disallowed",
      ],
    });
    expect(deliveries).toHaveLength(0);
    expect(PendingInteractionStore.get("pi-invalid-action")?.status).toBe("open");
  });

  test.each([
    "attach_artifact",
    "decline_task",
  ] as const)("rejects allowed but unsupported %s ingress actions before delivery", async (action) => {
    const suffix = action.replace("_", "-");
    const interactionId = `pi-unsupported-${suffix}`;
    seedFrozenPending(interactionId, `run-unsupported-${suffix}`, [action]);

    const error = await captureError(
      kernelRouter().ingest(replyEvent(`inbound-unsupported-${suffix}`, { action })),
    );

    expect(error).toBeInstanceOf(IngressRoutingError);
    expect((error as IngressRoutingError).code).toBe("route_blocked");
    expect(routingDecisions()).toHaveLength(1);
    expect(routingDecisions()[0]).toMatchObject({
      stage: "channel_ceiling",
      outcome: "block",
      factsUsed: [
        `wait:pending_interaction:${interactionId}`,
        `wait.action:${action}`,
        "wait.action:unsupported_ingress_command",
      ],
    });
    expect(deliveries).toHaveLength(0);
    expect(PendingInteractionStore.get(interactionId)?.status).toBe("open");
  });

  test("pins a poisoned PendingInteraction event to the matched session and run", async () => {
    const sessionId = seedFrozenPending("pi-poisoned", "run-poisoned");
    const inbound = {
      ...replyEvent("inbound-poisoned"),
      target: { kind: "worker", sessionId: "stale-target-session" },
      meta: {
        correlation,
        target: { kind: "worker", sessionId: "stale-meta-session" },
      },
      activation: {
        durableSessionId: "stale-runtime-session",
        runId: "stale-runtime-run",
        activationId: "stale-activation",
      },
    } satisfies Gateway.DeliveredEvent;

    const result = await kernelRouter().ingest(inbound);

    expect(routingDecisions()).toHaveLength(1);
    const decision = Ingress.Events.RoutingDecision.schema.parse(routingDecisions()[0]);
    expect(decision).toMatchObject({
      stage: "wait_correlation",
      outcome: "route",
      target: `worker-session:${sessionId}`,
      sessionId,
      runId: "run-poisoned",
      pendingInteractionId: "pi-poisoned",
    });
    // The routed decision (not the poisoned event fields) is what the brain
    // executes against: the delivery label is the matched session.
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.sessionId).toBe(sessionId);
    expect(deliveries[0]?.decision).toEqual(decision);
    expect(result).toMatchObject({ sessionId });
    expect(PendingInteractionStore.get("pi-poisoned")?.status).toBe("open");
  });

  test("routes a PendingAsk private external-message match to its owner session and run", async () => {
    const ask = createPendingAsk("ask-external-message", "session-external-message", {
      externalMessageId: "inbound-external-message",
    });
    const inbound = {
      ...replyEvent("inbound-external-message", "answer from external worker"),
      target: { kind: "worker", sessionId: "stale-target-session" },
      meta: {
        correlation,
        target: { kind: "worker", sessionId: "stale-meta-session" },
      },
      activation: {
        durableSessionId: "stale-runtime-session",
        runId: "stale-runtime-run",
      },
    } satisfies Gateway.DeliveredEvent;

    const result = await kernelRouter().ingest(inbound);

    expect(routingDecisions()).toHaveLength(1);
    expect(routingDecisions()[0]).toMatchObject({
      stage: "wait_correlation",
      outcome: "route",
      target: "resident",
      sessionId: ask.originSessionId,
      runId: ask.originRunId,
    });
    expect(routingDecisions()[0]).not.toHaveProperty("actorId");
    expect(routingDecisions()[0]).not.toHaveProperty("trustTier");
    // The delivered event IS the projected owner event the brain consumes
    // (the pre-flip projector-input pins, now at the seam).
    const delivered = deliveries[0]?.event;
    if (delivered === undefined) throw new Error("expected a delivery");
    expect(delivered.target ?? { kind: "resident" }).toEqual({ kind: "resident" });
    expect(delivered.meta).not.toHaveProperty("target");
    expect(delivered.meta?.pendingAsk).toMatchObject({
      id: ask.id,
      originSessionId: ask.originSessionId,
      originRunId: ask.originRunId,
    });
    expect(delivered.activation).toMatchObject({
      durableSessionId: ask.originSessionId,
      runId: ask.originRunId,
    });
    if (result.kind === "dropped") throw new Error("shape");
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
    const inbound = {
      ...replyEvent("inbound-without-run", "answer without an origin run"),
      target: { kind: "worker", sessionId: "stale-target-session" },
      meta: {
        correlation,
        target: { kind: "worker", sessionId: "stale-meta-session" },
      },
      activation: {
        durableSessionId: "stale-runtime-session",
        runId: "stale-runtime-run",
        activationId: "inbound-activation",
      },
    } satisfies Gateway.DeliveredEvent;

    const result = await kernelRouter().ingest(inbound);

    const delivered = deliveries[0]?.event;
    if (delivered === undefined) throw new Error("expected a delivery");
    expect(delivered.target ?? { kind: "resident" }).toEqual({ kind: "resident" });
    expect(delivered.meta).not.toHaveProperty("target");
    expect(delivered.meta?.pendingAsk).toEqual({
      id: ask.id,
      originSessionId: ask.originSessionId,
      originActorKind: ask.originActorKind,
      targetKind: ask.targetKind,
      status: ask.status,
      ambiguous: false,
    });
    expect(delivered.activation).toEqual({
      durableSessionId: ask.originSessionId,
      activationId: "inbound-activation",
    });
    expect(deliveries[0]?.sessionId).toBe(ask.originSessionId);
    if (result.kind === "dropped") throw new Error("shape");
    expect(result.sessionId).toBe(ask.originSessionId);
  });

  test("does not guess or mutate for PI-only ambiguity", async () => {
    seedFrozenPending("pi-ambiguous-a", "run-ambiguous-a");
    seedFrozenPending("pi-ambiguous-b", "run-ambiguous-b");

    const error = await captureError(kernelRouter().ingest(replyEvent("inbound-pi-ambiguous")));

    expect(error).toBeInstanceOf(IngressRoutingError);
    expect((error as IngressRoutingError).code).toBe("route_ambiguous");
    expect(routingDecisions()[0]).toMatchObject({
      stage: "wait_correlation",
      outcome: "ambiguous",
      candidateInteractionIds: [
        "pending_interaction:pi-ambiguous-a",
        "pending_interaction:pi-ambiguous-b",
      ],
    });
    expect(deliveries).toHaveLength(0);
    expect(PendingInteractionStore.get("pi-ambiguous-a")?.status).toBe("open");
    expect(PendingInteractionStore.get("pi-ambiguous-b")?.status).toBe("open");
  });

  test("fails closed for combined PendingInteraction and PendingAsk matches", async () => {
    seedFrozenPending("pi-combined", "run-combined");
    createPendingAsk("ask-combined", "session-ask-combined", {
      tokenHash: correlation.tokenHash,
    });

    const error = await captureError(kernelRouter().ingest(replyEvent("inbound-combined")));

    expect(error).toBeInstanceOf(IngressRoutingError);
    expect((error as IngressRoutingError).code).toBe("route_ambiguous");
    expect(routingDecisions()[0]).toMatchObject({
      stage: "wait_correlation",
      outcome: "ambiguous",
      candidateInteractionIds: ["pending_ask:ask-combined", "pending_interaction:pi-combined"],
    });
    // Frozen legacy rows: correlation records ambiguity via the typed
    // decision only and never mutates candidates (#215).
    expect(PendingAskStore.get("ask-combined")?.status).toBe("open");
    expect(PendingInteractionStore.get("pi-combined")?.status).toBe("open");
  });

  test("publishes selected wait ambiguity without mutating the frozen asks", async () => {
    createPendingAsk("ask-selected-a", "session-selected-a", {
      tokenHash: correlation.tokenHash,
    });
    createPendingAsk("ask-selected-b", "session-selected-b", {
      tokenHash: correlation.tokenHash,
    });
    const mark = spyOn(PendingAskStore, "markAmbiguous");

    let error: Error | undefined;
    try {
      error = await captureError(kernelRouter().ingest(replyEvent("inbound-selected-ambiguity")));
    } finally {
      mark.mockRestore();
    }

    expect(error).toBeInstanceOf(IngressRoutingError);
    expect((error as IngressRoutingError).code).toBe("route_ambiguous");
    expect(routingDecisions()).toHaveLength(1);
    const decision = Ingress.Events.RoutingDecision.schema.parse(routingDecisions()[0]);
    expect(decision).toMatchObject({
      stage: "wait_correlation",
      outcome: "ambiguous",
      candidateInteractionIds: ["pending_ask:ask-selected-a", "pending_ask:ask-selected-b"],
      factsUsed: [
        "wait.candidate:pending_ask:ask-selected-a",
        "wait.candidate:pending_ask:ask-selected-b",
      ],
    });
    // The published typed decision is the sole record of ambiguity; frozen
    // legacy asks stay untouched (#215 — correlation never writes).
    expect(mark).not.toHaveBeenCalled();
    expect(PendingAskStore.get("ask-selected-a")?.status).toBe("open");
    expect(PendingAskStore.get("ask-selected-b")?.status).toBe("open");
    expect(deliveries).toHaveLength(0);
  });

  test("blocks the resolved actor endpoint even when correlation names another endpoint", async () => {
    ActorRegistry.registerIdentity({
      id: "actor-seller-resolved",
      kind: "human",
      trustTier: "assigned_worker",
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
    seedFrozenPending("pi-resolved-endpoint", "run-resolved-endpoint");

    const result = await kernelRouter().ingest(replyEvent("inbound-resolved-endpoint"));

    expect(result).toMatchObject({ kind: "dropped" });
    expect(routingDecisions()).toHaveLength(1);
    expect(routingDecisions()[0]).toMatchObject({
      stage: "blacklist",
      outcome: "drop",
      factsUsed: [
        "blacklist:blacklist-resolved-endpoint",
        "blacklist.kind:endpoint",
        "blacklist.reason:blacklist.endpoint.endpoint-seller-resolved",
      ],
    });
    expect(deliveries).toHaveLength(0);
    expect(PendingInteractionStore.get("pi-resolved-endpoint")?.status).toBe("open");
  });

  test("blacklist suppresses gathered two-Ask ambiguity effects and delivery", async () => {
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
    const pendingInteractionReads = spyOn(PendingInteractionStore, "findByCorrelation");
    const pendingAskReads = spyOn(PendingAskStore, "findByCorrelation");
    const markCalls: string[] = [];
    const actualMarkAmbiguous = PendingAskStore.markAmbiguous;
    const mark = spyOn(PendingAskStore, "markAmbiguous").mockImplementation((id) => {
      markCalls.push(id);
      return actualMarkAmbiguous(id);
    });

    let pendingInteractionQueries: Communication.PendingInteraction.CorrelationQuery[] = [];
    let pendingAskQueries: Communication.PendingAsk.CorrelationQuery[] = [];
    let result: Ingress.IngressResult;
    try {
      result = await kernelRouter().ingest({
        ...replyEvent("inbound-blacklisted"),
        meta: {
          correlation: {
            ...correlation,
            replyToMessageId: "reply-blacklisted",
            threadId: "thread-blacklisted",
            externalConversationId: "conversation-blacklisted",
          },
        },
      });
      pendingInteractionQueries = pendingInteractionReads.mock.calls.map(([query]) => query);
      pendingAskQueries = pendingAskReads.mock.calls.map(([query]) => query);
    } finally {
      mark.mockRestore();
      pendingInteractionReads.mockRestore();
      pendingAskReads.mockRestore();
    }

    expect(result).toMatchObject({ kind: "dropped" });
    expect(routingDecisions()).toHaveLength(1);
    const decision = Ingress.Events.RoutingDecision.schema.parse(routingDecisions()[0]);
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
    ]);
    expect(pendingAskQueries).toEqual([
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
        tokenHash: correlation.tokenHash,
      },
    ]);
    expect(markCalls).toEqual([]);
    expect(PendingAskStore.get("ask-blacklist-a")?.status).toBe("open");
    expect(PendingAskStore.get("ask-blacklist-b")?.status).toBe("open");
    expect(deliveries).toHaveLength(0);
  });
});

describe("GatewayRouter durable wait routing", () => {
  beforeEach(resetRouterState);

  function registerResponder(actorId: string, externalId: string): void {
    ActorRegistry.registerIdentity({
      id: actorId,
      kind: "human",
      trustTier: "assigned_worker",
    });
    ActorRegistry.registerEndpoint({
      id: `telegram:${externalId}`,
      actorId,
      channel: "telegram",
      externalId,
    });
  }

  function openSessionWait(
    id: string,
    overrides: Partial<Parameters<typeof WaitService.open>[0]> = {},
  ) {
    // The owner session id is an opaque label to the router (S1): no session
    // row exists on this side of the seam and none is needed.
    const ownerSessionId = crypto.randomUUID();
    return WaitService.open(
      {
        id,
        ownerRef: { kind: "session", id: ownerSessionId },
        originMessageId: `out-${id}`,
        correlation: { channelId: correlation.channelId, tokenHash: correlation.tokenHash },
        allowedActions: ["report_result"],
        expectedResponders: ["actor-external-worker"],
        resolutionPolicy: "first_reply",
        expiresAt: Number.MAX_SAFE_INTEGER,
        followUpWindow: 60_000,
        ...overrides,
      },
      "trace-test",
    );
  }

  test("attaches a matched reply to the durable wait and delivers it to the owner session", async () => {
    registerResponder("actor-external-worker", "seller-1");
    const wait = openSessionWait("wait-session-owner");

    const result = await kernelRouter().ingest(replyEvent("inbound-wait-reply"));

    expect(routingDecisions()).toHaveLength(1);
    expect(routingDecisions()[0]).toMatchObject({
      stage: "wait_correlation",
      outcome: "route",
      target: "resident",
      sessionId: wait.ownerRef.id,
      factsUsed: [
        "wait:wait:wait-session-owner",
        "wait.action:report_result",
        `wait.owner:session:${wait.ownerRef.id}`,
      ],
    });
    if (result.kind === "dropped") throw new Error("shape");
    expect(result.sessionId).toBe(wait.ownerRef.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.sessionId).toBe(wait.ownerRef.id);
    expect(deliveries[0]?.waitContext).toEqual({
      waitId: "wait-session-owner",
      allowedAction: "report_result",
    });
    const record = WaitStore.get("wait-session-owner");
    expect(record).toMatchObject({ status: "resolved", partial: false });
    expect(record?.replies).toEqual([
      expect.objectContaining({
        replyKey: "inbound-wait-reply",
        responderId: "actor-external-worker",
      }),
    ]);
  });

  test("keeps a 2-of-3 wait open after the first reply and still delivers to the owner", async () => {
    registerResponder("actor-external-worker", "seller-1");
    const wait = openSessionWait("wait-quorum", {
      expectedResponders: ["actor-external-worker", "actor-b", "actor-c"],
      resolutionPolicy: "quorum",
      quorum: { expected: 3, threshold: 2 },
    });

    const result = await kernelRouter().ingest(replyEvent("inbound-wait-quorum-first"));

    if (result.kind === "dropped") throw new Error("shape");
    expect(result.sessionId).toBe(wait.ownerRef.id);
    const record = WaitStore.get("wait-quorum");
    expect(record).toMatchObject({ status: "open" });
    expect(record?.replies).toHaveLength(1);
  });

  test("rejects a duplicate reply key with a typed wait_reply_rejected error", async () => {
    registerResponder("actor-external-worker", "seller-1");
    openSessionWait("wait-duplicate", {
      expectedResponders: ["actor-external-worker", "actor-b"],
      resolutionPolicy: "quorum",
      quorum: { expected: 2, threshold: 2 },
    });

    await kernelRouter().ingest(replyEvent("inbound-wait-duplicate"));
    const error = await captureError(kernelRouter().ingest(replyEvent("inbound-wait-duplicate")));

    expect(error).toBeInstanceOf(IngressRoutingError);
    expect((error as IngressRoutingError).code).toBe("wait_reply_rejected");
    expect(error?.message).toBe("wait reply rejected: duplicate_reply");
    const record = WaitStore.get("wait-duplicate");
    expect(record?.replies).toHaveLength(1);
  });

  test("lazily expires an open wait on a late reply and returns the typed rejection", async () => {
    registerResponder("actor-external-worker", "seller-1");
    openSessionWait("wait-late-reply", {
      expectedResponders: ["actor-external-worker", "actor-b"],
      resolutionPolicy: "quorum",
      quorum: { expected: 2, threshold: 2 },
      expiresAt: 10_000,
    });
    // An in-deadline reply recorded partial progress before the wait ran out.
    const early = WaitService.attachReply(
      "wait-late-reply",
      {
        replyKey: "reply-early",
        responderCandidates: ["actor-b"],
        at: 1_000,
      },
      "trace-test",
    );
    expect(early.kind).toBe("attached");

    const error = await captureError(kernelRouter().ingest(replyEvent("inbound-wait-late")));

    expect(error).toBeInstanceOf(IngressRoutingError);
    expect((error as IngressRoutingError).code).toBe("wait_reply_rejected");
    expect(error?.message).toBe("wait reply rejected: deadline_passed");
    // Lazy expiry folded the wait: expired with the partial progress recorded.
    const record = WaitStore.get("wait-late-reply");
    expect(record).toMatchObject({ status: "expired", partial: true });
    expect(record?.replies).toHaveLength(1);
    expect(deliveries).toHaveLength(0);
  });

  test("redelivers a resolved reply to the owner idempotently without a ledger change", async () => {
    registerResponder("actor-external-worker", "seller-1");
    const wait = openSessionWait("wait-redelivery");

    const first = await kernelRouter().ingest(replyEvent("inbound-wait-redelivery"));
    const resolvedRow = WaitStore.get("wait-redelivery");
    expect(resolvedRow).toMatchObject({ status: "resolved" });
    // Channel redelivery of the SAME reply (e.g. the owner delivery crashed
    // mid-projection): the fold short-circuits to already_resolved and the
    // owner receives the recorded resolution again.
    const second = await kernelRouter().ingest(replyEvent("inbound-wait-redelivery"));

    if (first.kind === "dropped") throw new Error("shape");
    if (second.kind === "dropped") throw new Error("shape");
    expect(first.sessionId).toBe(wait.ownerRef.id);
    expect(second.sessionId).toBe(wait.ownerRef.id);
    expect(deliveries).toHaveLength(2);
    // Ledger row unchanged: same revision, same single reply, no new state.
    expect(WaitStore.get("wait-redelivery")).toEqual(resolvedRow);
  });

  test("rejects a sender outside the expected responders with unknown_responder", async () => {
    registerResponder("actor-external-worker", "seller-1");
    registerResponder("actor-intruder", "intruder-2");
    openSessionWait("wait-intruder", { expectedResponders: ["actor-someone-else"] });

    const intruderEvent = { ...replyEvent("inbound-wait-intruder"), userId: "intruder-2" };
    const error = await captureError(kernelRouter().ingest(intruderEvent));

    expect(error).toBeInstanceOf(IngressRoutingError);
    expect((error as IngressRoutingError).code).toBe("wait_reply_rejected");
    expect(error?.message).toBe("wait reply rejected: unknown_responder");
    const record = WaitStore.get("wait-intruder");
    expect(record).toMatchObject({ status: "open" });
    expect(record?.replies).toHaveLength(0);

    // Ledger-lie correction (batch ② commit 4): route.decided already recorded
    // outcome:route for this correlated reply, but the fold rejected it
    // fail-closed. The route stream keeps its single route.decided fact…
    const ledger = Storage.get().ledger;
    if (!ledger) throw new Error("ledger sub-adapter missing");
    expect(ledger.headFact(Ingress.routeStreamId(intruderEvent))?.type).toBe("route.decided");
    // …and the correcting route.not_delivered fact lands on the separate
    // single-fact route_correction stream, reflecting the non-delivery.
    const correction = ledger.headFact(Ingress.routeCorrectionStreamId(intruderEvent));
    expect(correction?.type).toBe("route.not_delivered");
    expect(correction?.seq).toBe(1);
  });

  test("blocks a disallowed action on a matched durable wait instead of surface routing", async () => {
    registerResponder("actor-external-worker", "seller-1");
    openSessionWait("wait-disallowed-action");

    const error = await captureError(
      kernelRouter().ingest(
        replyEvent("inbound-wait-disallowed", { action: "ask_clarification", question: "Why?" }),
      ),
    );

    expect(error).toBeInstanceOf(IngressRoutingError);
    expect((error as IngressRoutingError).code).toBe("route_blocked");
    expect(error?.message).toBe("Matched wait does not allow the requested action");
    expect(routingDecisions()).toHaveLength(1);
    expect(routingDecisions()[0]).toMatchObject({
      stage: "wait_correlation",
      outcome: "block",
      factsUsed: [
        "wait:wait:wait-disallowed-action",
        "wait.action:ask_clarification",
        "wait.action:disallowed",
      ],
    });
    // No surface routing happened: nothing was delivered to the brain.
    expect(deliveries).toHaveLength(0);
    const record = WaitStore.get("wait-disallowed-action");
    expect(record).toMatchObject({ status: "open" });
    expect(record?.replies).toHaveLength(0);
  });

  test("blocks an explicitly invalid action on a matched durable wait instead of coercing to report_result", async () => {
    registerResponder("actor-external-worker", "seller-1");
    openSessionWait("wait-invalid-action");

    const error = await captureError(
      kernelRouter().ingest(
        replyEvent("inbound-wait-invalid-action", { action: "unknown", output: "SN-A2334" }),
      ),
    );

    expect(error).toBeInstanceOf(IngressRoutingError);
    expect((error as IngressRoutingError).code).toBe("route_blocked");
    expect(error?.message).toBe("Matched wait does not allow the requested action");
    expect(routingDecisions()).toHaveLength(1);
    expect(routingDecisions()[0]).toMatchObject({
      stage: "wait_correlation",
      outcome: "block",
      factsUsed: ["wait:wait:wait-invalid-action", "wait.action:invalid", "wait.action:disallowed"],
    });
    expect(deliveries).toHaveLength(0);
    const record = WaitStore.get("wait-invalid-action");
    expect(record).toMatchObject({ status: "open" });
    expect(record?.replies).toHaveLength(0);
  });

  test("fails closed for a workItem-owned wait: no ingress delivery path yet", async () => {
    registerResponder("actor-external-worker", "seller-1");
    openSessionWait("wait-work-item", { ownerRef: { kind: "workItem", id: "wi-1" } });

    const error = await captureError(kernelRouter().ingest(replyEvent("inbound-wait-work-item")));

    expect(error).toBeInstanceOf(IngressRoutingError);
    expect((error as IngressRoutingError).code).toBe("route_blocked");
    expect(error?.message).toBe("Matched wait owner has no ingress delivery path");
    expect(routingDecisions()[0]).toMatchObject({
      stage: "wait_correlation",
      outcome: "block",
      factsUsed: [
        "wait:wait:wait-work-item",
        "wait.action:report_result",
        "wait.owner:workItem:wi-1",
        "wait.owner:unsupported_ingress_delivery",
      ],
    });
    const record = WaitStore.get("wait-work-item");
    expect(record).toMatchObject({ status: "open" });
    expect(record?.replies).toHaveLength(0);
  });

  test("resolves an awaited 2-of-3 send through router replies from two distinct responder endpoints", async () => {
    // Wired N-of-M proof (#215 Phase E): the awaited message is DELIVERED to
    // a third target actor, while the expected responders answer from their
    // OWN registered endpoints in the same channel, through the full router
    // path (ingressEvidence — no dispatch-phase shortcut).
    registerResponder("actor-r1", "responder-1");
    registerResponder("actor-r2", "responder-2");
    registerResponder("actor-quorum-target", "quorum-target-1");
    const ownerSessionId = crypto.randomUUID();
    const messaging = createExistingAgentMessaging({
      // Concrete-owner shape: the channel API returned a platform message id.
      deliver: () => ({ externalMessageId: "platform-quorum-msg" }),
      grants: () => [
        {
          id: "grant-owner->quorum-target",
          senderId: "actor-owner",
          targetActorId: "actor-quorum-target",
          operations: ["awaited"],
        },
      ],
      publish: Bus.publish,
    });

    const sent = await messaging.send({
      messageId: "out-wired-quorum",
      senderId: "actor-owner",
      target: { actorId: "actor-quorum-target" },
      operation: "awaited",
      body: "reply with your verdict (2-of-3)",
      at: Date.now(),
      traceId: "trace-test",
      waitSpec: {
        waitId: "wait-wired-quorum",
        ownerRef: { kind: "session", id: ownerSessionId },
        allowedActions: ["report_result"],
        expectedResponders: ["actor-r1", "actor-r2", "actor-r3"],
        resolutionPolicy: "quorum",
        quorum: { expected: 3, threshold: 2 },
        expiresAt: Number.MAX_SAFE_INTEGER,
        followUpWindow: 60_000,
        correlation: { channelId: correlation.channelId },
      },
    });
    expect(sent.kind).toBe("sent");
    if (sent.kind !== "sent" || sent.operation !== "awaited") {
      throw new Error("expected awaited sent receipt");
    }
    // Delivery pinned the third target's endpoint; the receipt re-keyed the
    // correlation to the platform message id real replies will reference.
    expect(sent.wait.correlation.endpointId).toBe("telegram:quorum-target-1");
    expect(sent.wait.correlation.replyToMessageId).toBe("platform-quorum-msg");

    const responderReply = (id: string, externalId: string): Gateway.DeliveredEvent => ({
      ...replyEvent(id),
      userId: externalId,
      meta: {
        correlation: {
          endpointId: `telegram:${externalId}`,
          channelId: correlation.channelId,
          replyToMessageId: "platform-quorum-msg",
        },
      },
    });

    const first = await kernelRouter().ingest(responderReply("inbound-wired-r1", "responder-1"));
    const afterFirst = WaitStore.get("wait-wired-quorum");
    expect(afterFirst).toMatchObject({ status: "open" });
    expect(afterFirst?.replies).toHaveLength(1);

    const second = await kernelRouter().ingest(responderReply("inbound-wired-r2", "responder-2"));

    if (first.kind === "dropped") throw new Error("shape");
    if (second.kind === "dropped") throw new Error("shape");
    expect(first.sessionId).toBe(ownerSessionId);
    expect(second.sessionId).toBe(ownerSessionId);
    expect(deliveries).toHaveLength(2);
    const record = WaitStore.get("wait-wired-quorum");
    expect(record).toMatchObject({ status: "resolved", partial: false });
    expect(record?.replies.map((reply) => reply.responderId).sort()).toEqual([
      "actor-r1",
      "actor-r2",
    ]);
  });

  test("a new interaction goes through the durable Wait only — the frozen store admits no rows (#548)", async () => {
    registerResponder("actor-external-worker", "seller-1");
    const wait = openSessionWait("wait-new-interaction");

    const result = await kernelRouter().ingest(replyEvent("inbound-new-interaction"));

    if (result.kind === "dropped") throw new Error("shape");
    expect(result.sessionId).toBe(wait.ownerRef.id);
    expect(WaitStore.get("wait-new-interaction")).toMatchObject({ status: "resolved" });
    // No PendingInteraction row exists or can be created: the write surface
    // is frozen (#548) and every new interaction lives in the wait table.
    const adapter = Storage.getAdapter().pendingInteraction;
    if (!adapter) throw new Error("pendingInteraction adapter missing");
    expect(adapter.list()).toHaveLength(0);
    let thrown: unknown;
    try {
      PendingInteractionStore.create({
        id: "pi-new-after-freeze",
        workerRunId: "run-new-after-freeze",
        sessionId: wait.ownerRef.id,
        endpointId: correlation.endpointId,
        channelId: correlation.channelId,
        correlation: { tokenHash: correlation.tokenHash },
        allowedActions: ["report_result"],
        expiresAt: Number.MAX_SAFE_INTEGER,
        followUpWindow: 60_000,
      });
    } catch (error) {
      thrown = error;
    }
    if (!Communication.PendingInteraction.FrozenError.isInstance(thrown)) {
      throw new Error("expected the typed PendingInteractionFrozenError");
    }
    expect(thrown.data.code).toBe("pending_interaction_frozen");
    expect(thrown.data.method).toBe("create");
    expect(adapter.list()).toHaveLength(0);
  });

  test("fails closed when a durable wait and a frozen legacy row collide at one level", async () => {
    registerResponder("actor-external-worker", "seller-1");
    // The wait table is the first tier: a durable wait shadows same-token
    // frozen legacy rows instead of guessing between backings.
    seedFrozenPending("pi-shadowed", "run-shadowed");
    const wait = openSessionWait("wait-tier-first");

    const result = await kernelRouter().ingest(replyEvent("inbound-wait-tier"));

    if (result.kind === "dropped") throw new Error("shape");
    expect(result.sessionId).toBe(wait.ownerRef.id);
    expect(PendingInteractionStore.get("pi-shadowed")?.status).toBe("open");
  });
});
