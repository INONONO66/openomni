import { beforeEach, describe, expect, test } from "bun:test";
import { WorkItem } from "@openomni/protocol";
import { Storage, WorkItemStore } from "@openomni/session";
import { DispatchRegistry } from "../../src/dispatch/registry";
import { registerBuiltInDispatchHandlers } from "../../src/dispatch/setup";
import { command, expectRejectsWithMessage, workerSpawnPayload } from "./helpers";

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

  test("worker.spawn preserves the coordinator error when recording dispatch failure throws", async () => {
    const registry = new DispatchRegistry();
    registerBuiltInDispatchHandlers(registry, {
      owners: {
        coordinator: {
          async dispatch() {
            const workItemAdapter = Storage.getAdapter().workItem;
            if (!workItemAdapter) throw new Error("missing work item adapter");
            workItemAdapter.set = () => {
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
      "coordinator unavailable",
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
            return {
              runId: request.runId,
              sessionId: request.sessionId,
              status: "succeeded",
              output: JSON.stringify({
                completionReport: {
                  summary: "Completed the delegated work.",
                  claims: [{ statement: "Tests passed.", evidenceIds: ["ev_missing"] }],
                },
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
              description: "worker test passed",
              passed: true,
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

  test("worker.spawn preserves terminal coordinator results when reflection throws", async () => {
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
              workItemAdapter.set = () => {
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

      const result = await registry.get("worker.spawn")?.(
        command("worker.spawn", { kind: "worker", name: "coder" }, workerSpawnPayload("build it")),
      );

      const workItems = WorkItemStore.list();
      expect(workItems).toHaveLength(1);
      expect(result).toMatchObject({
        output: { workItemHash: workItems[0]?.hash, result: { status } },
      });
    }
  });
});
