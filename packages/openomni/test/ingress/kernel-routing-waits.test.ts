import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Dispatch, IngressEvent, type Ingress, Wait } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { DispatchRuntime } from "../../src/dispatch/runtime";
import { IngressEngine } from "../../src/ingress/engine";
import {
  executeWaitRoute,
  IngressRoutingError,
  requireRoutedDecision,
} from "../../src/ingress/routing-execution";
import { resolveKernelRoute } from "../../src/ingress/routing-runtime";
import type {
  DurableWaitV1,
  WaitCorrelationCandidate,
  WaitKernelService,
} from "../../src/ingress/wait-correlation";
import type { AuthorityProjectionQueryPort } from "../../src/ingress/actor-resolver";

const refs = {
  sourceEventId: "authority-event-1",
  sourceOwnerSeq: 1,
  sourceLedgerSeq: 1,
  sourceOwnerHash: "a".repeat(64),
  asOfLedgerSeq: 1,
} as const;
const tokenHash = "b".repeat(64);
const correlation = {
  endpointId: "endpoint-seller",
  channelId: "telegram:dm",
  tokenHash,
} satisfies Dispatch.Correlation;

function opened(
  waitId: string,
  allowedActions: readonly Wait.AllowedActionV1[] = ["report_result"],
): Wait.OpenedV1 {
  return Wait.OpenedV1.parse({
    version: "wait.opened.v1",
    waitId,
    ownerRef: { version: "wait-owner-ref-v1", kind: "workItem", id: `work-${waitId}` },
    expectedResponders: [
      {
        version: "wait-responder-ref-v1",
        actorId: "actor-seller",
        endpointId: correlation.endpointId,
      },
    ],
    targetActorId: "actor-seller",
    endpointId: correlation.endpointId,
    channelId: correlation.channelId,
    correlation: { version: "wait-correlation-v1", tokenHash },
    allowedActions,
    resolutionPolicy: "first-response",
    quorum: { version: "wait-quorum-v1", required: 1, total: 1 },
    status: "open",
    deadline: Number.MAX_SAFE_INTEGER,
    partial: false,
    followUpWindow: 60_000,
  });
}

function workerWait(
  waitId: string,
  allowedActions: readonly Wait.AllowedActionV1[] = ["report_result"],
): DurableWaitV1 & Readonly<{ route: { kind: "worker" } }> {
  return {
    waitId,
    revision: "1",
    opened: opened(waitId, allowedActions),
    status: "open",
    route: { kind: "worker", sessionId: `session-${waitId}`, runId: `run-${waitId}` },
  };
}

function residentWait(waitId: string, runId?: string): DurableWaitV1 {
  return {
    waitId,
    revision: "1",
    opened: opened(waitId),
    status: "open",
    route: {
      kind: "resident",
      sessionId: `session-${waitId}`,
      ...(runId === undefined ? {} : { runId }),
    },
  };
}

function replyEvent(id: string, payload: unknown = { action: "report_result", output: "done" }) {
  return {
    id,
    surface: "telegram",
    channel: correlation.channelId,
    userId: "seller",
    mode: "direct" as const,
    payload,
    meta: {
      correlation,
      actor: {
        actorId: "actor-seller",
        trustTier: "assigned_worker" as const,
        endpointId: correlation.endpointId,
        endpoint: {
          id: correlation.endpointId,
          actorId: "actor-seller",
          channel: "telegram",
          externalId: "seller",
        },
      },
    },
    agent: {
      model: { provider: "test", id: "fixture" },
      toolConfig: { workspaceRoot: "/trusted/workspace" },
    },
  } satisfies Ingress.DirectEvent;
}

function authority(
  entry: null | { id: string; kind: "actor"; value: string; reason?: string } = null,
) {
  return {
    async query(request) {
      if (request.kind === "authority.blacklist_match") {
        return { ...refs, kind: request.kind, entry };
      }
      if (request.kind === "authority.channel_grant") {
        return {
          ...refs,
          kind: request.kind,
          grant: {
            id: "grant-telegram",
            surface: "telegram",
            channel: correlation.channelId,
            kind: "trusted_channel",
            createdBy: "actor-owner",
          },
        };
      }
      if (request.kind === "authority.actor_by_endpoint") {
        return {
          ...refs,
          kind: request.kind,
          endpointSourceRefs: refs,
          identitySourceRefs: refs,
          identity: {
            id: "actor-seller",
            kind: "human",
            trustTier: "assigned_worker",
            relationship: "external_agent",
          },
          endpoint: {
            id: correlation.endpointId,
            actorId: "actor-seller",
            channel: "telegram",
            externalId: "seller",
          },
        };
      }
      return { ...refs, kind: request.kind, grant: null };
    },
  } satisfies AuthorityProjectionQueryPort;
}

function waitFixture(resolution: Awaited<ReturnType<WaitKernelService["correlate"]>>) {
  const calls = {
    accepted: 0,
    settled: 0,
    marked: 0,
    ambiguities: 0,
  };
  let current = resolution.kind === "match" ? resolution.candidate.wait : undefined;
  const service: WaitKernelService = {
    async correlate() {
      return resolution;
    },
    async revalidatePinned() {
      return current === undefined
        ? { kind: "invalid", reason: "wait missing" }
        : { kind: "valid", wait: current };
    },
    async acceptResponse(input) {
      calls.accepted += 1;
      if (current === undefined) throw new Error("wait missing");
      current = {
        ...current,
        revision: "2",
        status: "resolved",
        resolvedAtDbMs: 1,
        routingDeadlineDbMs: Number.MAX_SAFE_INTEGER,
        routedDispatchId: `dispatch-${input.waitId}`,
        routedAction: input.action,
      };
      return current;
    },
    async settle() {
      calls.settled += 1;
      if (current === undefined) throw new Error("wait missing");
      return current;
    },
    async cancel() {
      return undefined;
    },
    async stageAmbiguity() {
      calls.ambiguities += 1;
    },
    async markRouted() {
      calls.marked += 1;
    },
  };
  return { service, calls, current: () => current };
}

function candidateKey(wait: DurableWaitV1): string {
  return `${wait.route.kind === "worker" ? "pending_interaction" : "pending_ask"}:${wait.waitId}`;
}

function exact(wait: DurableWaitV1): { kind: "match"; candidate: WaitCorrelationCandidate } {
  return { kind: "match", candidate: { key: candidateKey(wait), wait } };
}

async function route(waitService: WaitKernelService, event = replyEvent("inbound-reply")) {
  return resolveKernelRoute(event, "trace-routing", {
    authorityQueries: authority(),
    waits: waitService,
  });
}

async function captureError(action: Promise<unknown>): Promise<Error | undefined> {
  try {
    await action;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  return undefined;
}

describe("native ingress Wait routing", () => {
  afterEach(() => IngressEngine.reset());

  it("publishes ambiguity before staging it and neither guesses nor consumes a Wait", async () => {
    const first = workerWait("ambiguous-a");
    const second = workerWait("ambiguous-b");
    const fixture = waitFixture({
      kind: "ambiguous",
      candidates: [
        { key: candidateKey(first), wait: first },
        { key: candidateKey(second), wait: second },
      ],
    });
    const order: string[] = [];
    const actualPublish = Bus.publish;
    const publish = spyOn(Bus, "publish").mockImplementation((event, payload) => {
      if (event === IngressEvent.RoutingDecision) order.push("publish");
      actualPublish(event, payload);
    });
    fixture.service.stageAmbiguity = async () => {
      order.push("stage");
      fixture.calls.ambiguities += 1;
    };
    let residentRuns = 0;
    IngressEngine.setResidentRuntime({
      async run() {
        residentRuns += 1;
        throw new Error("Resident must not execute");
      },
    } as never);
    IngressEngine.setKernelPorts({
      authorityQueries: authority(),
      waitQueries: fixture.service,
      waitTransitions: fixture.service,
      workerAttempts: {} as never,
    });

    try {
      const error = await captureError(IngressEngine.ingest(replyEvent("inbound-ambiguous")));
      expect(error).toBeInstanceOf(IngressRoutingError);
      expect((error as IngressRoutingError).code).toBe("route_ambiguous");
      expect((error as IngressRoutingError).decision).toMatchObject({
        stage: "wait_correlation",
        outcome: "ambiguous",
        candidateInteractionIds: [
          "pending_interaction:ambiguous-a",
          "pending_interaction:ambiguous-b",
        ],
      });
      expect(order).toEqual(["publish", "stage"]);
      expect(fixture.calls).toEqual({ accepted: 0, settled: 0, marked: 0, ambiguities: 1 });
      expect(residentRuns).toBe(0);
    } finally {
      publish.mockRestore();
    }
  });

  it("suppresses an already-gathered ambiguity effect when blacklist wins", async () => {
    const first = workerWait("blocked-a");
    const second = workerWait("blocked-b");
    const fixture = waitFixture({
      kind: "ambiguous",
      candidates: [
        { key: candidateKey(first), wait: first },
        { key: candidateKey(second), wait: second },
      ],
    });
    const resolution = await resolveKernelRoute(
      replyEvent("inbound-blacklisted"),
      "trace-blacklist",
      {
        authorityQueries: authority({
          id: "blacklist-seller",
          kind: "actor",
          value: "actor-seller",
          reason: "revoked sender",
        }),
        waits: fixture.service,
      },
    );
    const accepted = requireRoutedDecision(resolution.decision);
    const execution = await executeWaitRoute(
      undefined,
      { traceId: "trace-blacklist" },
      resolution,
      accepted,
    );

    expect(resolution.decision).toMatchObject({ stage: "blacklist", outcome: "drop" });
    expect(resolution.waitEffect).toEqual({ kind: "none" });
    expect(execution).toMatchObject({ kind: "handled", result: { kind: "dropped" } });
    expect(fixture.calls).toEqual({ accepted: 0, settled: 0, marked: 0, ambiguities: 0 });
  });

  it("binds the sender and pins the matched target, session, and run", async () => {
    const wait = workerWait("pinned");
    const fixture = waitFixture(exact(wait));
    const runtime = new DispatchRuntime({
      waitKernel: fixture.service,
      authorityQueries: authority(),
      includeDefaultPolicies: false,
    });
    let command: Dispatch.Command | undefined;
    runtime.register(Dispatch.Actions.WorkerComplete, (value) => {
      command = value;
      return { output: "projected output" };
    });
    const poisoned = {
      ...replyEvent("inbound-pinned"),
      target: { kind: "worker" as const, sessionId: "stale-target" },
      meta: {
        ...replyEvent("inbound-pinned").meta,
        target: { kind: "worker" as const, sessionId: "stale-meta-target" },
      },
      runtime: { durableSessionId: "stale-session", runId: "stale-run" },
    };
    const resolution = await route(fixture.service, poisoned);
    const execution = await executeWaitRoute(
      runtime,
      { traceId: "trace-routing" },
      resolution,
      requireRoutedDecision(resolution.decision),
    );

    expect(resolution.decision).toMatchObject({
      stage: "wait_correlation",
      target: `worker-session:${wait.route.sessionId}`,
      sessionId: wait.route.sessionId,
      runId: wait.route.runId,
      pendingInteractionId: wait.waitId,
    });
    expect(command).toMatchObject({
      action: "worker.complete",
      target: { kind: "worker", sessionId: wait.route.sessionId, runId: wait.route.runId },
      sessionId: wait.route.sessionId,
      runId: wait.route.runId,
      actor: { actorId: "actor-seller", sessionId: wait.route.sessionId, runId: wait.route.runId },
    });
    expect(execution).toMatchObject({
      kind: "handled",
      result: {
        target: { kind: "worker", sessionId: wait.route.sessionId },
        sessionId: wait.route.sessionId,
        result: { output: "projected output" },
      },
    });
    expect(fixture.calls.accepted).toBe(1);
    expect(fixture.calls.marked).toBe(1);
  });

  it("pins a PendingAsk to its Resident session and removes poisoned target and run facts", async () => {
    const wait = residentWait("resident-ask", "run-resident-owner");
    const fixture = waitFixture(exact(wait));
    const event = {
      ...replyEvent("inbound-resident-ask", "answer"),
      target: { kind: "worker" as const, sessionId: "stale-target" },
      meta: {
        ...replyEvent("inbound-resident-ask").meta,
        target: { kind: "worker" as const, sessionId: "stale-meta-target" },
      },
      runtime: { durableSessionId: "stale-session", runId: "stale-run", activationId: "keep-me" },
    };
    const resolution = await route(fixture.service, event);
    const execution = await executeWaitRoute(
      undefined,
      { traceId: "trace-routing" },
      resolution,
      requireRoutedDecision(resolution.decision),
    );

    expect(resolution.decision).toMatchObject({
      stage: "wait_correlation",
      outcome: "route",
      target: "resident",
      sessionId: wait.route.sessionId,
      runId: "run-resident-owner",
    });
    expect(execution).toMatchObject({
      kind: "continue",
      authority: "wait_precedence",
      event: {
        runtime: {
          durableSessionId: wait.route.sessionId,
          runId: "run-resident-owner",
          activationId: "keep-me",
        },
        meta: {
          pendingAsk: {
            id: wait.waitId,
            originSessionId: wait.route.sessionId,
            originActorKind: "worker",
            targetKind: "external_actor",
          },
        },
      },
    });
    if (execution.kind !== "continue") throw new Error("expected PendingAsk continuation");
    expect(execution.event).not.toHaveProperty("target");
    expect(execution.event.meta).not.toHaveProperty("target");
    expect(fixture.calls.accepted).toBe(0);
  });

  it("rejects a mismatched resolved sender before accepting or executing the response", async () => {
    const wait = workerWait("sender-bound");
    const fixture = waitFixture(exact(wait));
    const runtime = new DispatchRuntime({
      waitKernel: fixture.service,
      authorityQueries: authority(),
      includeDefaultPolicies: false,
    });
    let executions = 0;
    runtime.register(Dispatch.Actions.WorkerComplete, () => {
      executions += 1;
      return { output: "must not execute" };
    });
    const event = replyEvent("inbound-intruder");
    const intruder = {
      ...event,
      meta: {
        ...event.meta,
        actor: {
          ...event.meta.actor,
          actorId: "actor-intruder",
          endpointId: "endpoint-intruder",
          endpoint: {
            id: "endpoint-intruder",
            actorId: "actor-intruder",
            channel: "telegram",
            externalId: "intruder",
          },
        },
      },
    };
    const resolution = await route(fixture.service, intruder);
    const error = await captureError(
      executeWaitRoute(
        runtime,
        { traceId: "trace-routing" },
        resolution,
        requireRoutedDecision(resolution.decision),
      ),
    );

    expect(error).toBeInstanceOf(IngressRoutingError);
    expect((error as IngressRoutingError).code).toBe("dispatch_route_invalid");
    expect(fixture.calls.accepted).toBe(0);
    expect(fixture.calls.marked).toBe(0);
    expect(executions).toBe(0);
  });

  it.each([
    ["ask_clarification", ["report_result"]],
    ["attach_artifact", ["attach_artifact"]],
  ] as const)("blocks disallowed or unsupported %s without executing it", async (action, allowed) => {
    const wait = workerWait(`blocked-${action}`, allowed);
    const fixture = waitFixture(exact(wait));
    const resolution = await route(
      fixture.service,
      replyEvent(`inbound-${action}`, { action, question: "details" }),
    );
    let executions = 0;
    const runtime = new DispatchRuntime({
      waitKernel: fixture.service,
      authorityQueries: authority(),
      includeDefaultPolicies: false,
    });
    runtime.register(Dispatch.Actions.ActorMessage, () => {
      executions += 1;
      return { output: "must not execute" };
    });
    const error = await captureError(
      Promise.resolve().then(() => requireRoutedDecision(resolution.decision)),
    );

    expect(error).toBeInstanceOf(IngressRoutingError);
    expect((error as IngressRoutingError).code).toBe("route_blocked");
    expect(resolution.decision).toMatchObject({ stage: "channel_ceiling", outcome: "block" });
    expect(fixture.calls.accepted).toBe(0);
    expect(fixture.calls.marked).toBe(0);
    expect(executions).toBe(0);
  });

  it("leaves a failed dispatch effect unconsumed and projects only safe outputs", async () => {
    const failedWait = workerWait("failed-effect");
    const failedFixture = waitFixture(exact(failedWait));
    const failedRuntime = new DispatchRuntime({
      waitKernel: failedFixture.service,
      authorityQueries: authority(),
      includeDefaultPolicies: false,
    });
    const failedResolution = await route(failedFixture.service, replyEvent("inbound-failed"));
    const failed = await captureError(
      executeWaitRoute(
        failedRuntime,
        { traceId: "trace-routing" },
        failedResolution,
        requireRoutedDecision(failedResolution.decision),
      ),
    );
    expect(failed).toBeInstanceOf(IngressRoutingError);
    expect((failed as IngressRoutingError).code).toBe("dispatch_failed");
    expect(failedFixture.calls.accepted).toBe(0);
    expect(failedFixture.calls.marked).toBe(0);

    const structuredWait = workerWait("structured-output");
    const structuredFixture = waitFixture(exact(structuredWait));
    const structuredRuntime = new DispatchRuntime({
      waitKernel: structuredFixture.service,
      authorityQueries: authority(),
      includeDefaultPolicies: false,
    });
    structuredRuntime.register(Dispatch.Actions.WorkerComplete, () => ({
      output: { internal: "not channel text" },
    }));
    const structuredResolution = await route(
      structuredFixture.service,
      replyEvent("inbound-structured"),
    );
    const structured = await executeWaitRoute(
      structuredRuntime,
      { traceId: "trace-routing" },
      structuredResolution,
      requireRoutedDecision(structuredResolution.decision),
    );
    expect(structured).toMatchObject({ kind: "handled", result: { result: { output: "" } } });
  });
});
