import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { Sink } from "@openomni/protocol";
import { Session } from "@openomni/session";
import { BuiltinAgentRegistry } from "../../src/agent/registry/registry";
import { AgentMessenger } from "../../src/agent/communication";
import { TaskStorage } from "../../src/task/storage";
import { Dispatch, type DispatchReviewInput } from "../../src/tools/dispatch";
import { FileLock } from "../../src/execution/file-lock";
import { TaskManager } from "../../src/task/manager";

interface MockCall {
  taskId: string;
  prompt: string;
  sessionId: string;
  isHandoff: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractTaskId(prompt: string): string {
  const match = prompt.match(/Task ID:\s*([^\n]+)/);
  return match?.[1]?.trim() ?? "unknown";
}

function emitAssistantText(sink: Sink, sessionID: string, text: string): void {
  const messageID = crypto.randomUUID();

  sink.onMessage({
    info: {
      id: messageID,
      sessionID,
      role: "assistant",
      time: {
        created: Date.now(),
        completed: Date.now(),
      },
      parentID: crypto.randomUUID(),
      modelID: "test-model",
      providerID: "test-provider",
      agent: "dispatch-test",
      path: {
        cwd: "/",
        root: "/",
      },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    },
    parts: [
      {
        id: crypto.randomUUID(),
        sessionID,
        messageID,
        type: "text",
        text,
      },
    ],
  });
}

function createMockLLM(config?: {
  delays?: Record<string, number>;
  summaries?: Record<string, string>;
  defaultDelayMs?: number;
}) {
  const events: string[] = [];
  const calls: MockCall[] = [];
  let inFlight = 0;
  let maxConcurrent = 0;

  const delays = config?.delays ?? {};
  const summaries = config?.summaries ?? {};
  const defaultDelayMs = config?.defaultDelayMs ?? 10;

  return {
    events,
    calls,
    getMaxConcurrent() {
      return maxConcurrent;
    },
    llm: {
      run: async (input: Record<string, unknown>, sink: Sink) => {
        const prompt = String(input.prompt ?? "");
        const taskId = extractTaskId(prompt);
        const sessionId = String(input.sessionID ?? "unknown-session");
        const isHandoff = prompt.includes(
          "Create a handoff document for replacement agent.",
        );

        calls.push({ taskId, prompt, sessionId, isHandoff });

        const startLabel = isHandoff
          ? `start:handoff:${taskId}`
          : `start:${taskId}`;
        events.push(startLabel);

        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);

        const delayMs = isHandoff ? 1 : (delays[taskId] ?? defaultDelayMs);
        await sleep(delayMs);

        inFlight -= 1;

        const summary = isHandoff
          ? `handoff summary for ${taskId}`
          : (summaries[taskId] ?? `completed ${taskId}`);

        emitAssistantText(sink, sessionId, summary);

        const endLabel = isHandoff
          ? `stop:handoff:${taskId}`
          : `stop:${taskId}`;
        events.push(endLabel);

        return { type: "stop" as const };
      },
    },
  };
}

function parseToolOutput(output: string) {
  return JSON.parse(output) as {
    success: boolean;
    error?: string;
    completedTaskIds: string[];
    results: Array<{
      id: string;
      status: string;
      attempts: number;
      rejections: number;
      handoffs: number;
      sessionId: string;
      agentHistory: string[];
    }>;
  };
}

describe("Dispatch", () => {
  beforeEach(() => {
    TaskStorage.reset();
    Session.storage.clear();
    FileLock.clear();
    BuiltinAgentRegistry.clear();
    BuiltinAgentRegistry.initializeBuiltins();
  });

  afterEach(() => {
    FileLock.clear();
  });

  it("executes dependency graph waves with A,B parallel -> C -> D", async () => {
    const mock = createMockLLM({
      delays: {
        A: 40,
        B: 40,
        C: 5,
        D: 5,
      },
    });

    const result = await Dispatch.execute(
      "dispatch-call-1",
      {
        objective: "Build feature with dependency chain",
        tasks: [
          {
            id: "A",
            description: "Implement A",
            agentType: "implement",
            dependencies: [],
            fileScope: ["src/a.ts"],
          },
          {
            id: "B",
            description: "Implement B",
            agentType: "implement",
            dependencies: [],
            fileScope: ["src/b.ts"],
          },
          {
            id: "C",
            description: "Implement C",
            agentType: "implement",
            dependencies: ["A", "B"],
            fileScope: ["src/c.ts"],
          },
          {
            id: "D",
            description: "Implement D",
            agentType: "implement",
            dependencies: ["C"],
            fileScope: ["src/d.ts"],
          },
        ],
      },
      {
        llm: mock.llm,
        review: () => ({ decision: "accept" }),
      },
    );

    expect(result.isError).toBe(false);

    const output = parseToolOutput(result.output);
    expect(output.success).toBe(true);
    expect(output.completedTaskIds.sort()).toEqual(["A", "B", "C", "D"]);

    expect(mock.getMaxConcurrent()).toBeGreaterThanOrEqual(2);

    const startCIndex = mock.events.indexOf("start:C");
    const stopAIndex = mock.events.indexOf("stop:A");
    const stopBIndex = mock.events.indexOf("stop:B");

    expect(startCIndex).toBeGreaterThan(stopAIndex);
    expect(startCIndex).toBeGreaterThan(stopBIndex);
  });

  it("handles reject feedback retries and performs handoff after third rejection", async () => {
    const mock = createMockLLM({
      defaultDelayMs: 5,
      summaries: {
        T1: "work complete",
      },
    });

    let rejections = 0;
    const reviewCalls: DispatchReviewInput[] = [];
    const sendSpy = spyOn(AgentMessenger, "send");

    const result = await Dispatch.execute(
      "dispatch-call-2",
      {
        objective: "Complete retry-heavy task",
        tasks: [
          {
            id: "T1",
            description: "Task requiring multiple revisions",
            agentType: "implement",
            dependencies: [],
            fileScope: ["src/shared.ts"],
          },
        ],
      },
      {
        llm: mock.llm,
        review: (input) => {
          reviewCalls.push(input);
          if (rejections < 3) {
            rejections += 1;
            return {
              decision: "reject",
              feedback: `needs-fix-${rejections}`,
            };
          }
          return { decision: "accept" };
        },
      },
    );

    expect(result.isError).toBe(false);
    const output = parseToolOutput(result.output);
    expect(output.success).toBe(true);

    const taskResult = output.results.find((item) => item.id === "T1");
    expect(taskResult).toBeDefined();
    expect(taskResult?.handoffs).toBe(1);
    expect(taskResult?.rejections).toBe(3);
    expect(taskResult?.agentHistory.length).toBeGreaterThan(1);

    const executionCalls = mock.calls.filter((call) => !call.isHandoff);
    expect(executionCalls.length).toBeGreaterThanOrEqual(4);

    expect(executionCalls[1]?.prompt).toContain("needs-fix-1");
    expect(executionCalls[2]?.prompt).toContain("needs-fix-1");
    expect(executionCalls[2]?.prompt).toContain("needs-fix-2");
    expect(executionCalls[3]?.prompt).toContain("Handoff Document");

    const firstThreeSessions = executionCalls
      .slice(0, 3)
      .map((call) => call.sessionId);
    expect(new Set(firstThreeSessions).size).toBe(1);

    expect(sendSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(reviewCalls.length).toBeGreaterThanOrEqual(4);
  });

  it("prevents concurrent writes with in-process file lock", async () => {
    const mock = createMockLLM({
      delays: {
        L1: 35,
        L2: 35,
      },
    });

    const result = await Dispatch.execute(
      "dispatch-call-3",
      {
        objective: "Run tasks with shared file scope",
        tasks: [
          {
            id: "L1",
            description: "Write first change",
            agentType: "implement",
            dependencies: [],
            fileScope: ["src/shared.ts"],
          },
          {
            id: "L2",
            description: "Write second change",
            agentType: "implement",
            dependencies: [],
            fileScope: ["src/shared.ts"],
          },
        ],
      },
      {
        llm: mock.llm,
        review: () => ({ decision: "accept" }),
      },
    );

    expect(result.isError).toBe(false);

    const output = parseToolOutput(result.output);
    expect(output.success).toBe(true);
    expect(output.completedTaskIds.sort()).toEqual(["L1", "L2"]);
    expect(mock.getMaxConcurrent()).toBe(1);
  });

  it("enforces overall dispatch timeout", async () => {
    const mock = createMockLLM({
      delays: {
        LONG: 120,
      },
    });

    const cancelSpy = spyOn(TaskManager, "cancelRun");

    const result = await Dispatch.execute(
      "dispatch-call-4",
      {
        objective: "Timeout scenario",
        tasks: [
          {
            id: "LONG",
            description: "Long-running task",
            agentType: "implement",
            dependencies: [],
            fileScope: ["src/long.ts"],
          },
        ],
      },
      {
        llm: mock.llm,
        review: () => ({ decision: "accept" }),
        timeoutMs: 20,
      },
    );

    expect(result.isError).toBe(true);
    const output = parseToolOutput(result.output);
    expect(output.success).toBe(false);
    expect(output.error).toContain("timed out");
    expect(cancelSpy.mock.calls.length).toBeGreaterThan(0);

    await sleep(150);
  });

  it("aborts all running children when parent aborts", async () => {
    const controller = new AbortController();
    const mock = createMockLLM({
      delays: {
        ABORT_A: 120,
        ABORT_B: 120,
      },
    });

    const cancelSpy = spyOn(TaskManager, "cancelRun");

    const execution = Dispatch.execute(
      "dispatch-call-5",
      {
        objective: "Abort propagation scenario",
        tasks: [
          {
            id: "ABORT_A",
            description: "Long task A",
            agentType: "implement",
            dependencies: [],
            fileScope: ["src/abort-a.ts"],
          },
          {
            id: "ABORT_B",
            description: "Long task B",
            agentType: "implement",
            dependencies: [],
            fileScope: ["src/abort-b.ts"],
          },
        ],
      },
      {
        llm: mock.llm,
        review: () => ({ decision: "accept" }),
        abortSignal: controller.signal,
      },
    );

    setTimeout(() => controller.abort(), 20);

    const result = await execution;

    expect(result.isError).toBe(true);
    const output = parseToolOutput(result.output);
    expect(output.success).toBe(false);
    expect(output.error).toContain("aborted by parent");
    expect(cancelSpy.mock.calls.length).toBeGreaterThan(0);

    await sleep(150);
  });
});
