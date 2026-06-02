import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Session, Storage, WorkerRunStateStore } from "@openomni/session";
import { CronJobRegistry } from "../../src/execution-runtime/cron-job-registry";
import { AgentToolProvider } from "../../src/execution-runtime/tool/agent/provider";
import type { DispatchToolRuntime } from "../../src/execution-runtime/tool/agent/tools/dispatch";
import {
  createInboundMessageTool,
  type InboundMessageDispatch,
} from "../../src/execution-runtime/tool/agent/tools/inbound-message";

function createWorkerRun(runId: string): void {
  const now = Date.now();
  Session.storage.set("caller-session", {
    id: "caller-session",
    title: "caller",
    model: { providerID: "test", modelID: "test" },
    time: { created: now, updated: now },
    spawnDepth: 0,
  });
  WorkerRunStateStore.create("caller-session", {
    runId,
    agentName: "worker",
    status: "running",
    title: "test run",
    prompt: "test",
  });
}

function clearCronJobs(): void {
  for (const job of CronJobRegistry.list()) {
    CronJobRegistry.remove(job.id);
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("inbound_message tool", () => {
  beforeEach(() => {
    Storage.reset();
    clearCronJobs();
  });

  afterEach(() => {
    Storage.reset();
    clearCronJobs();
  });

  test("increments depth across legitimate multi-hop dispatch calls", async () => {
    const dispatches: Parameters<InboundMessageDispatch["submit"]>[] = [];
    const tool = createInboundMessageTool({
      submit: async (...args) => {
        dispatches.push(args);
        return { status: "completed", output: "accepted" };
      },
    });

    const first = await tool.execute({
      id: "call-depth-0",
      tool: "inbound_message",
      input: {
        target: { kind: "worker", sessionId: "worker-session" },
        payload: "hop-1",
        wait: false,
        depth: 0,
      },
    });

    const second = await tool.execute({
      id: "call-depth-1",
      tool: "inbound_message",
      input: {
        target: { kind: "worker", sessionId: "worker-session" },
        payload: "hop-2",
        wait: false,
        depth: 1,
      },
    });
    await Bun.sleep(0);

    expect(first.isError).toBeUndefined();
    expect(second.isError).toBeUndefined();
    expect(dispatches).toHaveLength(2);
    expect(dispatches[0]?.[1].compatibility.depth).toBe(1);
    expect(dispatches[1]?.[1].compatibility.depth).toBe(2);
  });

  test("maps wait:false worker spawns through dispatch without calling ingress", async () => {
    const dispatches: Parameters<DispatchToolRuntime["submit"]>[] = [];
    const tool = createInboundMessageTool({
      dispatchRuntime: {
        submit: async (...args) => {
          dispatches.push(args);
          return { status: "completed", output: "accepted" };
        },
      },
    });

    const response = await tool.execute({
      id: "call-dispatch-spawn",
      tool: "inbound_message",
      input: {
        target: { kind: "worker" },
        action: "spawn",
        payload: "research task",
        wait: false,
        depth: 2,
        injectToHistory: true,
        sessionId: "caller-session",
        agentName: "resident",
        runId: "run-dispatch-spawn",
      },
    });
    await Bun.sleep(0);

    expect(response.isError).toBeUndefined();
    expect(JSON.parse(response.output)).toEqual({ status: "sent", messageId: expect.any(String) });
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.[0]).toMatchObject({
      action: "worker.spawn",
      target: { kind: "worker" },
      payload: "research task",
      wait: false,
      timeoutMs: 30000,
      correlation: { messageId: expect.any(String) },
    });
    expect(dispatches[0]?.[1]).toMatchObject({
      sourceTool: "inbound_message",
      sessionId: "caller-session",
      runId: "run-dispatch-spawn",
      agentName: "resident",
      compatibility: {
        messageId: expect.any(String),
        legacyAction: "spawn",
        depth: 3,
        injectToHistory: true,
      },
    });
  });

  test("maps wait:true resident delivery through dispatch and preserves delivered output", async () => {
    createWorkerRun("run-dispatch-wait");
    const dispatches: Parameters<InboundMessageDispatch["submit"]>[] = [];
    const tool = createInboundMessageTool({
      submit: async (...args) => {
        dispatches.push(args);
        return { status: "completed", dispatchId: "dispatch-1", output: "resident answer" };
      },
    });

    const response = await tool.execute({
      id: "call-dispatch-wait",
      tool: "inbound_message",
      input: {
        target: { kind: "resident" },
        payload: "what next?",
        wait: true,
        timeoutMs: 1_000,
        sessionId: "caller-session",
        agentName: "worker",
        runId: "run-dispatch-wait",
      },
    });

    expect(response.isError).toBeUndefined();
    expect(JSON.parse(response.output)).toEqual({
      status: "delivered",
      messageId: "dispatch-1",
      output: "resident answer",
    });
    expect(dispatches[0]?.[0]).toMatchObject({ action: "resident.deliver", wait: true });
    expect(dispatches[0]?.[1]).toMatchObject({
      wait: true,
      timeoutMs: 1000,
      compatibility: { depth: 1, injectToHistory: false },
    });
    expect(WorkerRunStateStore.get("caller-session", "run-dispatch-wait")).toMatchObject({
      status: "running",
      resumeCount: 1,
    });
  });

  test("maps schedule action through dispatch and preserves scheduled result shape", async () => {
    const dispatches: Parameters<InboundMessageDispatch["submit"]>[] = [];
    const tool = createInboundMessageTool({
      submit: async (...args) => {
        dispatches.push(args);
        return { status: "scheduled", dispatchId: "dispatch-schedule", jobId: "job-1" };
      },
    });

    const response = await tool.execute({
      id: "call-dispatch-schedule",
      tool: "inbound_message",
      input: {
        target: { kind: "resident", agentName: "dev" },
        action: "schedule",
        payload: "daily summary",
        schedule: "0 9 * * *",
        sessionId: "caller-session",
        agentName: "resident",
      },
    });

    expect(response.isError).toBeUndefined();
    expect(JSON.parse(response.output)).toEqual({
      status: "scheduled",
      messageId: "job-1",
      jobId: "job-1",
    });
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.[0]).toMatchObject({
      action: "schedule.create",
      payload: "daily summary",
    });
    expect(dispatches[0]?.[1]).toMatchObject({
      compatibility: {
        legacyAction: "schedule",
        schedule: "0 9 * * *",
        depth: 1,
        injectToHistory: false,
      },
    });
    expect(CronJobRegistry.list()).toEqual([]);
  });

  test("times out dispatch-backed wait:true calls with legacy error shape", async () => {
    const tool = createInboundMessageTool({
      submit: () => new Promise(() => undefined),
    });

    const response = await tool.execute({
      id: "call-dispatch-timeout",
      tool: "inbound_message",
      input: {
        target: { kind: "resident" },
        payload: "please answer",
        wait: true,
        timeoutMs: 1,
        sessionId: "caller-session",
        agentName: "worker",
        runId: "run-dispatch-timeout",
      },
    });

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.output)).toEqual({
      status: "error",
      messageId: expect.any(String),
      error: "inbound_message timed out after 1ms",
      timedOut: true,
    });
  });

  test("wait:false returns immediately after sending through dispatch", async () => {
    const dispatches: Parameters<InboundMessageDispatch["submit"]>[] = [];
    const tool = createInboundMessageTool({
      dispatchRuntime: {
        submit: async (...args) => {
          dispatches.push(args);
          return { status: "completed", output: "accepted" };
        },
      },
    });

    const response = await tool.execute({
      id: "call-async",
      tool: "inbound_message",
      input: {
        target: { kind: "worker", sessionId: "worker-session" },
        action: "send",
        payload: "continue",
        wait: false,
        sessionId: "caller-session",
        agentName: "resident",
        runId: "run-1",
      },
    });
    await Bun.sleep(0);

    expect(response.isError).toBeUndefined();
    expect(JSON.parse(response.output)).toEqual({ status: "sent", messageId: expect.any(String) });
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.[0]).toMatchObject({
      action: "worker.send",
      target: { kind: "worker", sessionId: "worker-session" },
      payload: "continue",
    });
    expect(dispatches[0]?.[1]).toMatchObject({
      sessionId: "caller-session",
      agentName: "resident",
      runId: "run-1",
      compatibility: { depth: 1, injectToHistory: false },
    });
  });

  test("wait:true returns delivered output from dispatch", async () => {
    createWorkerRun("run-sync");
    const pendingDispatch = deferred<{
      status: string;
      dispatchId: string;
      output: string;
    }>();
    const tool = createInboundMessageTool({
      submit: () => pendingDispatch.promise,
    });

    const responsePromise = tool.execute({
      id: "call-sync",
      tool: "inbound_message",
      input: {
        target: { kind: "worker", sessionId: "worker-session" },
        payload: "finish",
        wait: true,
        sessionId: "caller-session",
        agentName: "worker",
        runId: "run-sync",
      },
    });

    expect(WorkerRunStateStore.get("caller-session", "run-sync")?.status).toBe("waiting_input");
    pendingDispatch.resolve({ status: "completed", dispatchId: "dispatch-sync", output: "done" });
    const response = await responsePromise;

    expect(response.isError).toBeUndefined();
    expect(JSON.parse(response.output)).toEqual({
      status: "delivered",
      messageId: "dispatch-sync",
      output: "done",
    });
    expect(WorkerRunStateStore.get("caller-session", "run-sync")).toMatchObject({
      status: "running",
      resumeCount: 1,
    });
  });

  test("schedule action routes through dispatch without registering locally or calling ingress", async () => {
    const dispatches: Parameters<InboundMessageDispatch["submit"]>[] = [];
    const tool = createInboundMessageTool({
      dispatchRuntime: {
        submit: async (...args) => {
          dispatches.push(args);
          return { status: "scheduled", dispatchId: "dispatch-schedule", jobId: "job-1" };
        },
      },
    });

    const response = await tool.execute({
      id: "call-schedule",
      tool: "inbound_message",
      input: {
        target: { kind: "resident", agentName: "dev" },
        action: "schedule",
        payload: "daily summary",
        schedule: "0 9 * * *",
      },
    });

    expect(response.isError).toBeUndefined();
    expect(JSON.parse(response.output)).toEqual({
      status: "scheduled",
      messageId: "job-1",
      jobId: "job-1",
    });
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.[0]).toMatchObject({
      action: "schedule.create",
      payload: "daily summary",
    });
    expect(dispatches[0]?.[1]).toMatchObject({
      compatibility: { legacyAction: "schedule", schedule: "0 9 * * *" },
    });
    expect(CronJobRegistry.list()).toEqual([]);
  });

  test("wait:true times out when dispatch does not resolve", async () => {
    createWorkerRun("run-timeout");
    const tool = createInboundMessageTool({
      submit: () => new Promise(() => undefined),
    });

    const response = await tool.execute({
      id: "call-timeout",
      tool: "inbound_message",
      input: {
        target: { kind: "worker", sessionId: "worker-session" },
        payload: "finish",
        wait: true,
        timeoutMs: 1,
        sessionId: "caller-session",
        agentName: "worker",
        runId: "run-timeout",
      },
    });

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.output)).toEqual({
      status: "error",
      messageId: expect.any(String),
      error: "inbound_message timed out after 1ms",
      timedOut: true,
    });
    expect(WorkerRunStateStore.get("caller-session", "run-timeout")?.status).toBe("running");
  });

  test("wait:true abort signal cancels the dispatch wait", async () => {
    createWorkerRun("run-abort");
    const controller = new AbortController();
    const tool = createInboundMessageTool({
      submit: () => new Promise(() => undefined),
    });

    const responsePromise = tool.execute(
      {
        id: "call-abort",
        tool: "inbound_message",
        input: {
          target: { kind: "worker", sessionId: "worker-session" },
          payload: "finish",
          wait: true,
          timeoutMs: 1_000,
          sessionId: "caller-session",
          agentName: "worker",
          runId: "run-abort",
        },
      },
      { signal: controller.signal },
    );

    expect(WorkerRunStateStore.get("caller-session", "run-abort")?.status).toBe("waiting_input");
    controller.abort();
    const response = await responsePromise;

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.output)).toEqual({
      status: "error",
      messageId: expect.any(String),
      error: "inbound_message aborted",
    });
    expect(WorkerRunStateStore.get("caller-session", "run-abort")?.status).toBe("running");
  });

  test("rejects calls at and beyond the depth limit before dispatch", async () => {
    const calls: number[] = [];
    const tool = createInboundMessageTool({
      submit: async () => {
        calls.push(Date.now());
        return { status: "completed", output: "should not happen" };
      },
    });

    const atLimit = await tool.execute({
      id: "call-depth-10",
      tool: "inbound_message",
      input: { target: { kind: "worker" }, payload: "loop", depth: 10 },
    });

    const beyondLimit = await tool.execute({
      id: "call-depth",
      tool: "inbound_message",
      input: { target: { kind: "worker" }, payload: "loop", depth: 11 },
    });

    expect(atLimit.isError).toBe(true);
    expect(atLimit.output).toContain("depth limit exceeded");
    expect(beyondLimit.isError).toBe(true);
    expect(beyondLimit.output).toContain("depth limit exceeded");
    expect(calls).toHaveLength(0);
  });

  test("allows depth just under the limit through dispatch", async () => {
    const dispatches: Parameters<InboundMessageDispatch["submit"]>[] = [];
    const tool = createInboundMessageTool({
      submit: async (...args) => {
        dispatches.push(args);
        return { status: "completed", output: "accepted" };
      },
    });

    const response = await tool.execute({
      id: "call-depth-9",
      tool: "inbound_message",
      input: {
        target: { kind: "worker", sessionId: "worker-session" },
        payload: "loop",
        depth: 9,
      },
    });
    await Bun.sleep(0);

    expect(response.isError).toBeUndefined();
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.[1].compatibility.depth).toBe(10);
  });

  test("authority-denied dispatch errors return error-shaped tool results", async () => {
    const tool = createInboundMessageTool({
      submit: async () => ({
        status: "failed",
        dispatchId: "dispatch-denied",
        error: "actor is not authorized to create top-level inbound work",
      }),
    });

    const response = await tool.execute({
      id: "call-denied",
      tool: "inbound_message",
      input: {
        target: { kind: "worker" },
        payload: "spawn work",
        wait: true,
        sessionId: "caller-session",
        agentName: "worker",
      },
    });

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.output)).toEqual({
      status: "error",
      messageId: "dispatch-denied",
      error: "actor is not authorized to create top-level inbound work",
    });
  });

  test("AgentToolProvider registers inbound_message for agent callers", () => {
    const provider = new AgentToolProvider();

    expect(provider.listTools().some((tool) => tool.spec.name === "inbound_message")).toBe(true);
  });

  test("uses caller context when the executor supplies implicit inputs", async () => {
    const dispatches: Parameters<InboundMessageDispatch["submit"]>[] = [];
    const provider = new AgentToolProvider({
      dispatchRuntime: {
        async submit(...args) {
          dispatches.push(args);
          return { dispatchId: "dispatch-provider", status: "completed", output: "ok" };
        },
      },
    });

    const response = await provider.execute({
      id: "call-provider",
      tool: "inbound_message",
      input: {
        target: { kind: "resident", agentName: "main" },
        payload: "status",
        sessionId: "caller-session",
        agentName: "resident",
        runId: "run-provider",
      },
    });

    expect(response.isError).toBeUndefined();
    expect(dispatches[0]?.[1]).toMatchObject({
      sessionId: "caller-session",
      agentName: "resident",
      runId: "run-provider",
    });
    expect(dispatches[0]?.[0]).toMatchObject({
      action: "resident.deliver",
      target: { kind: "resident" },
      payload: "status",
    });
  });
});
