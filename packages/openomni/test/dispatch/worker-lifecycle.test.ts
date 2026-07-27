import { describe, expect, test } from "bun:test";
import { Execution, type Dispatch, Wait } from "@openomni/protocol";
import { createWorkerDispatchHandlers } from "../../src/dispatch/handlers/worker.js";
import type {
  WorkerLedgerBinding,
  WorkerLedgerSemanticRequestV1,
  WorkerLedgerService,
} from "../../src/dispatch/handlers/worker-work-item.js";
import {
  createWorkWaitServices,
  type EffectRecordV1,
  type WorkAttemptRecordV1,
  type WaitRecordV1,
  type WorkRecordV1,
  type WorkWaitCommitV1,
} from "../../src/ledger/production/work-wait.js";

const binding: WorkerLedgerBinding = {
  owner: { version: "ledger-owner-v1", ownerKey: "work:work-1" },
  workItemId: "work-1",
  runId: "run-1",
  attempt: { version: "attempt-ref-v1", workItemId: "work-1", attemptId: "run-1", attemptSeq: 1 },
  status: "running",
  evidenceRefs: [],
  readbackRefs: [],
};

const effectBinding = {
  effect: { version: "effect-ref-v1" as const, effectId: "effect-1", idempotencyKey: "dispatch-1" },
  effectScope: {
    version: "effect-scope-v1" as const,
    workspace: {
      canonicalizerVersion: "workspace-v1" as const,
      workspaceId: "workspace-1",
      canonicalBytesDigest: "a".repeat(64),
    },
    resources: [
      { version: "resource-scope-v1" as const, kind: "workspace" as const, target: "**" as const },
    ],
    resolver: { id: "worker-dispatch", version: "v1", inputDigest: "b".repeat(64) },
    containment: "none" as const,
    mutationClass: "unknown" as const,
  },
};

function command(action: string): Dispatch.Command {
  return {
    action,
    dispatchId: "dispatch-1",
    actor: { kind: "resident", actorId: "resident-1", sessionId: "resident-session" },
    target: { kind: "worker", sessionId: "worker-session", runId: "run-1" },
    payload: { text: "continue" },
    submittedAt: 1,
  };
}

function requireValue<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function ledger(requests: WorkerLedgerSemanticRequestV1[]): WorkerLedgerService {
  return {
    async commitSemanticTransition(request) {
      requests.push(request);
      return {
        transitionResult: {
          version: "kernel-transition-result-v1",
          status: "committed",
          receipt: {} as never,
        },
        ...(request.transitionId.startsWith("DP-1") ? { effectBinding } : {}),
      };
    },
    async resolveWorkByRunId() {
      return binding;
    },
    async resolveAttemptByRunId() {
      return binding;
    },
  };
}

function productionServices(commits: WorkWaitCommitV1[]) {
  const work: WorkRecordV1 = {
    workItemId: "work-1",
    sessionId: "worker-session",
    title: "Worker",
    status: "running",
    evidenceRefs: [],
    readbackRefs: [],
  };
  let attempt: WorkAttemptRecordV1 = {
    workItemId: "work-1",
    attemptId: "run-1",
    attemptSeq: 1,
    sessionId: "worker-session",
    runId: "run-1",
    status: "running",
    title: "Worker",
    prompt: "work",
    agentName: "worker",
    model: { provider: "openai", id: "gpt-test" },
    environment: Execution.LLMEnvironmentV1.parse({
      version: "llm-environment-v1",
      catalogSchemaVersion: 1,
      catalogSource: "bundled",
      catalogSourceVersion: "1",
      catalogDigest: "c".repeat(64),
      modelDigest: "d".repeat(64),
      endpoint: {
        version: "llm-endpoint-ref-v1",
        kind: "default",
        valueRef: "openai",
        endpointDigest: "e".repeat(64),
      },
      credential: {
        version: "credential-source-ref-v1",
        providerId: "openai",
        authType: "api",
        credentialId: "test",
        rotationId: "1",
        sourceKind: "injected_runtime",
        sourcePathDigest: "f".repeat(64),
        credentialDigest: "0".repeat(64),
      },
      sdkPackage: "@ai-sdk/openai",
      adapterVersion: "1",
      environmentDigest: "1".repeat(64),
    }),
  };
  const effects = new Map<string, EffectRecordV1>();
  effects.set("credential-provisioning:run-1", {
    effectId: "credential-provisioning:run-1",
    sourceRef: "credential-provisioning:run-1",
    workItemId: attempt.workItemId,
    attemptId: attempt.attemptId,
    attempt: binding.attempt,
    settlement: "pending",
    operation: "worker.credential_provision.v1",
  });
  effects.set("coordinator-spawn:run-1", {
    effectId: "coordinator-spawn:run-1",
    sourceRef: "worker-allocation:run-1",
    workItemId: attempt.workItemId,
    attemptId: attempt.attemptId,
    attempt: binding.attempt,
    settlement: "pending",
    operation: "coordinator.spawn.v1",
  });
  const waitOwner = {
    version: "wait-owner-ref-v1" as const,
    kind: "workItem" as const,
    id: attempt.workItemId,
  };
  const waitResponder = {
    version: "wait-responder-ref-v1" as const,
    actorId: "owner",
    endpointId: "owner-endpoint",
  };
  const waitResponse = Wait.ResponseRecordedV1.parse({
    version: "wait.response_recorded.v1",
    waitId: "wait-resolved",
    ownerRef: waitOwner,
    responder: waitResponder,
    transportId: "transport-resolved",
    responseHash: "a".repeat(64),
    action: "report_result",
    payloadRef: "payload-resolved",
    recordedAtDbMs: 2,
  });
  const resolvedWait: WaitRecordV1 = {
    waitId: "wait-resolved",
    revision: "wait-revision-resolved",
    opened: Wait.OpenedV1.parse({
      version: "wait.opened.v1",
      waitId: "wait-resolved",
      ownerRef: waitOwner,
      expectedResponders: [waitResponder],
      correlation: { version: "wait-correlation-v1", tokenHash: "b".repeat(64) },
      allowedActions: ["report_result"],
      resolutionPolicy: "all",
      quorum: { version: "wait-quorum-v1", required: 1, total: 1 },
      status: "open",
      deadline: 10,
      partial: false,
      followUpWindow: 0,
      attempt: binding.attempt,
    }),
    status: "resolved",
    route: { kind: "worker", sessionId: attempt.sessionId, runId: attempt.runId },
    workItemId: attempt.workItemId,
    attemptId: attempt.attemptId,
    sessionId: attempt.sessionId,
    responses: [{ ...waitResponse, eventId: "wait-response-event" }],
    ambiguities: [],
    resolved: Wait.ResolvedV1.parse({
      version: "wait.resolved.v1",
      waitId: "wait-resolved",
      ownerRef: waitOwner,
      responseEventIds: ["wait-response-event"],
      quorum: { version: "wait-quorum-v1", required: 1, total: 1 },
      partial: false,
      resolvedAtDbMs: 3,
    }),
    resolvedAtDbMs: 3,
  };
  const services = createWorkWaitServices(
    {
      async work() {
        return work;
      },
      async completion() {
        return undefined;
      },
      async attempt() {
        return attempt;
      },
      async attemptByRunId() {
        return attempt;
      },
      async attemptsBySession() {
        return [attempt];
      },
      async wait(id) {
        return id === resolvedWait.waitId ? resolvedWait : undefined;
      },
      async waitCandidates() {
        return [];
      },
      async waitsByAttempt() {
        return [resolvedWait];
      },
      async effect(effectId) {
        return effects.get(effectId);
      },
    },
    {
      async commit(command) {
        commits.push(command);
        if ("attempt" in command) attempt = command.attempt;
        if ("effect" in command) effects.set(command.effect.effectId, command.effect);
        return {
          transitionResult: {
            version: "kernel-transition-result-v1",
            status: "committed",
            receipt: {} as never,
          },
          ...("effectScope" in command && command.effect.settlement === "pending"
            ? {
                effectBinding: {
                  effect: {
                    version: "effect-ref-v1" as const,
                    effectId: command.effect.effectId,
                    idempotencyKey: command.effect.sourceRef,
                  },
                  effectScope: command.effectScope,
                },
              }
            : {}),
        };
      },
    },
    {
      model: attempt.model,
      modelEnvironment: attempt.environment,
      workerEffectScope: () => effectBinding.effectScope,
    },
  );
  return {
    ...services,
    effects,
    setAttempt(value: WorkAttemptRecordV1) {
      attempt = value;
    },
  };
}

describe("Worker dispatch lifecycle", () => {
  test("DP-12 lost-ack replay reconciles pending and returns terminal without duplicate intent", async () => {
    const commits: WorkWaitCommitV1[] = [];
    const services = productionServices(commits);
    const claimed = {
      workItemId: "work-1",
      attemptId: "run-1",
      attemptSeq: 1,
      sessionId: "worker-session",
      runId: "run-1",
      status: "running" as const,
    };
    const disposition = await services.workerAttempts.commands.requestDelivery({
      attempt: claimed,
      deliveryId: "inbound-event-1",
      payload: "resume",
    });
    expect(disposition.disposition).toBe("act");
    if (disposition.disposition !== "act") throw new Error("expected new delivery intent");
    const delivery = disposition.delivery;
    const pendingReplay = await services.workerAttempts.commands.requestDelivery({
      attempt: claimed,
      deliveryId: "inbound-event-1",
      payload: "resume",
    });
    expect(pendingReplay).toMatchObject({
      disposition: "reconcile",
      outcome: "pending",
      delivery,
    });
    expect(commits.map(({ transitionId }) => transitionId)).toEqual(["DP-12"]);
    await services.workerAttempts.commands.settleDelivery({
      attempt: claimed,
      delivery,
      accepted: true,
    });
    const terminalReplay = await services.workerAttempts.commands.requestDelivery({
      attempt: claimed,
      deliveryId: "inbound-event-1",
      payload: "resume",
    });
    expect(terminalReplay).toMatchObject({
      disposition: "terminal",
      outcome: "confirmed",
      delivery,
    });

    expect(commits.map(({ transitionId }) => transitionId)).toEqual(["DP-12", "EF-01"]);
    expect(commits[0]).toMatchObject({
      requestId: "ingress-delivery:inbound-event-1",
      dispatch: { dispatchId: "ingress-delivery:inbound-event-1" },
      effect: {
        sourceRef: "ingress-delivery:inbound-event-1",
        operation: "coordinator.message.v1",
        settlement: "pending",
      },
    });
    expect(commits[1]).toMatchObject({
      effect: {
        effectId: delivery.effect.effectId,
        sourceRef: delivery.effect.idempotencyKey,
        settlement: "confirmed",
      },
    });
  });

  test("unknown direct delivery replay is non-actionable reconciliation", async () => {
    const commits: WorkWaitCommitV1[] = [];
    const services = productionServices(commits);
    const claimed = {
      workItemId: "work-1",
      attemptId: "run-1",
      attemptSeq: 1,
      sessionId: "worker-session",
      runId: "run-1",
      status: "running" as const,
    };
    const disposition = await services.workerAttempts.commands.requestDelivery({
      attempt: claimed,
      deliveryId: "unknown-delivery",
      payload: "resume",
    });
    if (disposition.disposition !== "act") throw new Error("expected new delivery intent");
    const effect = services.effects.get(disposition.delivery.effect.effectId);
    if (!effect) throw new Error("expected durable delivery effect");
    services.effects.set(effect.effectId, { ...effect, settlement: "unknown" });

    await expect(
      services.workerAttempts.commands.requestDelivery({
        attempt: claimed,
        deliveryId: "unknown-delivery",
        payload: "resume",
      }),
    ).resolves.toMatchObject({ disposition: "reconcile", outcome: "unknown" });
    expect(commits.map(({ transitionId }) => transitionId)).toEqual(["DP-12"]);
  });

  test("AT-12 lost-ack replay reconciles pending and returns terminal without duplicate intent", async () => {
    for (const accepted of [true, false]) {
      const commits: WorkWaitCommitV1[] = [];
      const services = productionServices(commits);
      const waiting = {
        workItemId: "work-1",
        attemptId: "run-1",
        attemptSeq: 1,
        sessionId: "worker-session",
        runId: "run-1",
        status: "waiting" as const,
        title: "Worker",
        prompt: "work",
        agentName: "worker",
        model: { provider: "openai", id: "gpt-test" },
        environment: Execution.LLMEnvironmentV1.parse({
          version: "llm-environment-v1",
          catalogSchemaVersion: 1,
          catalogSource: "bundled",
          catalogSourceVersion: "1",
          catalogDigest: "c".repeat(64),
          modelDigest: "d".repeat(64),
          endpoint: {
            version: "llm-endpoint-ref-v1",
            kind: "default",
            valueRef: "openai",
            endpointDigest: "e".repeat(64),
          },
          credential: {
            version: "credential-source-ref-v1",
            providerId: "openai",
            authType: "api",
            credentialId: "test",
            rotationId: "1",
            sourceKind: "injected_runtime",
            sourcePathDigest: "f".repeat(64),
            credentialDigest: "0".repeat(64),
          },
          sdkPackage: "@ai-sdk/openai",
          adapterVersion: "1",
          environmentDigest: "1".repeat(64),
        }),
      };
      services.setAttempt(waiting);
      const disposition =
        await services.messagingWaitLifecycle.commands.resumeAfterResolvedWait("wait-resolved");
      expect(disposition.disposition).toBe("act");
      if (disposition.disposition !== "act") throw new Error("expected new resume intent");
      const delivery = disposition.delivery;
      const pendingReplay =
        await services.messagingWaitLifecycle.commands.resumeAfterResolvedWait("wait-resolved");
      expect(pendingReplay).toMatchObject({
        disposition: "reconcile",
        outcome: "pending",
        delivery,
      });
      expect(commits.map(({ transitionId }) => transitionId)).toEqual(["AT-12"]);
      await services.workerAttempts.commands.settleDelivery({
        attempt: waiting,
        delivery,
        accepted,
      });
      const terminalReplay =
        await services.messagingWaitLifecycle.commands.resumeAfterResolvedWait("wait-resolved");
      expect(terminalReplay).toMatchObject({
        disposition: "terminal",
        outcome: accepted ? "confirmed" : "definite_failed",
        delivery,
      });

      expect(commits.map(({ transitionId }) => transitionId)).toEqual([
        "AT-12",
        accepted ? "AT-03" : "AT-13",
      ]);
      expect(commits[0]).toMatchObject({
        waitResume: { waitId: "wait-resolved" },
        effect: {
          effectId: delivery.effect.effectId,
          sourceRef: delivery.effect.idempotencyKey,
          operation: "coordinator.message.v1",
          settlement: "pending",
        },
      });
      expect(commits[1]).toMatchObject({
        attempt: { status: accepted ? "running" : "failed" },
        effect: {
          effectId: delivery.effect.effectId,
          settlement: accepted ? "confirmed" : "definite_failed",
        },
      });
    }
  });
  test("records every Worker act intent first and settles the exact returned effect", async () => {
    const cases = [
      { action: "worker.send", intent: "DP-12", outcome: "EF-01" },
      { action: "worker.resume", intent: "DP-13", outcome: "EF-01" },
      { action: "worker.cancel", intent: "DP-14", outcome: "EF-01" },
    ] as const;
    for (const expected of cases) {
      const requests: WorkerLedgerSemanticRequestV1[] = [];
      const commits: WorkWaitCommitV1[] = [];
      const order: string[] = [];
      const production = productionServices(commits).workerLedger;
      const service: WorkerLedgerService = {
        resolveWorkByRunId: production.resolveWorkByRunId,
        resolveAttemptByRunId: production.resolveAttemptByRunId,
        async commitSemanticTransition(request) {
          requests.push(request);
          order.push(request.transitionId);
          return production.commitSemanticTransition(request);
        },
      };
      const handlers = createWorkerDispatchHandlers({
        ledger: service,
        coordinator: {
          async dispatch(): Promise<Execution.Result> {
            throw new Error("unused");
          },
          async deliverMessage() {
            order.push("coordinator");
            return { accepted: true };
          },
          async cancelRun() {
            order.push("coordinator");
            return { cancelled: true };
          },
        },
      });

      await handlers[expected.action](command(expected.action));

      expect(order).toEqual([expected.intent, "coordinator", expected.outcome]);
      const settlementRequest = requireValue(requests[1], "effect settlement request is missing");
      const intentCommit = requireValue(commits[0], "effect intent commit is missing");
      if (!("effect" in intentCommit)) throw new Error("effect intent is missing its effect");
      expect(settlementRequest.effectBinding).toEqual({
        effect: {
          version: "effect-ref-v1",
          effectId: intentCommit.effect.effectId,
          idempotencyKey: command(expected.action).dispatchId,
        },
        effectScope: effectBinding.effectScope,
      });
      expect(commits.map((commit) => commit.transitionId)).toEqual([
        expected.intent,
        expected.outcome,
      ]);
    }
  });

  test("passes Resident-approved criteria and constraints into DP-05 allocation", async () => {
    const requests: WorkerLedgerSemanticRequestV1[] = [];
    const handlers = createWorkerDispatchHandlers({
      defaultModel: { provider: "openai", id: "gpt-test" },
      ledger: ledger(requests),
      coordinator: {
        async dispatch(sessionId, request): Promise<Execution.Result> {
          return { sessionId, runId: request.runId, status: "interrupted", error: "stopped" };
        },
      },
      workerAttempts: {
        commands: {
          async requestStart() {
            return undefined;
          },
          async finish() {
            return undefined;
          },
          async requestDelivery() {
            throw new Error("unused");
          },
          async settleDelivery() {
            return undefined;
          },
          async requestCancel() {
            return undefined;
          },
          async settleCancel() {
            return undefined;
          },
        },
        queries: {
          async byExecution(input) {
            const allocated = requests.find((request) => request.transitionId === "DP-05")?.target;
            if (!allocated) return undefined;
            return {
              workItemId: allocated.workItemId,
              attemptId: allocated.attempt.attemptId,
              attemptSeq: allocated.attempt.attemptSeq,
              sessionId: input.sessionId,
              runId: input.runId,
              status: "allocated",
            };
          },
          async active() {
            return [];
          },
        },
      },
    });

    await handlers["worker.spawn"]({
      ...command("worker.spawn"),
      payload: {
        prompt: "delegate",
        acceptanceCriteria: ["result is evidence-backed"],
        constraints: ["resident approved only"],
      },
    });

    expect(requests[0]).toMatchObject({
      transitionId: "DP-05",
      content: {
        acceptanceCriteria: ["result is evidence-backed"],
        constraints: ["resident approved only"],
        executorKind: "internal_chat_agent",
      },
    });
  });
});
