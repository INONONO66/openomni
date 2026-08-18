import { beforeEach, describe, expect, test } from "bun:test";
import { WorkItem, type Execution } from "@openomni/protocol";
import { Session, Storage, WorkItemStore } from "@openomni/session";
import { DispatchRegistry } from "../../src/dispatch/registry";
import { registerBuiltInDispatchHandlers } from "../../src/dispatch/setup";
import { PolicyResolver } from "../../src/policy";
import { command, expectRejectsWithMessage, workerSpawnPayload } from "./helpers";

function registerWorkerSpawnHandler(
  dispatch: (sessionId: string, request: Execution.Request) => Promise<Execution.Result>,
): DispatchRegistry {
  const registry = new DispatchRegistry();
  registerBuiltInDispatchHandlers(registry, {
    owners: { coordinator: { dispatch } },
  });
  return registry;
}

describe("worker.spawn dispatch gate", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  test("worker.spawn creates a WorkItem with acceptance criteria before completion gating", async () => {
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

    const result = await registry.get("worker.spawn")?.(
      command(
        "worker.spawn",
        { kind: "worker", name: "coder" },
        {
          text: "build it",
          acceptanceCriteria: ["The delegated worker returns evidence-backed completion"],
          constraints: ["stay inside the requested scope"],
        },
      ),
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ mode: "direct", prompt: "build it", agentName: "coder" });
    expect(Session.get(requests[0]?.sessionId ?? "")).toBeDefined();
    const workItems = WorkItemStore.list();
    expect(workItems).toHaveLength(1);
    expect(workItems[0]).toMatchObject({
      sourceMessageId: "dispatch-worker.spawn",
      sourceChannel: "dispatch",
      intent: "worker.spawn",
      goal: "build it",
      assigneeId: "coder",
      sessionId: requests[0]?.sessionId,
      executorKind: "internal_chat_agent",
      maxAttempts: 3,
      acceptanceCriteria: ["The delegated worker returns evidence-backed completion"],
      constraints: ["stay inside the requested scope"],
    });
    expect(workItems[0] ? WorkItem.deriveStatus(workItems[0]) : undefined).toBe("blocked");
    expect(result).toMatchObject({
      output: { sessionId: requests[0]?.sessionId, workItemHash: workItems[0]?.workItemId },
    });
  });

  test("worker.spawn rejects missing acceptance criteria before dispatch", async () => {
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
          command("worker.spawn", { kind: "worker", name: "coder" }, "build it"),
        ),
      "worker.spawn requires at least one acceptance criterion",
    );

    expect(dispatched).toBe(false);
    expect(WorkItemStore.list()).toEqual([]);
  });

  test("worker.spawn rejects missing text or prompt after acceptance criteria is present", async () => {
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
            { kind: "worker", name: "coder" },
            { acceptanceCriteria: ["done"] },
          ),
        ),
      "worker.spawn requires text or prompt",
    );

    expect(dispatched).toBe(false);
    expect(WorkItemStore.list()).toEqual([]);
  });

  test("worker.spawn rejects unsupported payload fields before dispatch", async () => {
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
            { kind: "worker", name: "coder" },
            {
              text: "build",
              acceptanceCriteria: ["done"],
              agentName: "payload-name",
            },
          ),
        ),
      "worker.spawn payload contains unsupported fields",
    );

    expect(dispatched).toBe(false);
    expect(WorkItemStore.list()).toEqual([]);
  });

  test("worker.spawn reports invalid constraints before dispatch", async () => {
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
            { kind: "worker", name: "coder" },
            {
              text: "build",
              acceptanceCriteria: ["done"],
              constraints: [""],
            },
          ),
        ),
      "worker.spawn constraints must be non-empty strings",
    );

    expect(dispatched).toBe(false);
    expect(WorkItemStore.list()).toEqual([]);
  });

  test("worker.spawn preserves parent session lineage when provided", async () => {
    const parent = Session.create({
      traceId: "trace-worker-spawn-gate",
      title: "parent",
      model: { providerID: "test", modelID: "test" },
    });
    let dispatchedSessionId = "";
    const registry = registerWorkerSpawnHandler(async (sessionId, request) => {
      dispatchedSessionId = sessionId;
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
        { kind: "worker", name: "coder", parentSessionId: parent.id },
        workerSpawnPayload("build"),
      ),
    );

    const child = Session.get(dispatchedSessionId);
    expect(child?.parentSessionId).toBe(parent.id);
    expect(child?.spawnDepth).toBe((parent.spawnDepth ?? 0) + 1);
  });

  test("worker.spawn stamps the default required policy plan onto the request", async () => {
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

    const base = command(
      "worker.spawn",
      { kind: "worker", name: "coder", labels: ["web-search"] },
      workerSpawnPayload("research it"),
    );
    await registry.get("worker.spawn")?.({
      ...base,
      actor: { ...base.actor, labels: ["trusted"] },
    });

    expect(requests).toHaveLength(1);
    const plan = requests[0]?.policyPlan;
    expect(plan).toBeDefined();
    expect(plan?.policies).toContainEqual({ id: "builtin:tool-permission", required: true });
    expect(plan?.policies).toContainEqual({ id: "builtin:idle-nudge", required: true });
    expect(plan?.labels).toEqual(expect.arrayContaining(["trusted", "web-search"]));
  });

  test("worker.spawn applies injected resolver rules by task label", async () => {
    const requests: Execution.Request[] = [];
    const registry = new DispatchRegistry();
    registerBuiltInDispatchHandlers(registry, {
      owners: {
        coordinator: {
          dispatch: async (_sessionId, request) => {
            requests.push(request);
            return {
              runId: request.runId,
              sessionId: request.sessionId,
              status: "succeeded",
              output: "done",
            };
          },
        },
      },
      policyResolver: PolicyResolver.create([
        {
          match: { any: ["web-search"] },
          policies: ["custom:no-social-post"],
          required: true,
        },
      ]),
    });

    await registry.get("worker.spawn")?.(
      command(
        "worker.spawn",
        { kind: "worker", name: "coder", labels: ["web-search"] },
        workerSpawnPayload("research it"),
      ),
    );

    expect(requests[0]?.policyPlan?.policies).toContainEqual({
      id: "custom:no-social-post",
      required: true,
    });
  });
});
