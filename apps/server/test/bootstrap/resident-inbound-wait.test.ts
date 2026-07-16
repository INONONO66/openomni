import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  AgentToolProvider,
  type DispatchRuntime,
  IngressEventProjector,
  IngressHandlers,
  ResidentRuntime,
  SystemToolProvider,
} from "@openomni/openomni";
import type { Dispatch } from "@openomni/protocol";
import { Bus, PendingAskStore, Session, Storage, SurfaceKey, WorkerRun } from "@openomni/session";
import { createResidentInboundWaitHandler } from "../../src/bootstrap/resident-inbound-wait";
import type { ServerConfig } from "../../src/config";
import { CustomToolProvider } from "../../src/tool/custom";
import { McpToolProvider } from "../../src/tool/mcp";

type WorkerStatus = Parameters<typeof WorkerRun.updateStatus>[2];
type SubmitArgs = Parameters<DispatchRuntime["submit"]>;

const serverConfig: ServerConfig = {
  workspace: { root: "/workspace" },
  model: { provider: "test", id: "resident-model" },
  mcp: { servers: [] },
  server: { port: 3000, host: "127.0.0.1" },
  storage: { dbPath: ":memory:" },
  telegram: { allowedUsers: [] },
  github: { allowedUsers: [] },
  discord: { allowedUsers: [] },
};

const originalUpdateStatus = WorkerRun.updateStatus;
const originalPendingCreate = PendingAskStore.create;
const originalPendingAnswer = PendingAskStore.answer;
const originalPendingExpire = PendingAskStore.expire;
const originalSurfaceList = SurfaceKey.listBySession;
const originalProject = IngressEventProjector.project;
const originalHandleResident = IngressHandlers.handleResident;
let statusHistory: WorkerStatus[] = [];

beforeEach(() => {
  Bus.reset();
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
  statusHistory = [];
  WorkerRun.updateStatus = mock(async (...args: Parameters<typeof originalUpdateStatus>) => {
    statusHistory.push(args[2]);
    await originalUpdateStatus(...args);
  });
  PendingAskStore.create = mock(originalPendingCreate);
  PendingAskStore.answer = mock(originalPendingAnswer);
  PendingAskStore.expire = mock(originalPendingExpire);
  SurfaceKey.listBySession = mock(originalSurfaceList);
  IngressEventProjector.project = mock(originalProject);
  IngressHandlers.handleResident = mock(originalHandleResident);
});

afterEach(() => {
  WorkerRun.updateStatus = originalUpdateStatus;
  PendingAskStore.create = originalPendingCreate;
  PendingAskStore.answer = originalPendingAnswer;
  PendingAskStore.expire = originalPendingExpire;
  SurfaceKey.listBySession = originalSurfaceList;
  IngressEventProjector.project = originalProject;
  IngressHandlers.handleResident = originalHandleResident;
  Bus.reset();
  Storage.reset();
});

async function createStartingRun(runId: string) {
  const residentSession = Session.create({
    title: "resident",
    model: { providerID: "test", modelID: "resident-model" },
  });
  const workerSession = Session.create({
    title: "worker",
    model: { providerID: "test", modelID: "worker-model" },
  });
  await WorkerRun.create(workerSession.id, {
    runId,
    parentSessionId: residentSession.id,
    title: "worker run",
    prompt: "ask the Resident",
  });
  await WorkerRun.updateStatus(workerSession.id, runId, "starting");
  return { residentSessionId: residentSession.id, workerSessionId: workerSession.id, runId };
}

function createHandler(submit: DispatchRuntime["submit"]) {
  const config = {
    dispatchRuntime: { submit },
    serverConfig,
    model: { providerID: "test", id: "resident-model" },
    residentRuntime: new ResidentRuntime({
      runAgent: async () => ({ text: "legacy response", finishReason: "stop" }),
    }),
    systemProvider: new SystemToolProvider("/workspace"),
    requireAgentProvider: () => new AgentToolProvider(),
    mcpProvider: new McpToolProvider(),
    customProvider: new CustomToolProvider(),
  };
  return createResidentInboundWaitHandler(config);
}

function waitParams(run: Awaited<ReturnType<typeof createStartingRun>>, signal?: AbortSignal) {
  return {
    workerId: "worker-1",
    sessionId: run.workerSessionId,
    runId: run.runId,
    payload: "Should I proceed?",
    workspaceRoot: "/workspace",
    ...(signal ? { signal } : {}),
  };
}

async function currentStatus(run: Awaited<ReturnType<typeof createStartingRun>>) {
  return (await WorkerRun.get(run.workerSessionId, run.runId))?.status;
}

describe("resident inbound wait kernel dispatch", () => {
  it("submits resident.ask through the shared runtime and restores the WorkerRun", async () => {
    // Given
    const run = await createStartingRun("run-success");
    const calls: SubmitArgs[] = [];
    const submit = mock(async (...args: SubmitArgs): Promise<Dispatch.Result> => {
      calls.push(args);
      return { dispatchId: "resident-ask", status: "completed", output: "Proceed carefully." };
    });
    const handler = createHandler(submit);

    // When
    const result = await handler(waitParams(run));

    // Then
    expect(statusHistory).toEqual(["starting", "running", "waiting_input", "running"]);
    expect(await currentStatus(run)).toBe("running");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error("expected shared dispatch call");
    expect(call[0]).toMatchObject({
      action: "resident.ask",
      target: { kind: "resident", sessionId: run.residentSessionId },
      payload: "Worker worker-1 run run-success asks Resident:\n\nShould I proceed?",
      wait: true,
    });
    expect(typeof call[0].correlation).toBe("string");
    expect(call[1]).toEqual({
      sessionId: run.workerSessionId,
      runId: run.runId,
      actorKind: "worker",
      actorId: `${run.workerSessionId}:${run.runId}`,
      agentName: "worker",
      trustTier: "assigned_worker",
      workspaceRoot: "/workspace",
    });
    expect(result).toEqual({
      requestId: call[0].correlation,
      accepted: true,
      output: "Proceed carefully.",
    });
    expect(PendingAskStore.create).toHaveBeenCalledTimes(0);
    expect(PendingAskStore.answer).toHaveBeenCalledTimes(0);
    expect(PendingAskStore.expire).toHaveBeenCalledTimes(0);
    expect(SurfaceKey.listBySession).toHaveBeenCalledTimes(0);
    expect(IngressEventProjector.project).toHaveBeenCalledTimes(0);
    expect(IngressHandlers.handleResident).toHaveBeenCalledTimes(0);
  });

  it("returns a shared dispatch failure and restores waiting_input to running", async () => {
    // Given
    const run = await createStartingRun("run-failure");
    const submit = mock(
      async (): Promise<Dispatch.Result> => ({
        dispatchId: "resident-ask-failed",
        status: "failed",
        error: "Resident unavailable",
      }),
    );
    const handler = createHandler(submit);

    // When
    const result = await handler(waitParams(run));

    // Then
    expect(result).toMatchObject({ accepted: false, error: "Resident unavailable" });
    expect(statusHistory).toEqual(["starting", "running", "waiting_input", "running"]);
    expect(await currentStatus(run)).toBe("running");
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("rejects an already-aborted wait without dispatching or changing WorkerRun state", async () => {
    // Given
    const run = await createStartingRun("run-aborted");
    const controller = new AbortController();
    controller.abort();
    const submit = mock(
      async (): Promise<Dispatch.Result> => ({
        dispatchId: "must-not-dispatch",
        status: "completed",
      }),
    );
    const handler = createHandler(submit);

    // When
    const result = await handler(waitParams(run, controller.signal));

    // Then
    expect(result).toMatchObject({ accepted: false, error: "worker.inbound_wait aborted" });
    expect(statusHistory).toEqual(["starting"]);
    expect(await currentStatus(run)).toBe("starting");
    expect(submit).toHaveBeenCalledTimes(0);
  });
});
