import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  AgentToolProvider,
  type DispatchRuntime,
  ResidentRuntime,
  SystemToolProvider,
} from "@openomni/openomni";
import { IngressEventProjector, IngressHandlers } from "../../../../packages/openomni/src/ingress";
import { WorkItem, type Dispatch } from "@openomni/protocol";
import {
  Bus,
  PendingAskStore,
  Session,
  Storage,
  SurfaceKey,
  WorkItemAttemptRun,
  WorkItemStore,
} from "@openomni/session";
import { createResidentInboundWaitHandler } from "../../src/bootstrap/resident-inbound-wait";
import type { ServerConfig } from "../../src/config";
import { CustomToolProvider } from "../../src/tool/custom";
import { McpToolProvider } from "../../src/tool/mcp";
import { TEST_BOOT_TRACE_ID } from "../tool/mcp/provider-test-fixture";

/**
 * #510 D2b — the inbound wait acquires and releases the run's wait through
 * WorkItem attempt facts (waiting_input blocker on the work stream), never
 * through worker_run_state writes (the worker-run store is frozen).
 */

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
  messaging: { grants: [] },
};

const originalBeginWait = WorkItemAttemptRun.beginWait;
const originalEndWait = WorkItemAttemptRun.endWait;
const originalPendingCreate = PendingAskStore.create;
const originalPendingAnswer = PendingAskStore.answer;
const originalPendingExpire = PendingAskStore.expire;
const originalSurfaceList = SurfaceKey.listBySession;
const originalProject = IngressEventProjector.project;
const originalHandleResident = IngressHandlers.handleResident;

beforeEach(() => {
  Bus.reset();
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
  PendingAskStore.create = mock(originalPendingCreate);
  PendingAskStore.answer = mock(originalPendingAnswer);
  PendingAskStore.expire = mock(originalPendingExpire);
  SurfaceKey.listBySession = mock(originalSurfaceList);
  IngressEventProjector.project = mock(originalProject);
  IngressHandlers.handleResident = mock(originalHandleResident);
});

afterEach(() => {
  WorkItemAttemptRun.beginWait = originalBeginWait;
  WorkItemAttemptRun.endWait = originalEndWait;
  PendingAskStore.create = originalPendingCreate;
  PendingAskStore.answer = originalPendingAnswer;
  PendingAskStore.expire = originalPendingExpire;
  SurfaceKey.listBySession = originalSurfaceList;
  IngressEventProjector.project = originalProject;
  IngressHandlers.handleResident = originalHandleResident;
  Bus.reset();
  Storage.reset();
});

function attemptIdentity(prompt: string) {
  return {
    contentFingerprint: WorkItem.contentFingerprintOf({
      workInput: prompt,
      handlerKind: "internal_chat_agent",
      handlerCodeRef: { absent: true, reason: "not captured in tests" },
      model: {
        provider: "test",
        id: "worker-model",
        parameters: { absent: true, reason: "no parameters configured" },
      },
      upstreamFingerprints: { absent: true, reason: "no upstream attempts" },
      dependencyLock: { absent: true, reason: "not read in tests" },
    }),
    environmentFingerprint: WorkItem.environmentFingerprintOf({
      os: process.platform,
      arch: process.arch,
      bunVersion: process.versions.bun ?? process.version,
      workspaceRoot: { absent: true, reason: "no workspace in tests" },
      schemaVersions: { policyKernel: 1 },
      policy: { absent: true, reason: "no policy plan in tests" },
      toolVersions: { absent: true, reason: "not enumerated in tests" },
      verifierVersions: { absent: true, reason: "not enumerated in tests" },
      providerParameters: { absent: true, reason: "no provider parameters" },
      configRef: { absent: true, reason: "no config identity in tests" },
    }),
  };
}

async function createActiveRun(runId: string) {
  const residentSession = Session.create({
    title: "resident",
    model: { providerID: "test", modelID: "resident-model" },
  });
  const workerSession = Session.create({
    title: "worker",
    model: { providerID: "test", modelID: "worker-model" },
  });
  const created = await WorkItemStore.create({
    name: `worker run ${runId}`,
    sourceMessageId: `seed:${runId}`,
    sourceChannel: "ingress",
    intent: "worker.dispatch",
    goal: "ask the Resident",
    sessionId: workerSession.id,
    originSessionId: residentSession.id,
    workSessionId: workerSession.id,
    workerRunId: runId,
    executorKind: "internal_chat_agent",
    acceptanceCriteria: ["the dispatched worker run reaches a terminal attempt outcome"],
  });
  await WorkItemStore.start(created.hash);
  const allocation = await WorkItemStore.allocateAttempt(
    created.hash,
    attemptIdentity("ask the Resident"),
  );
  if (!allocation) throw new Error("attempt allocation failed");
  return {
    residentSessionId: residentSession.id,
    workerSessionId: workerSession.id,
    runId,
    workItemHash: created.hash,
  };
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
    mcpProvider: new McpToolProvider({ traceId: TEST_BOOT_TRACE_ID }),
    customProvider: new CustomToolProvider(),
  };
  return createResidentInboundWaitHandler(config);
}

function waitParams(run: Awaited<ReturnType<typeof createActiveRun>>, signal?: AbortSignal) {
  return {
    workerId: "worker-1",
    traceId: "trace-inbound-wait",
    sessionId: run.workerSessionId,
    runId: run.runId,
    payload: "Should I proceed?",
    workspaceRoot: "/workspace",
    ...(signal ? { signal } : {}),
  };
}

function currentStatus(run: Awaited<ReturnType<typeof createActiveRun>>) {
  return WorkItemAttemptRun.find(run.workerSessionId, run.runId)?.status;
}

function waitBlockers(run: Awaited<ReturnType<typeof createActiveRun>>) {
  return (WorkItemStore.get(run.workItemHash)?.blockers ?? []).filter(
    (blocker) => blocker.kind === "waiting_input",
  );
}

describe("resident inbound wait kernel dispatch", () => {
  it("submits resident.ask through the shared runtime and restores the run", async () => {
    // Given
    const run = await createActiveRun("run-success");
    const calls: SubmitArgs[] = [];
    const submit = mock(async (...args: SubmitArgs): Promise<Dispatch.Result> => {
      calls.push(args);
      // The run holds the wait while the Resident answers.
      expect(currentStatus(run)).toBe("waiting_input");
      return { dispatchId: "resident-ask", status: "completed", output: "Proceed carefully." };
    });
    const handler = createHandler(submit);

    // When
    const result = await handler(waitParams(run));

    // Then
    expect(currentStatus(run)).toBe("running");
    // The wait acquire/release is durable attempt-fact history: one
    // waiting_input blocker, added and resolved on the work stream.
    const blockers = waitBlockers(run);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]?.resolvedAt).toBeDefined();
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
    const correlation = call[0].correlation;
    if (typeof correlation !== "string") throw new Error("shape");
    expect(call[1]).toEqual({
      // The asking run's trace crosses the IPC hop and is what the Resident
      // dispatches under; the handler never starts a second one.
      traceId: "trace-inbound-wait",
      sessionId: run.workerSessionId,
      runId: run.runId,
      actorKind: "worker",
      actorId: `${run.workerSessionId}:${run.runId}`,
      agentName: "worker",
      trustTier: "assigned_worker",
      workspaceRoot: "/workspace",
    });
    expect(result).toEqual({
      requestId: correlation,
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

  it("returns a shared dispatch failure and restores the wait to running", async () => {
    // Given
    const run = await createActiveRun("run-failure");
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
    expect(currentStatus(run)).toBe("running");
    expect(waitBlockers(run)[0]?.resolvedAt).toBeDefined();
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("rejects a run whose attempt already ended before the wait", async () => {
    const run = await createActiveRun("run-cancelled-before-wait");
    await WorkItemAttemptRun.finish(run.workerSessionId, run.runId, "cancelled", {
      endedAt: Date.now(),
    });
    const submit = mock(
      async (): Promise<Dispatch.Result> => ({
        dispatchId: "resident-ask-after-cancel",
        status: "completed",
        output: "Already cancelled.",
      }),
    );

    const result = await createHandler(submit)(waitParams(run));

    expect(result).toMatchObject({
      accepted: false,
      error: "worker.inbound_wait run is no longer active",
    });
    expect(currentStatus(run)).toBe("cancelled");
    expect(submit).toHaveBeenCalledTimes(0);
  });

  it("does not enter the wait when cancellation wins the acquire race", async () => {
    const run = await createActiveRun("run-cancelled-entering-wait");
    const submit = mock(
      async (): Promise<Dispatch.Result> => ({
        dispatchId: "resident-ask-after-entry-cancel",
        status: "completed",
        output: "Already cancelled.",
      }),
    );
    WorkItemAttemptRun.beginWait = mock(async (...args: Parameters<typeof originalBeginWait>) => {
      // The cancel lands between the handler's read and the acquire CAS.
      await WorkItemAttemptRun.finish(run.workerSessionId, run.runId, "cancelled", {
        endedAt: Date.now(),
      });
      return originalBeginWait(...args);
    });

    const result = await createHandler(submit)(waitParams(run));

    expect(result).toMatchObject({
      accepted: false,
      error: "worker.inbound_wait run is no longer active",
    });
    expect(currentStatus(run)).toBe("cancelled");
    expect(submit).toHaveBeenCalledTimes(0);
  });

  it("keeps the terminal record when cancellation wins the release race", async () => {
    const run = await createActiveRun("run-cancelled-restoring-wait");
    const submit = mock(
      async (): Promise<Dispatch.Result> => ({
        dispatchId: "resident-ask-before-restoration-cancel",
        status: "completed",
        output: "Answer delivered.",
      }),
    );
    WorkItemAttemptRun.endWait = mock(async (...args: Parameters<typeof originalEndWait>) => {
      // The cancel lands while the Resident's answer is in flight: the
      // terminal fact resolves the wait, so the release is a no-op receipt.
      await WorkItemAttemptRun.finish(run.workerSessionId, run.runId, "cancelled", {
        endedAt: Date.now(),
      });
      return originalEndWait(...args);
    });

    const result = await createHandler(submit)(waitParams(run));

    expect(result).toMatchObject({ accepted: true, output: "Answer delivered." });
    expect(currentStatus(run)).toBe("cancelled");
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("rejects a run without a parent Resident session and a missing runId alike", async () => {
    const run = await createActiveRun("run-parentless");
    // A run whose WorkItem carries no originSessionId has no Resident to ask.
    const orphan = await WorkItemStore.create({
      name: "orphan run",
      sourceMessageId: "seed:run-orphan",
      sourceChannel: "ingress",
      intent: "worker.dispatch",
      goal: "ask nobody",
      sessionId: run.workerSessionId,
      workSessionId: run.workerSessionId,
      workerRunId: "run-orphan",
      executorKind: "internal_chat_agent",
      acceptanceCriteria: ["the dispatched worker run reaches a terminal attempt outcome"],
    });
    await WorkItemStore.start(orphan.hash);
    const submit = mock(
      async (): Promise<Dispatch.Result> => ({ dispatchId: "never", status: "completed" }),
    );
    const handler = createHandler(submit);

    const orphaned = await handler({ ...waitParams(run), runId: "run-orphan" });
    expect(orphaned).toMatchObject({
      accepted: false,
      error: "worker.inbound_wait requires a worker run with parent Resident session: run-orphan",
    });

    const { runId: _omitted, ...paramsWithoutRunId } = waitParams(run);
    const missingRunId = await handler(paramsWithoutRunId);
    expect(missingRunId).toMatchObject({
      accepted: false,
      error: "worker.inbound_wait requires a worker run with parent Resident session: unknown",
    });
    expect(submit).toHaveBeenCalledTimes(0);
    // Neither rejection touched the healthy run.
    expect(currentStatus(run)).toBe("running");
    expect(waitBlockers(run)).toHaveLength(0);
  });

  it("normalizes resident.ask outputs: nested envelope unwraps, non-string falls to empty", async () => {
    const nestedRun = await createActiveRun("run-nested-output");
    const nested = await createHandler(
      mock(
        async (): Promise<Dispatch.Result> => ({
          dispatchId: "resident-ask-nested",
          status: "completed",
          output: { output: "nested answer" },
        }),
      ),
    )(waitParams(nestedRun));
    expect(nested).toMatchObject({ accepted: true, output: "nested answer" });

    const numericRun = await createActiveRun("run-numeric-output");
    const numeric = await createHandler(
      mock(
        async (): Promise<Dispatch.Result> => ({
          dispatchId: "resident-ask-numeric",
          status: "completed",
          output: 42 as unknown as string,
        }),
      ),
    )(waitParams(numericRun));
    expect(numeric).toMatchObject({ accepted: true, output: "" });
  });

  it("rejects an already-aborted wait without dispatching or changing run state", async () => {
    // Given
    const run = await createActiveRun("run-aborted");
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
    expect(currentStatus(run)).toBe("running");
    expect(waitBlockers(run)).toHaveLength(0);
    expect(submit).toHaveBeenCalledTimes(0);
  });
});
