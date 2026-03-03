import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import type { Sink, Tool } from "@openomni/protocol";
import { Session } from "@openomni/session";
import { BuiltinAgentRegistry } from "../../../src/legacy/agent/registry/registry";
import { IngressEngine } from "../../../src/legacy/ingress/engine";
import type {
  DeliveryAdapter,
  InboundEvent,
  RunRequest,
  RunResult,
} from "../../../src/legacy/ingress/interfaces";
import type { RunExecutor } from "../../../src/legacy/ingress/run-executor";
import {
  RunWorker,
  type OrchestratorRunInput,
} from "../../../src/legacy/worker/run/run-worker";
import { TaskManager } from "../../../src/legacy/task/manager";
import { TaskStorage } from "../../../src/legacy/task/storage";
import type { Task } from "../../../src/legacy/task/types";
import { Subagent, type SubagentContext } from "../../../src/legacy/tools/subagent";
import { randomUUID } from "crypto";

class TestRunExecutor implements RunExecutor {
  private llm?: OrchestratorRunInput["llm"];

  constructor(llm?: OrchestratorRunInput["llm"]) {
    this.llm = llm;
  }

  async execute(request: RunRequest): Promise<RunResult> {
    const sessionId = request.session.id;

    if (request.kind === "run_agent") {
      const task = TaskManager.create({
        title: `Ingress run: ${request.envelope.name}`,
        owner: {
          type: request.envelope.userId ? "user" : "agent",
          id: request.envelope.userId ?? "system",
        },
        triggers: [{ id: randomUUID(), type: "manual" }],
      });

      const signal = {
        triggerId: task.triggers[0]!.id,
        type: "manual" as const,
        context: { conversationSessionId: sessionId },
        occurredAt: Date.now(),
      };

      const triggerResult = await TaskManager.trigger(task.id, signal);
      if ("error" in triggerResult) {
        return {
          success: false,
          summary: "",
          error: `Failed to create run: ${triggerResult.error}`,
          sessionId,
          request,
        };
      }

      if (this.llm) {
        const result = await RunWorker.run(
          {
            taskId: task.id,
            runId: triggerResult.runId,
            maxRetries: 0,
            sessionMode: "persistent",
          },
          { llm: this.llm, input: {} },
        );

        return {
          success: result.success,
          summary: result.summary,
          error: result.error,
          runId: triggerResult.runId,
          sessionId,
          request,
        };
      }

      TaskManager.setRunStatus(triggerResult.runId, "done");
      return {
        success: true,
        summary: `Agent run completed for ${request.envelope.name}`,
        runId: triggerResult.runId,
        sessionId,
        request,
      };
    }

    return {
      success: false,
      summary: "",
      error: `Unsupported kind: ${request.kind}`,
      sessionId,
      request,
    };
  }
}

const RUN_STATUSES: Task.Run["status"][] = [
  "scheduled",
  "running",
  "blocked",
  "done",
  "failed",
  "cancelled",
];

function listAllRuns(): Task.Run[] {
  return TaskStorage.getAdapter().run.listByStatus(RUN_STATUSES);
}

function createTask(overrides: Partial<Task.CreateInput> = {}): Task.Info {
  return TaskManager.create({
    title: "Agent orchestration task",
    owner: { type: "user", id: "user-1" },
    triggers: [{ id: "manual-1", type: "manual" }],
    policy: { permission: "notify" },
    ...overrides,
  });
}

async function createRun(
  taskId: string,
  triggerId = "manual-1",
): Promise<string> {
  const result = await TaskManager.trigger(taskId, {
    triggerId,
    type: "manual",
    occurredAt: Date.now(),
  });

  if ("error" in result) {
    throw new Error(`Failed to create run: ${result.error}`);
  }

  return result.runId;
}

function emitAssistantText(
  sink: Sink,
  text: string,
  sessionID = "test-session",
): void {
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
      agent: "test-agent",
      path: {
        cwd: process.cwd(),
        root: process.cwd(),
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

function isToolResultArray(value: unknown): value is Tool.Result[] {
  if (!Array.isArray(value)) {
    return false;
  }

  return value.every((item) => {
    if (typeof item !== "object" || item === null) {
      return false;
    }

    if (!("id" in item) || !("toolCallId" in item) || !("output" in item)) {
      return false;
    }

    return (
      typeof item.id === "string" &&
      typeof item.toolCallId === "string" &&
      typeof item.output === "string"
    );
  });
}

describe("Agent orchestration e2e", () => {
  beforeEach(() => {
    TaskStorage.reset();
    Session.storage.clear();
    BuiltinAgentRegistry.clear();
    BuiltinAgentRegistry.initializeBuiltins();
    IngressEngine.reset();
  });

  it("spawns a child task+run through Subagent.execute and runs RunWorker.run", async () => {
    const runSpy = spyOn(RunWorker, "run");
    runSpy.mockClear();

    try {
      const beforeTaskCount = TaskStorage.getAdapter().task.list().length;
      const beforeRunCount = listAllRuns().length;

      const context: SubagentContext = {
        parentDepth: 0,
        llm: {
          run: async (_input, sink) => {
            emitAssistantText(sink, "Child subagent completed.");
            return { type: "stop" as const };
          },
        },
      };

      const result = await Subagent.execute(
        "subagent-call-1",
        {
          agentType: "explore",
          prompt: "inspect repository structure",
        },
        context,
      );

      expect(result.isError).toBe(false);
      expect(result.toolCallId).toBe("subagent-call-1");
      expect(result.output).toContain("Child subagent completed.");
      expect(runSpy).toHaveBeenCalledTimes(1);

      const config = runSpy.mock.calls[0]?.[0];
      expect(config?.currentDepth).toBe(1);

      const tasks = TaskStorage.getAdapter().task.list();
      const runs = listAllRuns();

      expect(tasks.length).toBe(beforeTaskCount + 1);
      expect(runs.length).toBe(beforeRunCount + 1);
      expect(tasks[0]?.title).toContain("Subagent: explore");
      expect(runs[0]?.status).toBe("done");
    } finally {
      runSpy.mockRestore();
    }
  });

  it("runs await_tool -> toolExecutor -> stop loop end-to-end", async () => {
    const task = createTask();
    const runId = await createRun(task.id);

    const llmInputs: Record<string, unknown>[] = [];
    const executedCalls: Tool.Call[] = [];

    const llm: OrchestratorRunInput["llm"] = {
      run: async (input, sink) => {
        llmInputs.push(input);
        const toolResults = isToolResultArray(input.toolResults)
          ? input.toolResults
          : [];

        if (toolResults.length === 0) {
          const call: Tool.Call = {
            id: "lookup-call-1",
            tool: "lookup_status",
            input: { query: "pipeline" },
          };

          sink.onToolCall(call);
          emitAssistantText(sink, "Calling lookup_status tool...");
          return { type: "await_tool" as const, toolCalls: [call] };
        }

        emitAssistantText(
          sink,
          `Tool loop finished with: ${toolResults[0].output}`,
        );
        return { type: "stop" as const };
      },
    };

    const toolExecutor: NonNullable<OrchestratorRunInput["toolExecutor"]> = {
      execute: async (calls) => {
        executedCalls.push(...calls);
        return calls.map((call) => ({
          id: `result-${call.id}`,
          toolCallId: call.id,
          output: "lookup:ok",
          isError: false,
        }));
      },
    };

    const result = await RunWorker.run(
      {
        taskId: task.id,
        runId,
        maxRetries: 0,
        sessionMode: "persistent",
      },
      {
        llm,
        input: { prompt: "tool loop test" },
        toolExecutor,
      },
    );

    expect(result.success).toBe(true);
    expect(result.summary).toContain("Tool loop finished with: lookup:ok");
    expect(executedCalls).toHaveLength(1);
    expect(llmInputs).toHaveLength(2);
    expect(TaskManager.getRun(runId)?.status).toBe("done");

    const secondInputToolResults = llmInputs[1]?.toolResults;
    expect(isToolResultArray(secondInputToolResults)).toBe(true);
    if (!isToolResultArray(secondInputToolResults)) {
      throw new Error("Expected tool results on second LLM turn");
    }
    expect(secondInputToolResults).toHaveLength(1);
    expect(secondInputToolResults[0]?.output).toBe("lookup:ok");
  });

  it("executes multi-level subagent chain depth 0 -> 1 -> 2", async () => {
    const runSpy = spyOn(RunWorker, "run");
    runSpy.mockClear();

    const seenPrompts: string[] = [];

    const llm: OrchestratorRunInput["llm"] = {
      run: async (input, sink) => {
        const prompt = typeof input.prompt === "string" ? input.prompt : "";
        seenPrompts.push(prompt);
        const toolResults = isToolResultArray(input.toolResults)
          ? input.toolResults
          : [];

        if (prompt === "spawn-depth-2" && toolResults.length === 0) {
          const subCall: Tool.Call = {
            id: "depth-call-1",
            tool: "subagent",
            input: {
              agentType: "explore",
              prompt: "depth-2-leaf",
            },
          };
          sink.onToolCall(subCall);
          emitAssistantText(sink, "Depth-1 delegating to depth-2.");
          return { type: "await_tool" as const, toolCalls: [subCall] };
        }

        if (prompt === "spawn-depth-2") {
          emitAssistantText(sink, "Depth-1 received depth-2 output.");
          return { type: "stop" as const };
        }

        emitAssistantText(sink, "Depth-2 leaf completed.");
        return { type: "stop" as const };
      },
    };

    const toolExecutor: NonNullable<OrchestratorRunInput["toolExecutor"]> = {
      execute: async (calls) => {
        const results: Tool.Result[] = [];

        for (const call of calls) {
          if (call.tool !== "subagent") {
            results.push({
              id: `result-${call.id}`,
              toolCallId: call.id,
              output: `Unsupported tool: ${call.tool}`,
              isError: true,
            });
            continue;
          }

          const nestedResult = await Subagent.execute(call.id, call.input, {
            parentDepth: 1,
            maxDepth: 5,
            llm,
            toolExecutor,
          });

          results.push(nestedResult);
        }

        return results;
      },
    };

    try {
      const result = await Subagent.execute(
        "depth-root",
        {
          agentType: "explore",
          prompt: "spawn-depth-2",
        },
        {
          parentDepth: 0,
          maxDepth: 5,
          llm,
          toolExecutor,
        },
      );

      expect(result.isError).toBe(false);
      expect(result.output).toContain("Depth-1 received depth-2 output.");

      const tasks = TaskStorage.getAdapter().task.list();
      const runs = listAllRuns();

      expect(tasks.length).toBe(2);
      expect(runs.length).toBe(2);
      expect(runs.every((run) => run.status === "done")).toBe(true);
      expect(seenPrompts).toContain("spawn-depth-2");
      expect(seenPrompts).toContain("depth-2-leaf");

      const observedDepths = runSpy.mock.calls
        .map((call) => call[0]?.currentDepth)
        .filter((depth): depth is number => typeof depth === "number");

      expect(observedDepths).toContain(1);
      expect(observedDepths).toContain(2);
    } finally {
      runSpy.mockRestore();
    }
  });

  it("processes ingress full pipeline: ingest -> resolve -> execute -> deliver", async () => {
    const delivered: RunResult[] = [];

    const delivery: DeliveryAdapter = {
      name: "capture",
      async deliver(result) {
        delivered.push(result);
      },
    };

    const llm: OrchestratorRunInput["llm"] = {
      run: async (_input, sink) => {
        emitAssistantText(sink, "Ingress run completed.", "ingress-session");
        return { type: "stop" as const };
      },
    };

    IngressEngine.configure({ executor: new TestRunExecutor(llm), delivery });

    const event: InboundEvent = {
      id: "ingress-event-1",
      surface: "tui",
      channel: "cli",
      workspace: "workspace-1",
      userId: "user-1",
      name: "message",
      payload: "run ingress pipeline",
      occurredAt: new Date().toISOString(),
    };

    const results = await IngressEngine.ingest(event);

    expect(results).toHaveLength(1);

    const result = results[0];
    if (!result) {
      throw new Error("Expected one ingress result");
    }

    expect(result.success).toBe(true);
    expect(result.request.kind).toBe("run_agent");
    expect(result.runId).toBeDefined();
    expect(result.sessionId).toBeDefined();
    expect(Session.get(result.sessionId)).toBeDefined();

    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.sessionId).toBe(result.sessionId);

    if (result.runId) {
      expect(TaskManager.getRun(result.runId)?.status).toBe("done");
    }
  });

  it("orchestrates main agent tool calls that spawn subagents", async () => {
    const mainTask = createTask({
      title: "Main orchestration task",
    });
    const mainRunId = await createRun(mainTask.id);

    let mainTurns = 0;
    let toolExecutorCalls = 0;

    const subagentLLM: OrchestratorRunInput["llm"] = {
      run: async (_input, sink) => {
        emitAssistantText(sink, "Subagent completed delegated work.");
        return { type: "stop" as const };
      },
    };

    const mainLLM: OrchestratorRunInput["llm"] = {
      run: async (input, sink) => {
        mainTurns += 1;
        const toolResults = isToolResultArray(input.toolResults)
          ? input.toolResults
          : [];

        if (toolResults.length === 0) {
          const subagentCall: Tool.Call = {
            id: "main-subagent-call",
            tool: "subagent",
            input: {
              agentType: "explore",
              prompt: "analyze module boundaries",
            },
          };

          sink.onToolCall(subagentCall);
          emitAssistantText(sink, "Main agent delegating to subagent.");
          return { type: "await_tool" as const, toolCalls: [subagentCall] };
        }

        emitAssistantText(
          sink,
          `Main agent received subagent output: ${toolResults[0].output}`,
        );
        return { type: "stop" as const };
      },
    };

    const toolExecutor: NonNullable<OrchestratorRunInput["toolExecutor"]> = {
      execute: async (calls) => {
        toolExecutorCalls += 1;

        const results: Tool.Result[] = [];
        for (const call of calls) {
          const subagentResult = await Subagent.execute(call.id, call.input, {
            parentDepth: 0,
            maxDepth: 5,
            llm: subagentLLM,
          });
          results.push(subagentResult);
        }

        return results;
      },
    };

    const result = await RunWorker.run(
      {
        taskId: mainTask.id,
        runId: mainRunId,
        maxRetries: 0,
        sessionMode: "persistent",
      },
      {
        llm: mainLLM,
        input: { goal: "delegate to subagent" },
        toolExecutor,
      },
    );

    expect(result.success).toBe(true);
    expect(result.summary).toContain("Main agent received subagent output:");
    expect(mainTurns).toBe(2);
    expect(toolExecutorCalls).toBe(1);
    expect(TaskManager.getRun(mainRunId)?.status).toBe("done");

    const allRuns = listAllRuns();
    expect(allRuns.length).toBe(2);
    expect(allRuns.filter((run) => run.taskId !== mainTask.id)).toHaveLength(1);
    expect(allRuns.every((run) => run.status === "done")).toBe(true);
  });
});
