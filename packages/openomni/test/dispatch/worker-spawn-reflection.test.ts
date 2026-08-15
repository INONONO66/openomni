import { beforeEach, describe, expect, test } from "bun:test";
import { PolicyEngine } from "@openomni/policy";
import { PolicyDecision, WorkItem } from "@openomni/protocol";
import { Storage, WorkItemStore } from "@openomni/session";
import { DispatchRegistry } from "../../src/dispatch/registry";
import {
  createDefaultDispatchRuntime as createDefaultDispatchRuntimeProduction,
  registerBuiltInDispatchHandlers as registerBuiltInDispatchHandlersProduction,
} from "../../src/dispatch/setup";
import { allocateTestAttempt, command, expectRejectsWithMessage } from "./helpers";

/** A dispatch inherits the trace of whatever ordered it; the runtime refuses to mint one. */
const TEST_DISPATCH_TRACE_ID = "trace-dispatch-test";

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

// #510 D2b — the assigned run is the WorkItem attempt: the worker-run store
// is frozen, so fixtures that need an ACTIVE run allocate an attempt on the
// target WorkItem (see allocateTestAttempt) instead of seeding a
// worker_run_state row. This builder only shapes the authorized actor.
function assignedWorkerCommand(
  target: Parameters<typeof command>[1],
  payload: unknown,
  sessionId: string,
  runId: string,
) {
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

  test("worker.spawn preserves the coordinator failure when failure reflection also throws", async () => {
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

    let caught: unknown;
    try {
      await registry.get("worker.spawn")?.(
        command("worker.spawn", { kind: "worker", name: "coder" }, workerSpawnPayload("build it")),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    if (!(caught instanceof Error)) return;
    expect(caught.name).toBe("WorkItemReflectionError");
    expect(caught.message).toBe("coordinator unavailable");
    expect(caught.cause).toEqual(new Error("coordinator unavailable"));
    expect(Reflect.get(caught, "reflectionFailure")).toEqual(new Error("work item write failed"));
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
    const claimedEvidenceId = workItems[0]?.evidence[0]?.id;
    if (claimedEvidenceId === undefined) throw new Error("shape");
    expect(workItems[0]?.completionReport?.claims[0]?.evidenceIds).toEqual([claimedEvidenceId]);
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
      {
        traceId: TEST_DISPATCH_TRACE_ID,
        actorKind: "resident",
        actorId: "resident:owner",
        agentName: "resident",
      },
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
    await allocateTestAttempt(connectorItem.hash);
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

  test("worker.complete answers a blocked-then-retried completion with one admission", async () => {
    // #510 deterministic-idempotent-receipt pin: a blocked first submission
    // (a designed live path) must NOT terminalize the attempt — the worker's
    // corrected resubmission of the SAME attempt completes with exactly one
    // recorded admission.
    const registry = new DispatchRegistry();
    registerBuiltInDispatchHandlers(registry);
    const created = await WorkItemStore.create({
      name: "Blocked-then-retried connector completion",
      sourceMessageId: "dispatch:blocked-retry-completion",
      sourceChannel: "dispatch",
      intent: "worker.complete",
      goal: "retry a blocked completion on the same attempt",
      executorKind: "connector_endpoint",
      workSessionId: "session:blocked-retry",
      workerRunId: "run:blocked-retry",
      acceptanceCriteria: ["recorded numeric operands satisfy eq"],
    });
    const item = await WorkItemStore.start(created.hash);
    if (!item) throw new Error("missing blocked-retry WorkItem");
    await allocateTestAttempt(item.hash);
    const withEvidence = await WorkItemStore.addEvidence(item.hash, {
      kind: "verification",
      description: "kernel-recorded verifier input",
      passed: true,
      detail: recordedVerifierEvidence(item),
    });
    const evidenceId = withEvidence?.evidence.at(-1)?.id;
    if (!evidenceId) throw new Error("missing blocked-retry evidence");

    const submit = (output: string) =>
      registry.get("worker.complete")?.(
        assignedWorkerCommand(
          { kind: "worker", runId: "run:blocked-retry", sessionId: "session:blocked-retry" },
          {
            workItemHash: item.hash,
            result: {
              runId: "run:blocked-retry",
              sessionId: "session:blocked-retry",
              status: "succeeded" as const,
              output,
            },
          },
          "session:blocked-retry",
          "run:blocked-retry",
        ),
      ) as Promise<{ output: { reflection: { completionBlocked: boolean } } }>;

    // First submission: not a completion envelope — admission blocks.
    const blocked = await submit("not a completion envelope");
    expect(blocked.output.reflection.completionBlocked).toBe(true);
    // The attempt is still the live execution instance: no terminal record.
    expect(WorkItemStore.get(item.hash)?.attemptTerminal).toBeUndefined();

    // Resolve the block (the #490 active_blocker admission rule is the
    // pre-existing unblock step, not D2b scope), then resubmit the SAME
    // attempt with the corrected envelope: admitted once.
    const blocker = WorkItemStore.get(item.hash)?.blockers.find(
      (candidate) => candidate.resolvedAt === undefined,
    );
    if (!blocker) throw new Error("missing completion blocker after the blocked submission");
    await WorkItemStore.resolveBlocker(item.hash, blocker.id);
    const retried = await submit(
      JSON.stringify({
        completionReport: {
          summary: "Corrected completion envelope after the blocked attempt.",
          claims: [
            { statement: "recorded numeric operands satisfy eq", evidenceIds: [evidenceId] },
          ],
        },
        criterionFacts: criterionFacts(evidenceId),
      }),
    );
    expect(retried.output.reflection.completionBlocked).toBe(false);

    const stored = WorkItemStore.get(item.hash);
    if (!stored) throw new Error("blocked-retry WorkItem disappeared");
    expect(WorkItem.deriveStatus(stored)).toBe("completed");
    expect(
      stored.completionFacts.admissions.filter((admission) => admission.decision === "admit"),
    ).toHaveLength(1);
    // The attempt terminal lands with the admitted completion.
    expect(stored.attemptTerminal?.outcome).toBe("succeeded");
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
    await allocateTestAttempt(item.hash);
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
