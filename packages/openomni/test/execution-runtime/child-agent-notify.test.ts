import { describe, expect, test } from "bun:test";
import type { AgentResult } from "@openomni/agent";
import type { Model, Tool } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import {
  ChildAgentEvents,
  InjectionQueue,
  createChildAgentRuntime,
  createChildAgentTool,
} from "../../src/execution-runtime";
import { createTestLlmEnvironment } from "../helpers/llm-environment.ts";

const model: Model.Ref = { provider: "test", id: "fixture" };
const { environment, modelCatalog } = createTestLlmEnvironment();

const successfulResult: AgentResult = {
  text: "background result",
  steps: [],
  usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
  finishReason: "stop",
};

function makeCall(input: Record<string, unknown>): Tool.Call {
  return { id: crypto.randomUUID(), tool: "child_agent", input };
}

async function flushBus(): Promise<void> {
  await new Promise((resolve) => queueMicrotask(resolve));
}

describe("child_agent completion notification", () => {
  test("publishes lifecycle events and queues parent run injection when requested", async () => {
    Bus.reset();
    const events: string[] = [];
    const payloads: unknown[] = [];
    const unsubscribe = Bus.observe((event, payload) => {
      events.push(event.name);
      payloads.push(payload);
    });
    const injectionQueue = InjectionQueue.create();
    const runtime = createChildAgentRuntime({
      model,
      environment,
      modelCatalog,
      parentMessages: [],
      parentTools: [],
      traceContext: { traceId: "trace-1", sessionId: "session-1", runId: "parent-run" },
      injectionQueue,
      createAgent: () => ({ run: async () => successfulResult }),
    });
    const tool = createChildAgentTool(runtime);

    try {
      const spawn = await tool.execute(
        makeCall({ action: "spawn", prompt: "background check", notifyOnComplete: true }),
      );
      const childId = JSON.parse(spawn.output).childId;
      await tool.execute(makeCall({ action: "await", ids: [childId] }));
      await flushBus();

      expect(events).toContain(ChildAgentEvents.Started.name);
      expect(events).toContain(ChildAgentEvents.Completed.name);
      expect(payloads).toContainEqual(
        expect.objectContaining({
          traceId: "trace-1",
          sessionId: "session-1",
          runId: childId,
          parentRunId: "parent-run",
        }),
      );
      expect(injectionQueue.drain("parent-run")).toEqual([
        expect.objectContaining({
          output: expect.stringContaining("background result"),
          injectToHistory: true,
        }),
      ]);
    } finally {
      unsubscribe();
      Bus.reset();
    }
  });

  test("does not inject raw child failure text into parent history", async () => {
    Bus.reset();
    const events: string[] = [];
    const unsubscribe = Bus.observe((event) => events.push(event.name));
    const injectionQueue = InjectionQueue.create();
    const runtime = createChildAgentRuntime({
      model,
      environment,
      modelCatalog,
      parentMessages: [],
      parentTools: [],
      traceContext: { traceId: "trace-1", sessionId: "session-1", runId: "parent-run" },
      injectionQueue,
      createAgent: () => ({
        run: async () => {
          throw new Error("secret-provider-token");
        },
      }),
    });
    const tool = createChildAgentTool(runtime);

    try {
      const spawn = await tool.execute(
        makeCall({ action: "spawn", prompt: "background check", notifyOnComplete: true }),
      );
      const childId = JSON.parse(spawn.output).childId;
      await tool.execute(makeCall({ action: "await", ids: [childId] }));

      const [queued] = injectionQueue.drain("parent-run");
      expect(queued?.output).toContain("status failed");
      expect(queued?.output).not.toContain("secret-provider-token");
      await flushBus();
      expect(events).toContain(ChildAgentEvents.Failed.name);
    } finally {
      unsubscribe();
      Bus.reset();
    }
  });

  test("publishes cancelled event when parent signal aborts a child", async () => {
    Bus.reset();
    const events: string[] = [];
    const unsubscribe = Bus.observe((event) => events.push(event.name));
    const controller = new AbortController();
    const runtime = createChildAgentRuntime({
      model,
      environment,
      modelCatalog,
      parentMessages: [],
      parentTools: [],
      traceContext: { traceId: "trace-1", sessionId: "session-1", runId: "parent-run" },
      parentSignal: controller.signal,
      createAgent: () => ({
        run: async () => await new Promise<AgentResult>(() => undefined),
      }),
    });
    const tool = createChildAgentTool(runtime);

    try {
      await tool.execute(makeCall({ action: "spawn", prompt: "long running" }));
      controller.abort();
      await flushBus();

      expect(events).toContain(ChildAgentEvents.Cancelled.name);
    } finally {
      unsubscribe();
      Bus.reset();
    }
  });
});
