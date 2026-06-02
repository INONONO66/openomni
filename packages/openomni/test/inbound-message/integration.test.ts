import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { IngressEvent, type Ingress } from "@openomni/protocol";
import { Bus, Session, Storage } from "@openomni/session";
import { CronJobRegistry } from "../../src/execution-runtime/cron-job-registry";
import {
  createInboundMessageTool,
  type InboundMessageDispatch,
} from "../../src/execution-runtime/tool/agent/tools/inbound-message";
import {
  defaultRunFn,
  mockModelsGet,
  mockProviderFromModelsDevModel,
  resetTestState,
  testState,
} from "../ingress/_llm-mock";

let IngressEngine: typeof import("../../src/ingress/engine").IngressEngine;
let ResidentRuntime: typeof import("../../src/resident/runtime").ResidentRuntime;
let CronAdapter: typeof import("../../src/ingress/cron-adapter").CronAdapter;

interface DispatchRecord {
  readonly sessionId: string;
  readonly runId: string;
  readonly prompt: string;
  readonly target?: Ingress.Target;
}

interface DeliveredRecord {
  readonly sessionId: string;
  readonly prompt: string;
  readonly runId?: string;
}

const dispatches: DispatchRecord[] = [];
const deliveries: DeliveredRecord[] = [];

beforeAll(async () => {
  ({ IngressEngine } = await import("../../src/ingress/engine"));
  ({ ResidentRuntime } = await import("../../src/resident/runtime"));
  ({ CronAdapter } = await import("../../src/ingress/cron-adapter"));
});

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  resetTestState();
  testState.runFn = defaultRunFn("inbound-message-integration-test");
  mockModelsGet.mockClear();
  mockProviderFromModelsDevModel.mockClear();
  dispatches.length = 0;
  deliveries.length = 0;
  clearCronJobs();
  IngressEngine.reset();
  Storage.initialize({ dbPath: ":memory:" });
  installResidentRuntime();
  installCoordinator();
  IngressEngine.setAgentResolver({
    resolve: async () => ({ model: { provider: "anthropic", id: "claude-3-5-sonnet" } }),
  });
});

describe("inbound_message integration flows", () => {
  it("sends resident worker spawns asynchronously through dispatch", async () => {
    const tool = inboundTool();

    const response = await tool.execute({
      id: "call-resident-worker-spawn",
      tool: "inbound_message",
      input: {
        target: { kind: "worker" },
        action: "spawn",
        payload: "research task",
        wait: false,
        sessionId: "resident-session",
        agentName: "resident",
        runId: "resident-run-1",
      },
    });

    await waitFor(() => dispatches.length === 1);

    expect(response.isError).toBeUndefined();
    expect(JSON.parse(response.output)).toEqual({
      status: "sent",
      messageId: expect.any(String),
    });
    expect(dispatches[0]).toMatchObject({ prompt: "research task" });
  });

  it("delivers a worker question to the resident and returns the sync answer", async () => {
    testState.responseQueue.push("resident answer");
    const received = collectBusEvents(IngressEvent.Received);
    const tool = inboundTool();

    const response = await tool.execute({
      id: "call-worker-resident-sync",
      tool: "inbound_message",
      input: {
        target: { kind: "resident" },
        payload: "what should I do next?",
        wait: true,
        timeoutMs: 1_000,
        sessionId: "worker-session",
        agentName: "resident",
        runId: "worker-run-1",
      },
    });
    received.unsubscribe();

    expect(response.isError).toBeUndefined();
    expect(JSON.parse(response.output)).toEqual({
      status: "delivered",
      messageId: expect.any(String),
      output: "resident answer",
    });
    expect(received.events).toHaveLength(0);
  });

  it("sends worker messages to an existing worker session", async () => {
    const workerSession = createWorkerSession("other-worker");
    const received = collectBusEvents(IngressEvent.Received);
    const completed = collectBusEvents(IngressEvent.Completed);
    const tool = inboundTool();

    const response = await tool.execute({
      id: "call-worker-worker-send",
      tool: "inbound_message",
      input: {
        target: { kind: "worker", sessionId: workerSession.id },
        action: "send",
        payload: "continue with this context",
        wait: true,
        timeoutMs: 1_000,
        sessionId: "caller-worker-session",
        agentName: "resident",
        runId: "caller-worker-run",
      },
    });
    received.unsubscribe();
    completed.unsubscribe();

    expect(response.isError).toBeUndefined();
    expect(JSON.parse(response.output)).toMatchObject({
      status: "delivered",
      output: expect.stringContaining('"delivered":true'),
    });
    expect(deliveries).toEqual([
      { sessionId: workerSession.id, prompt: "continue with this context", runId: undefined },
    ]);
    expect(received.events).toHaveLength(0);
    expect(completed.events).toHaveLength(0);
  });

  it("schedules a cron inbound message and fires it into resident execution", async () => {
    testState.responseQueue.push("daily done");
    const received = collectBusEvents(IngressEvent.Received);
    const tool = inboundTool();

    const response = await tool.execute({
      id: "call-cron-schedule",
      tool: "inbound_message",
      input: {
        target: { kind: "resident", agentName: "main" },
        action: "schedule",
        payload: "daily planning",
        schedule: "0 9 * * *",
        sessionId: "resident-session",
        agentName: "resident",
      },
    });
    const output = JSON.parse(response.output);
    const [job] = CronJobRegistry.list();

    expect(response.isError).toBeUndefined();
    expect(job).toMatchObject({
      id: output.jobId,
      agentName: "main",
      payload: "daily planning",
      schedule: "0 9 * * *",
      target: { kind: "resident" },
    });

    const fired = await CronAdapter.fire(job);
    received.unsubscribe();

    expect(fired.result.output).toBe("daily done");
    expect(received.events.at(-1)).toMatchObject({ surface: "cron", mode: "internal" });
  });

  it("returns an authority error when a worker tries to spawn work", async () => {
    const tool = inboundTool();

    const response = await tool.execute({
      id: "call-worker-spawn-denied",
      tool: "inbound_message",
      input: {
        target: { kind: "worker" },
        action: "spawn",
        payload: "create unmanaged work",
        wait: true,
        timeoutMs: 1_000,
        sessionId: "worker-session",
        agentName: "worker",
        runId: "worker-run-denied",
      },
    });

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.output)).toMatchObject({
      status: "error",
      error: "worker cannot spawn workers",
    });
    expect(dispatches).toHaveLength(0);
  });

  it("rejects inbound messages that exceed the depth limit", async () => {
    const received = collectBusEvents(IngressEvent.Received);
    const tool = inboundTool();

    const response = await tool.execute({
      id: "call-depth-limit",
      tool: "inbound_message",
      input: {
        target: { kind: "worker" },
        payload: "loop",
        depth: 10,
        sessionId: "resident-session",
        agentName: "resident",
      },
    });
    received.unsubscribe();

    expect(response.isError).toBe(true);
    expect(response.output).toContain("depth limit exceeded");
    expect(received.events).toHaveLength(0);
    expect(dispatches).toHaveLength(0);
  });

  it("times out wait:true calls when ingress never responds", async () => {
    const tool = createInboundMessageTool({
      submit: () => new Promise(() => undefined),
    });

    const response = await tool.execute({
      id: "call-timeout",
      tool: "inbound_message",
      input: {
        target: { kind: "resident" },
        payload: "please answer",
        wait: true,
        timeoutMs: 1,
        sessionId: "worker-session",
        agentName: "resident",
        runId: "worker-run-timeout",
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

  it("handles multiple concurrent inbound messages independently", async () => {
    const tool = inboundTool();

    const responses = await Promise.all(
      ["alpha", "beta", "gamma"].map((payload, index) =>
        tool.execute({
          id: `call-concurrent-${index}`,
          tool: "inbound_message",
          input: {
            target: { kind: "worker" },
            action: "spawn",
            payload,
            wait: true,
            timeoutMs: 1_000,
            sessionId: "resident-session",
            agentName: "resident",
            runId: `resident-run-${index}`,
          },
        }),
      ),
    );
    expect(responses.map((response) => response.isError)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(responses.map((response) => JSON.parse(response.output).output).sort()).toEqual([
      "worker:alpha",
      "worker:beta",
      "worker:gamma",
    ]);
    expect(dispatches.map((dispatch) => dispatch.prompt).sort()).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });
});

function inboundTool() {
  return createInboundMessageTool({ submit: dispatchSubmit });
}

async function dispatchSubmit(
  command: Parameters<InboundMessageDispatch["submit"]>[0],
  context: Parameters<InboundMessageDispatch["submit"]>[1],
): ReturnType<InboundMessageDispatch["submit"]> {
  const dispatchId = crypto.randomUUID();
  if (context.agentName === "worker" && command.action === "worker.spawn") {
    return { status: "failed", dispatchId, error: "worker cannot spawn workers" };
  }

  if (command.action === "resident.deliver") {
    return {
      status: "completed",
      dispatchId,
      output: testState.responseQueue.shift() ?? "resident:ok",
    };
  }

  if (command.action === "worker.send" || command.action === "worker.resume") {
    if (!command.target.sessionId) {
      return { status: "failed", dispatchId, error: "worker target sessionId is required" };
    }
    deliveries.push({
      sessionId: command.target.sessionId,
      prompt: command.payload,
      runId: undefined,
    });
    return {
      status: "completed",
      dispatchId,
      output: JSON.stringify({ delivered: true, sessionId: command.target.sessionId }),
    };
  }

  if (command.action === "schedule.create") {
    const jobId = CronJobRegistry.register({
      id: crypto.randomUUID(),
      agentName: command.target.agentName ?? context.agentName ?? "resident",
      payload: command.payload,
      schedule: context.compatibility.schedule ?? "",
      target: {
        kind: command.target.kind,
        ...(command.target.sessionId ? { sessionId: command.target.sessionId } : {}),
      },
      createdAt: Date.now(),
    });
    return { status: "scheduled", dispatchId, jobId, messageId: jobId };
  }

  dispatches.push({
    sessionId: command.target.sessionId ?? context.sessionId ?? crypto.randomUUID(),
    runId: crypto.randomUUID(),
    prompt: command.payload,
    target: command.target as Ingress.Target,
  });
  return { status: "completed", dispatchId, output: `worker:${command.payload}` };
}

function installResidentRuntime(): void {
  IngressEngine.setResidentRuntime(
    ResidentRuntime.create({
      runAgent: async (_config, input) => {
        testState.llmInputs.push(input);
        return { text: testState.responseQueue.shift() ?? "resident:ok", finishReason: "stop" };
      },
    }),
  );
}

function installCoordinator(): void {
  IngressEngine.setCoordinator({
    async dispatch(sessionId, request) {
      dispatches.push({
        sessionId,
        runId: request.runId,
        prompt: request.prompt,
      });
      return {
        runId: request.runId,
        sessionId,
        status: "succeeded" as const,
        output: `worker:${request.prompt}`,
        finishReason: "stop" as const,
      };
    },
    async deliverMessage(sessionId, prompt, runId) {
      deliveries.push({ sessionId, prompt, runId });
      return { accepted: true };
    },
  });
}

function createWorkerSession(title: string): Session.Info {
  return Session.create({
    title,
    model: { providerID: "test", modelID: "fixture" },
    workerMeta: { target: "worker", surface: "internal" },
  });
}

function clearCronJobs(): void {
  for (const job of CronJobRegistry.list()) {
    CronJobRegistry.remove(job.id);
  }
}

function collectBusEvents<T>(eventDef: { subscribe(listener: (event: T) => void): () => void }) {
  const events: T[] = [];
  const unsubscribe = Bus.subscribe(eventDef, (event) => {
    events.push(event);
  });
  return { events, unsubscribe };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
