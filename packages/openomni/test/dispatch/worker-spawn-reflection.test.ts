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
