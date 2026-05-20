import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Ingress } from "@openomni/protocol";
import { Session, Storage, WorkerRunStateStore } from "@openomni/session";
import { CronJobRegistry } from "../../src/execution-runtime/cron-job-registry";
import { AgentToolProvider } from "../../src/execution-runtime/tool/agent/provider";
import { createInboundMessageTool } from "../../src/execution-runtime/tool/agent/tools/inbound-message";

function result(output: string): Ingress.IngressResult {
  return {
    mode: "direct",
    target: { kind: "worker", sessionId: "worker-session" },
    sessionId: "worker-session",
    result: { output, finishReason: "stop" },
  };
}

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

  test("increments depth across legitimate multi-hop calls", async () => {
    const events: Ingress.InboundEvent[] = [];
    const tool = createInboundMessageTool({
      ingest: async (event) => {
        events.push(event);
        return result("accepted");
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

    expect(first.isError).toBeUndefined();
    expect(second.isError).toBeUndefined();
    expect(events).toHaveLength(2);
    expect(events[0]?.meta?.depth).toBe(1);
    expect(events[1]?.meta?.depth).toBe(2);
  });

  test("wait:false returns immediately after sending through ingress", async () => {
    const events: Ingress.InboundEvent[] = [];
    const tool = createInboundMessageTool({
      ingest: async (event) => {
        events.push(event);
        return result("accepted");
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

    expect(response.isError).toBeUndefined();
    expect(JSON.parse(response.output)).toEqual({ status: "sent", messageId: events[0]?.id });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      mode: "direct",
      payload: "continue",
      target: { kind: "worker", sessionId: "worker-session" },
      meta: {
        action: "send",
        depth: 1,
        actor: { role: "resident", sessionId: "caller-session", agentName: "resident" },
      },
    });
  });

  test("wait:true returns delivered output from ingress", async () => {
    createWorkerRun("run-sync");
    const pendingIngress = deferred<Ingress.IngressResult>();
    const tool = createInboundMessageTool({
      ingest: () => pendingIngress.promise,
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
    pendingIngress.resolve(result("done"));
    const response = await responsePromise;

    expect(response.isError).toBeUndefined();
    expect(JSON.parse(response.output)).toEqual({
      status: "delivered",
      messageId: expect.any(String),
      output: "done",
    });
    expect(WorkerRunStateStore.get("caller-session", "run-sync")).toMatchObject({
      status: "running",
      resumeCount: 1,
    });
  });

  test("schedule action registers a cron job without calling ingress", async () => {
    const events: Ingress.InboundEvent[] = [];
    const tool = createInboundMessageTool({
      ingest: async (event) => {
        events.push(event);
        return result("should not run");
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

    const output = JSON.parse(response.output);
    const jobs = CronJobRegistry.list();

    expect(response.isError).toBeUndefined();
    expect(output.status).toBe("scheduled");
    expect(typeof output.messageId).toBe("string");
    expect(typeof output.jobId).toBe("string");
    expect(output.jobId).toBe(output.messageId);
    expect(events).toHaveLength(0);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: output.jobId,
      agentName: "dev",
      payload: "daily summary",
      schedule: "0 9 * * *",
      target: { kind: "resident" },
    });
    expect(CronJobRegistry.remove(output.jobId)).toBe(true);
    expect(CronJobRegistry.list()).toEqual([]);
  });

  test("wait:true times out when ingress does not resolve", async () => {
    createWorkerRun("run-timeout");
    const tool = createInboundMessageTool({
      ingest: () => new Promise(() => undefined),
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

  test("wait:true abort signal cancels the wait", async () => {
    createWorkerRun("run-abort");
    const controller = new AbortController();
    const tool = createInboundMessageTool({
      ingest: () => new Promise(() => undefined),
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

  test("rejects calls at and beyond the depth limit before ingress", async () => {
    const calls: number[] = [];
    const tool = createInboundMessageTool({
      ingest: async () => {
        calls.push(Date.now());
        return result("should not happen");
      },
    });

    const atLimit = await tool.execute({
      id: "call-depth-10",
      tool: "inbound_message",
      input: {
        target: { kind: "worker" },
        payload: "loop",
        depth: 10,
      },
    });

    const beyondLimit = await tool.execute({
      id: "call-depth",
      tool: "inbound_message",
      input: {
        target: { kind: "worker" },
        payload: "loop",
        depth: 11,
      },
    });

    expect(atLimit.isError).toBe(true);
    expect(atLimit.output).toContain("depth limit exceeded");
    expect(beyondLimit.isError).toBe(true);
    expect(beyondLimit.output).toContain("depth limit exceeded");
    expect(calls).toHaveLength(0);
  });

  test("allows depth just under the limit", async () => {
    const events: Ingress.InboundEvent[] = [];
    const tool = createInboundMessageTool({
      ingest: async (event) => {
        events.push(event);
        return result("accepted");
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

    expect(response.isError).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0]?.meta?.depth).toBe(10);
  });

  test("authority-denied ingress errors return error-shaped tool results", async () => {
    const tool = createInboundMessageTool({
      ingest: async () => {
        throw new Error("actor is not authorized to create top-level inbound work");
      },
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
      messageId: expect.any(String),
      error: "actor is not authorized to create top-level inbound work",
    });
  });

  test("AgentToolProvider registers inbound_message for agent callers", () => {
    const provider = new AgentToolProvider({ ingressEngine: { ingest: async () => result("ok") } });

    expect(provider.listTools().some((tool) => tool.spec.name === "inbound_message")).toBe(true);
  });

  test("uses caller context when the executor supplies implicit inputs", async () => {
    const events: Ingress.InboundEvent[] = [];
    const provider = new AgentToolProvider({
      ingressEngine: {
        ingest: async (event) => {
          events.push(event);
          return result("ok");
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
    expect(events[0]?.meta?.actor).toMatchObject({
      role: "resident",
      sessionId: "caller-session",
      agentName: "resident",
    });
  });
});
