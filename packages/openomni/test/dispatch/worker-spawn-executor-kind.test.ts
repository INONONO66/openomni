import { beforeEach, describe, expect, test } from "bun:test";
import { PolicyDecision, WorkItem, type Execution } from "@openomni/protocol";
import { Session, Storage, WorkItemStore } from "@openomni/session";
import { createWorkerDispatchHandlers } from "../../src/dispatch/handlers/worker";
import { DispatchRegistry } from "../../src/dispatch/registry";
import { DispatchRuntime } from "../../src/dispatch/runtime";
import { registerBuiltInDispatchHandlers } from "../../src/dispatch/setup";
import { command, expectRejectsWithMessage, workerSpawnPayload } from "./helpers";

const unsupportedExecutorKinds = [
  "local_cli_agent",
  "external_api",
  "a2a",
  "human_channel",
] as const;

function registerWorkerSpawnHandler(
  dispatch: (sessionId: string, request: Execution.Request) => Promise<Execution.Result>,
): DispatchRegistry {
  const registry = new DispatchRegistry();
  registerBuiltInDispatchHandlers(registry, {
    owners: { coordinator: { dispatch } },
  });
  return registry;
}

function registerWorkerSpawnHandlerWithoutCoordinator(): DispatchRegistry {
  const registry = new DispatchRegistry();
  registerBuiltInDispatchHandlers(registry);
  return registry;
}

describe("worker.spawn executor kind admission", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  test("worker.spawn dispatches normally with explicit internal_chat_agent executor kind", async () => {
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
      command(
        "worker.spawn",
        { kind: "worker", name: "coder", executorKind: "internal_chat_agent" },
        workerSpawnPayload("build"),
      ),
    );

    expect(requests).toHaveLength(1);
    expect(WorkItemStore.list()[0]).toMatchObject({
      executorKind: "internal_chat_agent",
      assigneeId: "coder",
    });
  });

  for (const executorKind of unsupportedExecutorKinds) {
    test(`worker.spawn fails closed for ${executorKind} before coordinator dispatch`, async () => {
      let dispatched = false;
      const registry = registerWorkerSpawnHandler(async () => {
        dispatched = true;
        return {
          runId: "run-1",
          sessionId: "session-1",
          status: "succeeded",
          output: "done",
        };
      });

      await expectRejectsWithMessage(
        () =>
          registry.get("worker.spawn")?.(
            command(
              "worker.spawn",
              {
                kind: "worker",
                name: "cli-coder",
                sessionId: "session-cli",
                executorKind,
              },
              {
                text: "build with a non-internal executor",
                acceptanceCriteria: ["The unsupported executor failure is ledgered"],
                constraints: ["do not dispatch to the internal coordinator"],
              },
            ),
          ),
        `worker.spawn executor ${executorKind} is not wired`,
      );

      expect(dispatched).toBe(false);
      const workItems = WorkItemStore.list();
      expect(workItems).toHaveLength(1);
      expect(workItems[0]).toMatchObject({
        goal: "build with a non-internal executor",
        acceptanceCriteria: ["The unsupported executor failure is ledgered"],
        constraints: ["do not dispatch to the internal coordinator"],
        assigneeId: "cli-coder",
        sessionId: "session-cli",
        executorKind,
        failureReason: `worker.spawn executor ${executorKind} is not wired`,
      });
      expect(workItems[0]?.evidence).toMatchObject([
        {
          kind: "custom",
          description: `worker.spawn executor ${executorKind} is not wired`,
          passed: false,
          detail: `executorKind=${executorKind}`,
        },
      ]);
      expect(workItems[0] ? WorkItem.deriveStatus(workItems[0]) : undefined).toBe("failed");
    });
  }

  test("unsupported executor records origin session only as context", async () => {
    const registry = registerWorkerSpawnHandler(async () => {
      throw new Error("coordinator must not be called");
    });

    await expectRejectsWithMessage(
      () =>
        registry.get("worker.spawn")?.({
          ...command(
            "worker.spawn",
            { kind: "worker", name: "cli-coder", executorKind: "local_cli_agent" },
            workerSpawnPayload("build"),
          ),
          sessionId: "origin-session",
        }),
      "worker.spawn executor local_cli_agent is not wired",
    );

    expect(Session.list()).toEqual([]);
    const workItem = WorkItemStore.list()[0];
    expect(workItem).toMatchObject({ executorKind: "local_cli_agent" });
    expect(workItem?.sessionId).toBeUndefined();
    expect(workItem?.context).toBe("originSessionId=origin-session");
  });

  test("unsupported executor fails closed before requiring a coordinator", async () => {
    const registry = registerWorkerSpawnHandlerWithoutCoordinator();

    await expectRejectsWithMessage(
      () =>
        registry.get("worker.spawn")?.(
          command(
            "worker.spawn",
            { kind: "worker", name: "cli-coder", executorKind: "local_cli_agent" },
            workerSpawnPayload("build"),
          ),
        ),
      "worker.spawn executor local_cli_agent is not wired",
    );

    const workItem = WorkItemStore.list()[0];
    expect(workItem).toMatchObject({
      executorKind: "local_cli_agent",
      failureReason: "worker.spawn executor local_cli_agent is not wired",
    });
  });

  test("runtime submit preserves executor kind into the worker handler", async () => {
    const runtime = new DispatchRuntime({ includeDefaultPolicies: false });
    runtime.register("worker.spawn", createWorkerDispatchHandlers()["worker.spawn"]);

    const result = await runtime.submit(
      {
        action: "worker.spawn",
        target: { kind: "worker", name: "cli-coder", executorKind: "local_cli_agent" },
        payload: workerSpawnPayload("build"),
      },
      {
        policies: [
          {
            name: "allow-runtime-executor-kind-test",
            timing: "dispatch.authorize",
            priority: 0,
            fn: () => PolicyDecision.allow({ policyId: "allow-runtime-executor-kind-test" }),
          },
        ],
      },
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("worker.spawn executor local_cli_agent is not wired");
    expect(WorkItemStore.list()[0]).toMatchObject({
      executorKind: "local_cli_agent",
      assigneeId: "cli-coder",
      failureReason: "worker.spawn executor local_cli_agent is not wired",
    });
  });
});
