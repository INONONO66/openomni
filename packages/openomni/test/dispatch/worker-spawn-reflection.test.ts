import { beforeEach, describe, expect, test } from "bun:test";
import { PolicyEngine } from "@openomni/policy";
import { PolicyDecision, WorkItem } from "@openomni/protocol";
import { Storage, WorkItemStore } from "@openomni/session";
import { DispatchRegistry } from "../../src/dispatch/registry";
import {
  createDefaultDispatchRuntime,
  registerBuiltInDispatchHandlers,
} from "../../src/dispatch/setup";
import { command, expectRejectsWithMessage } from "./helpers";

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

describe("worker.spawn result reflection", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
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
            return {
              runId: request.runId,
              sessionId: request.sessionId,
              status: "succeeded",
              output: JSON.stringify({
                deliverable: "done",
                completionReport: {
                  summary: "Completed the delegated work.",
                  claims: [{ statement: "Tests passed.", evidenceIds: [evidenceId] }],
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

    await runtime.submit(
      {
        action: "worker.complete",
        target: { kind: "worker", runId: "run:connector-policy" },
        payload: {
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
      },
      { actorKind: "resident", actorId: "resident:owner", agentName: "resident" },
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
          command(
            "worker.complete",
            { kind: "worker", runId: "run:target" },
            {
              workItemHash: item.hash,
              result: {
                runId: "run:result",
                sessionId: "session:bound",
                status: "failed",
              },
            },
          ),
        ),
      "worker.complete run mismatch",
    );
    await expectRejectsWithMessage(
      () =>
        registry.get("worker.complete")?.(
          command(
            "worker.complete",
            { kind: "worker", runId: "run:target" },
            {
              workItemHash: item.hash,
              result: {
                runId: "run:target",
                sessionId: "session:bound",
                status: "failed",
              },
            },
          ),
        ),
      "worker.complete run mismatch",
    );
    await expectRejectsWithMessage(
      () =>
        registry.get("worker.complete")?.(
          command(
            "worker.complete",
            { kind: "worker", runId: "run:missing" },
            {
              result: {
                runId: "run:missing",
                sessionId: "session:missing",
                status: "failed",
              },
            },
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
          command(
            "worker.complete",
            { kind: "worker", runId: "run:bound" },
            {
              result: {
                runId: "run:bound",
                sessionId: "session:bound",
                status: "failed",
              },
            },
          ),
        ),
      "requires exactly one WorkItem",
    );
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
          command(
            "worker.complete",
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
