import { beforeEach, describe, expect, test } from "bun:test";
import { Command, type Execution } from "@openomni/protocol";
import { Storage, WorkItemStore } from "@openomni/ledger";
import { DispatchRegistry } from "../../src/dispatch/registry";
import { registerBuiltInDispatchHandlers } from "../../src/dispatch/setup";
import { command, workerSpawnPayload } from "./helpers";

function registerWorkerSpawnHandler(
  dispatch: (sessionId: string, request: Execution.Request) => Promise<Execution.Result>,
): DispatchRegistry {
  const registry = new DispatchRegistry();
  registerBuiltInDispatchHandlers(registry, {
    owners: { coordinator: { dispatch } },
  });
  return registry;
}

describe("worker.spawn executor kind admission", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  test("worker.spawn dispatches internal chat workers without public executorKind", async () => {
    const requests: Execution.Request[] = [];
    const registry = registerWorkerSpawnHandler(async (_sessionId, request) => {
      requests.push(request);
      return {
        runId: request.runId,
        sessionId: request.sessionId,
        status: "succeeded",
        output: "done",
      };
    });

    await registry.get("worker.spawn")?.(
      command("worker.spawn", { kind: "worker", name: "coder" }, workerSpawnPayload("build")),
    );

    expect(requests).toHaveLength(1);
    expect(WorkItemStore.list()[0]).toMatchObject({
      executorKind: "internal_chat_agent",
      assigneeId: "coder",
    });
  });

  test("Command.Input rejects executorKind as a worker spawn selector", () => {
    const result = Command.Input.safeParse({
      action: "worker.spawn",
      target: { kind: "worker", name: "api-coder", executorKind: "external_api" },
      payload: workerSpawnPayload("build"),
    });

    expect(result.success).toBe(false);
  });
});
