import { beforeEach, describe, expect, test } from "bun:test";
import { PolicyEngine } from "@openomni/policy";
import { PolicyDecision, WorkItem } from "@openomni/protocol";
import { Storage, WorkerRunStateStore, WorkItemStore } from "@openomni/session";
import { DispatchRegistry } from "../../src/dispatch/registry";
import {
  createDefaultDispatchRuntime as createDefaultDispatchRuntimeProduction,
  registerBuiltInDispatchHandlers as registerBuiltInDispatchHandlersProduction,
} from "../../src/dispatch/setup";
import { command, expectRejectsWithMessage } from "./helpers";

let completionWriter: Storage.WorkItemCompletionWriter;

function registerBuiltInDispatchHandlers(
  registry: Parameters<typeof registerBuiltInDispatchHandlersProduction>[0],
  options?: Parameters<typeof registerBuiltInDispatchHandlersProduction>[1],
) {
  return registerBuiltInDispatchHandlersProduction(registry, {
    completionWriter,
    ...options,
  });
}

function createDefaultDispatchRuntime(
  options?: Parameters<typeof createDefaultDispatchRuntimeProduction>[0],
) {
  return createDefaultDispatchRuntimeProduction({
    completionWriter,
    ...options,
  });
}

function workerSpawnPayload(text: string) {
  return {
    text,
    acceptanceCriteria: ["recorded numeric operands satisfy eq"],
  };
}

function recordedVerifierEvidence(item: WorkItem.Info): string {
  const criterion = item.completionFacts.criteria[0];
  if (!criterion) throw new Error("missing completion criterion");
  return JSON.stringify({
    type: "verifier_recorded_inputs",
    version: 1,
    workItemHash: item.hash,
    basisRef: item.completionContract.basisRef,
    criterionId: criterion.id,
    verifierKind: "numeric_recheck",
    recordedInputs: { operator: "eq", left: 1, right: 1 },
  });
}

function criterionFacts(evidenceId: string) {
  return [
    {
      criterionIndex: 0,
      evidenceRefs: [{ source: "work_item", evidenceId }],
      verification: { kind: "numeric_recheck" },
    },
  ] as const;
}

function assignedWorkerCommand(
  target: Parameters<typeof command>[1],
  payload: unknown,
  sessionId: string,
  runId: string,
  registerRun = true,
) {
  if (registerRun && !WorkerRunStateStore.get(sessionId, runId)) {
    const sessionAdapter = Storage.getAdapter().session;
    if (!sessionAdapter.get(sessionId)) {
      sessionAdapter.set(sessionId, {
        id: sessionId,
        title: "Connector completion fixture",
        model: { providerID: "test", modelID: "test" },
        time: { created: Date.now(), updated: Date.now() },
        spawnDepth: 0,
      });
    }
    WorkerRunStateStore.create(sessionId, {
      runId,
      agentName: "connector-worker",
      status: "running",
      executorKind: "connector_endpoint",
      assignedStepId:
        typeof payload === "object" &&
        payload !== null &&
        "workItemHash" in payload &&
        typeof payload.workItemHash === "string"
          ? payload.workItemHash
          : undefined,
      title: "Connector completion fixture",
      prompt: "complete the assigned connector WorkItem",
    });
  }
  return {
    ...command("worker.complete", target, payload),
    actor: {
      kind: "worker" as const,
      actorId: `${sessionId}:${runId}`,
      sessionId,
      runId,
      workerRunId: runId,
      trustTier: "assigned_worker" as const,
    },
  };
}

describe("worker.spawn result reflection", () => {
  beforeEach(() => {
    Storage.reset();
    completionWriter = Storage.initialize({ dbPath: ":memory:" });
  });

  test("worker.spawn marks the work item failed when coordinator dispatch throws", async () => {
    const registry = new DispatchRegistry();
    registerBuiltInDispatchHandlers(registry, {
      owners: {
        coordinator: {
          async dispatch() {
            throw new Error("coordinator unavailable");
          },
        },
      },
    });

    await expectRejectsWithMessage(
      () =>
        registry.get("worker.spawn")?.(
          command(
            "worker.spawn",
            { kind: "worker", name: "coder" },
            workerSpawnPayload("build it"),
          ),
        ),
      "coordinator unavailable",
    );

    const workItems = WorkItemStore.list();
    expect(workItems).toHaveLength(1);
    expect(workItems[0]?.failureReason).toBe("coordinator unavailable");
    expect(workItems[0] ? WorkItem.deriveStatus(workItems[0]) : undefined).toBe("failed");
  });

  test("worker.spawn returns the durable reflection failure when recording dispatch failure throws", async () => {
    const registry = new DispatchRegistry();
    registerBuiltInDispatchHandlers(registry, {
      owners: {
        coordinator: {
          async dispatch() {
            const workItemAdapter = Storage.getAdapter().workItem;
            if (!workItemAdapter) throw new Error("missing work item adapter");
            workItemAdapter.compareAndSet = () => {
              throw new Error("work item write failed");
            };
            throw new Error("coordinator unavailable");
          },
        },
      },
    });

    await expectRejectsWithMessage(
      () =>
        registry.get("worker.spawn")?.(
          command(
            "worker.spawn",
            { kind: "worker", name: "coder" },
            workerSpawnPayload("build it"),
          ),
        ),
      "work item write failed",
    );
  });

  test("worker.spawn marks terminal coordinator results on the work item", async () => {
    for (const status of ["failed", "interrupted", "cancelled"] as const) {
      Storage.reset();
      Storage.initialize({ dbPath: ":memory:" });
      const registry = new DispatchRegistry();
      registerBuiltInDispatchHandlers(registry, {
        owners: {
          coordinator: {
            async dispatch(_sessionId, request) {
              return {
                runId: request.runId,
                sessionId: request.sessionId,
                status,
                error: status === "cancelled" ? undefined : `worker ${status}`,
                output: status === "cancelled" ? "cancelled by owner" : undefined,
              };
            },
          },
        },
      });

      const result = await registry.get("worker.spawn")?.(
        command("worker.spawn", { kind: "worker", name: "coder" }, workerSpawnPayload("build it")),
      );

      const workItems = WorkItemStore.list();
      expect(workItems).toHaveLength(1);
      expect(workItems[0] ? WorkItem.deriveStatus(workItems[0]) : undefined).toBe(
        status === "cancelled" ? "cancelled" : "failed",
      );
      if (status !== "cancelled") {
        expect(workItems[0]?.failureReason).toBe(`worker ${status}`);
      }
      expect(result).toMatchObject({
        output: { workItemHash: workItems[0]?.hash, result: { status } },
      });
    }
  });

  test("worker.spawn blocks succeeded results without an evidence-backed completion report", async () => {
    const registry = new DispatchRegistry();
    registerBuiltInDispatchHandlers(registry, {
      owners: {
        coordinator: {
          async dispatch(_sessionId, request) {
            return {
              runId: request.runId,
              sessionId: request.sessionId,
              status: "succeeded",
              output: "done",
            };
          },
        },
      },
    });

    const result = await registry.get("worker.spawn")?.(
      command("worker.spawn", { kind: "worker", name: "coder" }, workerSpawnPayload("build it")),
    );

    const workItems = WorkItemStore.list();
    expect(workItems).toHaveLength(1);
    expect(workItems[0] ? WorkItem.deriveStatus(workItems[0]) : undefined).toBe("blocked");
    expect(workItems[0]?.blockers[0]).toMatchObject({
      kind: "error",
      description: "completion report is required",
    });
    expect(result).toMatchObject({
      output: {
        workItemHash: workItems[0]?.hash,
        reflection: {
          workItemStatus: "blocked",
          completionBlocked: true,
          completionBlocker: "completion report is required",
        },
      },
    });
  });

  test("worker.spawn blocks completion reports with unresolved evidence refs", async () => {
    const registry = new DispatchRegistry();
    registerBuiltInDispatchHandlers(registry, {
      owners: {
        coordinator: {
          async dispatch(_sessionId, request) {
            const item = WorkItemStore.list()[0];
            if (!item) throw new Error("missing work item");
            const withEvidence = await WorkItemStore.addEvidence(item.hash, {
              kind: "verification",
              description: "kernel-recorded verifier input",
              passed: true,
              detail: recordedVerifierEvidence(item),
            });
            const evidenceId = withEvidence?.evidence.at(-1)?.id;
            if (!evidenceId) throw new Error("missing verifier evidence");
            return {
              runId: request.runId,
              sessionId: request.sessionId,
              status: "succeeded",
              output: JSON.stringify({
                completionReport: {
                  summary: "Completed the delegated work.",
                  claims: [{ statement: "Tests passed.", evidenceIds: ["ev_missing"] }],
                },
                criterionFacts: criterionFacts(evidenceId),
              }),
            };
          },
        },
      },
    });

    const result = await registry.get("worker.spawn")?.(
      command("worker.spawn", { kind: "worker", name: "coder" }, workerSpawnPayload("build it")),
    );

    const workItems = WorkItemStore.list();
    expect(workItems).toHaveLength(1);
    expect(workItems[0] ? WorkItem.deriveStatus(workItems[0]) : undefined).toBe("blocked");
    expect(workItems[0]?.completionReport).toBeUndefined();
    expect(workItems[0]?.blockers[0]).toMatchObject({
      kind: "error",
      description: "completion report references missing evidence: ev_missing",
    });
    expect(result).toMatchObject({
      output: {
        workItemHash: workItems[0]?.hash,
        reflection: {
          workItemStatus: "blocked",
          completionBlocked: true,
          completionBlocker: "completion report references missing evidence: ev_missing",
        },
      },
    });
  });

  test("worker.spawn completes succeeded results with a report backed by ledger evidence", async () => {
    const registry = new DispatchRegistry();
    registerBuiltInDispatchHandlers(registry, {
      owners: {
        coordinator: {
          async dispatch(_sessionId, request) {
            const workItem = WorkItemStore.list()[0];
            if (!workItem) throw new Error("missing work item");
            const withEvidence = await WorkItemStore.addEvidence(workItem.hash, {
              kind: "test_result",
              description: "kernel-recorded verifier input",
              passed: true,
              detail: recordedVerifierEvidence(workItem),
            });
            const evidenceId = withEvidence?.evidence.at(-1)?.id;
            if (!evidenceId) throw new Error("missing evidence");
            const criterion = workItem.completionFacts.criteria[0];
            if (!criterion) throw new Error("missing completion criterion");
            return {
              runId: request.runId,
              sessionId: request.sessionId,
              status: "succeeded",
              output: JSON.stringify({
                deliverable: "done",
                completionReport: {
                  summary: "Completed the delegated work.",
                  claims: [{ statement: criterion.statement, evidenceIds: [evidenceId] }],
                },
                criterionFacts: criterionFacts(evidenceId),
              }),
            };
          },
        },
      },
    });

    const result = await registry.get("worker.spawn")?.(
      command("worker.spawn", { kind: "worker", name: "coder" }, workerSpawnPayload("build it")),
    );

    const workItems = WorkItemStore.list();
    expect(workItems).toHaveLength(1);
    expect(workItems[0] ? WorkItem.deriveStatus(workItems[0]) : undefined).toBe("completed");
    expect(workItems[0]?.completionReport?.claims[0]?.evidenceIds).toEqual([
      workItems[0]?.evidence[0]?.id,
    ]);
    expect(result).toMatchObject({
      output: {
        workItemHash: workItems[0]?.hash,
        result: { status: "succeeded" },
        reflection: { workItemStatus: "completed", completionBlocked: false },
      },
    });
  });

  test("default production runtime applies an injected completion denial to Worker origins", async () => {
    const completionPolicyEngine = PolicyEngine.create();
    completionPolicyEngine.register({
      kind: "point",
      name: "deny-worker-completion",
      pointIds: ["work.complete.pre"],
      effectCapabilities: { "work.complete.pre": [] },
      priority: 0,
      fn: () =>
        PolicyDecision.deny({
          policyId: "deny-worker-completion",
          reasonCodes: ["production_completion_denied"],
        }),
    });
    const runtime = createDefaultDispatchRuntime({
      completionPolicyEngine,
      owners: {
        coordinator: {
          async dispatch(_sessionId, request) {
            const workItem = WorkItemStore.list()[0];
            if (!workItem) throw new Error("missing work item");
            const withEvidence = await WorkItemStore.addEvidence(workItem.hash, {
              kind: "verification",
              description: "kernel-recorded verifier input",
              passed: true,
              detail: recordedVerifierEvidence(workItem),
            });
            const evidenceId = withEvidence?.evidence.at(-1)?.id;
            if (!evidenceId) throw new Error("missing verifier evidence");
            return {
              runId: request.runId,
              sessionId: request.sessionId,
              status: "succeeded",
              output: JSON.stringify({
                completionReport: {
                  summary: "Completion policy must govern this result.",
                  claims: [{ statement: "Tests passed.", evidenceIds: [evidenceId] }],
                },
                criterionFacts: criterionFacts(evidenceId),
              }),
            };
          },
        },
      },
    });

    const result = await runtime.submit(
      {
        action: "worker.spawn",
        target: { kind: "worker", name: "coder" },
        payload: workerSpawnPayload("build it"),
      },
      { actorKind: "resident", actorId: "resident:owner", agentName: "resident" },
    );

    const stored = WorkItemStore.list()[0];
    expect(result.status).toBe("completed");
    expect(stored ? WorkItem.deriveStatus(stored) : undefined).toBe("blocked");
    expect(stored?.completionFacts.admissions[0]).toMatchObject({
      decision: "block",
      reasonCodes: expect.arrayContaining(["production_completion_denied"]),
    });
    expect(stored?.completionTerminalReceipt).toBeUndefined();
    expect(stored?.completionReport).toBeUndefined();

    const connectorCreated = await WorkItemStore.create({
      name: "Connector completion policy",
      sourceMessageId: "dispatch:connector-policy",
      sourceChannel: "dispatch",
      intent: "worker.complete",
      goal: "prove connector completion policy composition",
      executorKind: "connector_endpoint",
      workSessionId: "session:connector-policy",
      workerRunId: "run:connector-policy",
      acceptanceCriteria: ["recorded numeric operands satisfy eq"],
    });
    const connectorItem = await WorkItemStore.start(connectorCreated.hash);
    if (!connectorItem) throw new Error("missing connector WorkItem");
    const connectorEvidence = await WorkItemStore.addEvidence(connectorItem.hash, {
      kind: "verification",
      description: "kernel-recorded verifier input",
      passed: true,
      detail: recordedVerifierEvidence(connectorItem),
    });
    const connectorEvidenceId = connectorEvidence?.evidence.at(-1)?.id;
    if (!connectorEvidenceId) throw new Error("missing connector evidence");

    await runtime.registry.get("worker.complete")?.(
      assignedWorkerCommand(
        {
          kind: "worker",
          runId: "run:connector-policy",
          sessionId: "session:connector-policy",
        },
        {
          workItemHash: connectorItem.hash,
          result: {
            runId: "run:connector-policy",
            sessionId: "session:connector-policy",
            status: "succeeded",
            output: JSON.stringify({
              completionReport: {
                summary: "Connector policy must govern this result.",
                claims: [{ statement: "Tests passed.", evidenceIds: [connectorEvidenceId] }],
              },
              criterionFacts: criterionFacts(connectorEvidenceId),
            }),
          },
        },
        "session:connector-policy",
        "run:connector-policy",
      ),
    );

    const connectorStored = WorkItemStore.get(connectorItem.hash);
    expect(connectorStored ? WorkItem.deriveStatus(connectorStored) : undefined).toBe("blocked");
    expect(connectorStored?.completionFacts.admissions[0]).toMatchObject({
      origin: "worker",
      decision: "block",
      reasonCodes: expect.arrayContaining(["production_completion_denied"]),
    });
    expect(connectorStored?.completionTerminalReceipt).toBeUndefined();
    expect(connectorStored?.completionReport).toBeUndefined();
  });

  test("worker.complete requires one WorkItem bound to its target and result run", async () => {
    const registry = new DispatchRegistry();
    registerBuiltInDispatchHandlers(registry);
    const item = await WorkItemStore.create({
      name: "Bound connector completion",
      sourceMessageId: "dispatch:bound-connector-completion",
      sourceChannel: "dispatch",
      intent: "worker.complete",
      goal: "bind completion to the owning run",
      executorKind: "connector_endpoint",
      workerRunId: "run:bound",
      acceptanceCriteria: ["completion belongs to the owning run"],
    });

    await expectRejectsWithMessage(
      () =>
        registry.get("worker.complete")?.(
          assignedWorkerCommand(
            { kind: "worker", runId: "run:target" },
            {
              workItemHash: item.hash,
              result: {
                runId: "run:result",
                sessionId: "session:bound",
                status: "failed",
              },
            },
            "session:bound",
            "run:result",
          ),
        ),
      "worker.complete run mismatch",
    );
    await expectRejectsWithMessage(
      () =>
        registry.get("worker.complete")?.(
          assignedWorkerCommand(
            { kind: "worker", runId: "run:target" },
            {
              workItemHash: item.hash,
              result: {
                runId: "run:target",
                sessionId: "session:bound",
                status: "failed",
              },
            },
            "session:bound",
            "run:target",
          ),
        ),
      "worker.complete run mismatch",
    );
    await expectRejectsWithMessage(
      () =>
        registry.get("worker.complete")?.(
          assignedWorkerCommand(
            { kind: "worker", runId: "run:missing" },
            {
              result: {
                runId: "run:missing",
                sessionId: "session:missing",
                status: "failed",
              },
            },
            "session:missing",
            "run:missing",
          ),
        ),
      "requires exactly one WorkItem",
    );

    await WorkItemStore.create({
      name: "Duplicate connector completion",
      sourceMessageId: "dispatch:duplicate-connector-completion",
      sourceChannel: "dispatch",
      intent: "worker.complete",
      goal: "reject ambiguous completion correlation",
      executorKind: "connector_endpoint",
      workerRunId: "run:bound",
      acceptanceCriteria: ["completion is unambiguous"],
    });
    await expectRejectsWithMessage(
      () =>
        registry.get("worker.complete")?.(
          assignedWorkerCommand(
            { kind: "worker", runId: "run:bound" },
            {
              result: {
                runId: "run:bound",
                sessionId: "session:bound",
                status: "failed",
              },
            },
            "session:bound",
            "run:bound",
          ),
        ),
      "requires exactly one WorkItem",
    );
  });

  test("worker.complete rejects a non-Worker actor before terminal mutation", async () => {
    const registry = new DispatchRegistry();
    registerBuiltInDispatchHandlers(registry);
    const created = await WorkItemStore.create({
      name: "Authenticated connector completion",
      sourceMessageId: "dispatch:authenticated-connector-completion",
      sourceChannel: "dispatch",
      intent: "worker.complete",
      goal: "only the assigned Worker may report terminal state",
      executorKind: "connector_endpoint",
      workSessionId: "session:authenticated",
      workerRunId: "run:authenticated",
      acceptanceCriteria: ["terminal state comes from the assigned Worker"],
    });
    const item = await WorkItemStore.start(created.hash);
    if (!item) throw new Error("missing authenticated completion WorkItem");
    const before = WorkItemStore.get(item.hash);

    await expectRejectsWithMessage(
      () =>
        registry.get("worker.complete")?.(
          command(
            "worker.complete",
            { kind: "worker", runId: "run:authenticated" },
            {
              workItemHash: item.hash,
              result: {
                runId: "run:authenticated",
                sessionId: "session:authenticated",
                status: "failed",
                error: "forged failure",
              },
            },
          ),
        ),
      "worker.complete actor is not authorized",
    );

    expect(WorkItemStore.get(item.hash)).toEqual(before);
  });

  test("worker.complete rejects a missing WorkerRun assignment before mutation", async () => {
    const registry = new DispatchRegistry();
    registerBuiltInDispatchHandlers(registry);
    const created = await WorkItemStore.create({
      name: "Missing WorkerRun completion",
      sourceMessageId: "dispatch:missing-worker-run",
      sourceChannel: "dispatch",
      intent: "worker.complete",
      goal: "reject a completion without an assigned WorkerRun",
      executorKind: "connector_endpoint",
      workSessionId: "session:missing-worker-run",
      workerRunId: "run:missing-worker-run",
      acceptanceCriteria: ["persist no forged terminal state"],
    });
    const item = await WorkItemStore.start(created.hash);
    if (!item) throw new Error("missing WorkerRun completion fixture");
    const before = WorkItemStore.get(item.hash);

    await expectRejectsWithMessage(
      () =>
        registry.get("worker.complete")?.(
          assignedWorkerCommand(
            {
              kind: "worker",
              runId: "run:missing-worker-run",
              sessionId: "session:missing-worker-run",
            },
            {
              workItemHash: item.hash,
              result: {
                runId: "run:missing-worker-run",
                sessionId: "session:missing-worker-run",
                status: "failed",
                error: "forged without assignment",
              },
            },
            "session:missing-worker-run",
            "run:missing-worker-run",
            false,
          ),
        ),
      "WorkerRun not found",
    );

    expect(WorkItemStore.get(item.hash)).toEqual(before);
  });

  test("worker.complete authenticates actor, target, session, and executor before mutation", async () => {
    const scenarios = [
      {
        name: "mismatched actor run",
        executorKind: "connector_endpoint",
        workSessionId: "session:authorized",
        buildCommand: (workItemHash: string) => ({
          ...assignedWorkerCommand(
            {
              kind: "worker",
              runId: "run:authorized",
              sessionId: "session:authorized",
            },
            {
              workItemHash,
              result: {
                runId: "run:authorized",
                sessionId: "session:authorized",
                status: "failed",
                error: "forged failure",
              },
            },
            "session:authorized",
            "run:authorized",
          ),
          actor: {
            kind: "worker" as const,
            actorId: "session:authorized:run:forged",
            sessionId: "session:authorized",
            runId: "run:forged",
            workerRunId: "run:forged",
            trustTier: "assigned_worker" as const,
          },
        }),
      },
      {
        name: "mismatched actor session",
        executorKind: "connector_endpoint",
        workSessionId: "session:authorized",
        buildCommand: (workItemHash: string) =>
          assignedWorkerCommand(
            {
              kind: "worker",
              runId: "run:authorized",
              sessionId: "session:authorized",
            },
            {
              workItemHash,
              result: {
                runId: "run:authorized",
                sessionId: "session:authorized",
                status: "failed",
                error: "forged failure",
              },
            },
            "session:forged",
            "run:authorized",
          ),
      },
      {
        name: "mismatched target session",
        executorKind: "connector_endpoint",
        workSessionId: "session:authorized",
        buildCommand: (workItemHash: string) =>
          assignedWorkerCommand(
            {
              kind: "worker",
              runId: "run:authorized",
              sessionId: "session:forged",
            },
            {
              workItemHash,
              result: {
                runId: "run:authorized",
                sessionId: "session:authorized",
                status: "failed",
                error: "forged failure",
              },
            },
            "session:authorized",
            "run:authorized",
          ),
      },
      {
        name: "mismatched WorkItem session",
        executorKind: "connector_endpoint",
        workSessionId: "session:forged",
        buildCommand: (workItemHash: string) =>
          assignedWorkerCommand(
            {
              kind: "worker",
              runId: "run:authorized",
              sessionId: "session:authorized",
            },
            {
              workItemHash,
              result: {
                runId: "run:authorized",
                sessionId: "session:authorized",
                status: "failed",
                error: "forged failure",
              },
            },
            "session:authorized",
            "run:authorized",
          ),
      },
      {
        name: "incorrect executor kind",
        executorKind: "internal_chat_agent",
        workSessionId: "session:authorized",
        buildCommand: (workItemHash: string) =>
          assignedWorkerCommand(
            {
              kind: "worker",
              runId: "run:authorized",
              sessionId: "session:authorized",
            },
            {
              workItemHash,
              result: {
                runId: "run:authorized",
                sessionId: "session:authorized",
                status: "failed",
                error: "forged failure",
              },
            },
            "session:authorized",
            "run:authorized",
          ),
      },
    ] as const;

    for (const scenario of scenarios) {
      Storage.reset();
      Storage.initialize({ dbPath: ":memory:" });
      const registry = new DispatchRegistry();
      registerBuiltInDispatchHandlers(registry);
      const created = await WorkItemStore.create({
        name: scenario.name,
        sourceMessageId: `dispatch:${scenario.name}`,
        sourceChannel: "dispatch",
        intent: "worker.complete",
        goal: "reject forged completion authority",
        executorKind: scenario.executorKind,
        workSessionId: scenario.workSessionId,
        workerRunId: "run:authorized",
        acceptanceCriteria: ["terminal state comes from the assigned connector Worker"],
      });
      const item = await WorkItemStore.start(created.hash);
      if (!item) throw new Error(`missing WorkItem for ${scenario.name}`);
      const before = WorkItemStore.get(item.hash);

      await expectRejectsWithMessage(
        () => registry.get("worker.complete")?.(scenario.buildCommand(item.hash)),
        "worker.complete actor is not authorized",
      );
      expect(WorkItemStore.get(item.hash)).toEqual(before);
    }
  });

  test("worker.spawn returns blocker persistence failures", async () => {
    const registry = new DispatchRegistry();
    registerBuiltInDispatchHandlers(registry, {
      owners: {
        coordinator: {
          async dispatch(_sessionId, request) {
            const workItemAdapter = Storage.getAdapter().workItem;
            if (!workItemAdapter) throw new Error("missing work item adapter");
            workItemAdapter.compareAndSet = () => {
              throw new Error("work item write failed");
            };
            return {
              runId: request.runId,
              sessionId: request.sessionId,
              status: "succeeded",
              output: "not a completion envelope",
            };
          },
        },
      },
    });

    await expectRejectsWithMessage(
      () =>
        registry.get("worker.spawn")?.(
          command(
            "worker.spawn",
            { kind: "worker", name: "coder" },
            workerSpawnPayload("build it"),
          ),
        ),
      "work item write failed",
    );
  });

  test("worker.complete returns connector evidence persistence failures", async () => {
    const registry = new DispatchRegistry();
    registerBuiltInDispatchHandlers(registry);
    const item = await WorkItemStore.create({
      name: "Connector evidence persistence",
      sourceMessageId: "dispatch:connector-evidence-persistence",
      sourceChannel: "dispatch",
      intent: "worker.complete",
      goal: "record connector evidence durably",
      executorKind: "connector_endpoint",
      workSessionId: "session:connector-evidence",
      workerRunId: "run:connector-evidence",
      acceptanceCriteria: ["connector evidence persists"],
    });
    const workItemAdapter = Storage.getAdapter().workItem;
    if (!workItemAdapter) throw new Error("missing work item adapter");
    workItemAdapter.compareAndSet = () => {
      throw new Error("work item write failed");
    };

    await expectRejectsWithMessage(
      () =>
        registry.get("worker.complete")?.(
          assignedWorkerCommand(
            { kind: "worker", runId: "run:connector-evidence" },
            {
              workItemHash: item.hash,
              result: {
                runId: "run:connector-evidence",
                sessionId: "session:connector-evidence",
                status: "failed",
                artifacts: [
                  {
                    kind: "connector_log",
                    artifactId: "artifact:connector-evidence",
                    title: "Connector evidence",
                    mimeType: "application/json",
                  },
                ],
              },
            },
            "session:connector-evidence",
            "run:connector-evidence",
          ),
        ),
      "work item write failed",
    );
  });

  test("worker.spawn returns terminal reflection persistence failures", async () => {
    for (const status of ["failed", "interrupted", "cancelled"] as const) {
      Storage.reset();
      Storage.initialize({ dbPath: ":memory:" });
      const registry = new DispatchRegistry();
      registerBuiltInDispatchHandlers(registry, {
        owners: {
          coordinator: {
            async dispatch(_sessionId, request) {
              const workItemAdapter = Storage.getAdapter().workItem;
              if (!workItemAdapter) throw new Error("missing work item adapter");
              workItemAdapter.compareAndSet = () => {
                throw new Error("work item write failed");
              };
              return {
                runId: request.runId,
                sessionId: request.sessionId,
                status,
                error: status === "cancelled" ? undefined : `worker ${status}`,
                output: status === "cancelled" ? "cancelled by owner" : undefined,
              };
            },
          },
        },
      });

      await expectRejectsWithMessage(
        () =>
          registry.get("worker.spawn")?.(
            command(
              "worker.spawn",
              { kind: "worker", name: "coder" },
              workerSpawnPayload("build it"),
            ),
          ),
        "work item write failed",
      );
    }
  });
});
