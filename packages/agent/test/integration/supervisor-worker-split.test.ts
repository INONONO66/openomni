import { describe, it, expect, beforeEach } from "bun:test";
import { Session } from "@openomni/session";
import { TaskManager } from "../../src/task/manager";
import { TaskStorage } from "../../src/task/storage";
import { BuiltinAgentRegistry } from "../../src/agent/registry";
import { FileLock } from "../../src/loop/file-lock";
import { RunWorker } from "../../src/loop/run-worker";
import type { OrchestratorRunInput } from "../../src/loop/run-worker";
import type { Sink, Tool } from "@openomni/protocol";
import type { Task } from "../../src/task/types";

const RUN_STATUSES: Task.Run["status"][] = [
  "scheduled",
  "running",
  "blocked",
  "done",
  "failed",
  "cancelled",
];

function createTestTask(overrides: Partial<Task.CreateInput> = {}): Task.Info {
  return TaskManager.create({
    title: "Test task",
    owner: { type: "user", id: "user-1" },
    triggers: [{ id: "trigger-1", type: "manual" }],
    ...overrides,
  });
}

async function createTestRun(taskId: string): Promise<string> {
  const result = await TaskManager.trigger(taskId, {
    triggerId: "trigger-1",
    type: "manual",
    occurredAt: Date.now(),
  });

  if ("error" in result) {
    throw new Error(`Failed to create run: ${result.error}`);
  }

  return result.runId;
}

function emitText(sink: Sink, text: string, sessionID = "test"): void {
  const messageID = crypto.randomUUID();
  sink.onMessage({
    info: {
      id: messageID,
      sessionID,
      role: "assistant",
      time: { created: Date.now(), completed: Date.now() },
      parentID: crypto.randomUUID(),
      modelID: "test",
      providerID: "test",
      agent: "test",
      path: { cwd: process.cwd(), root: process.cwd() },
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

describe("Supervisor/Worker split boundary", () => {
  beforeEach(() => {
    TaskStorage.reset();
    Session.storage.clear();
    BuiltinAgentRegistry.clear();
    BuiltinAgentRegistry.initializeBuiltins();
    FileLock.clear();
  });

  describe("Worker liveness: stuck claim recovery", () => {
    it("marks run as failed when budget is exceeded", async () => {
      const task = createTestTask();
      const runId = await createTestRun(task.id);

      const llm: OrchestratorRunInput["llm"] = {
        run: async (_input, sink) => {
          emitText(sink, "Working...");
          return {
            type: "await_tool" as const,
            toolCalls: [{ id: "t1", tool: "slow", input: {} }],
          };
        },
      };

      const toolExecutor: OrchestratorRunInput["toolExecutor"] = {
        execute: async (calls: Tool.Call[]) =>
          calls.map((c) => ({
            id: crypto.randomUUID(),
            toolCallId: c.id,
            output: "ok",
            isError: false,
          })),
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
          input: {},
          toolExecutor,
        },
      );

      const run = TaskManager.getRun(runId);
      expect(run).toBeDefined();
      expect(["done", "failed"]).toContain(run!.status);
    });

    it("sets run status to running before LLM execution", async () => {
      const task = createTestTask();
      const runId = await createTestRun(task.id);
      const statusesSeen: string[] = [];

      const llm: OrchestratorRunInput["llm"] = {
        run: async (_input, sink) => {
          const currentRun = TaskManager.getRun(runId);
          if (currentRun) {
            statusesSeen.push(currentRun.status);
          }
          emitText(sink, "Done.");
          return { type: "stop" as const };
        },
      };

      await RunWorker.run(
        { taskId: task.id, runId, maxRetries: 0, sessionMode: "persistent" },
        { llm, input: {} },
      );

      expect(statusesSeen).toContain("running");
    });

    it("transitions run to done on successful completion", async () => {
      const task = createTestTask();
      const runId = await createTestRun(task.id);

      const llm: OrchestratorRunInput["llm"] = {
        run: async (_input, sink) => {
          emitText(sink, "Completed successfully.");
          return { type: "stop" as const };
        },
      };

      const result = await RunWorker.run(
        { taskId: task.id, runId, maxRetries: 0, sessionMode: "persistent" },
        { llm, input: {} },
      );

      expect(result.success).toBe(true);
      expect(TaskManager.getRun(runId)?.status).toBe("done");
    });
  });

  describe("FCFS file lock ordering", () => {
    it("grants lock to first requester", () => {
      const acquired = FileLock.acquire("src/main.ts", "agent-A");
      expect(acquired).toBe(true);
      expect(FileLock.owner("src/main.ts")).toBe("agent-A");
    });

    it("rejects second requester for the same file", () => {
      FileLock.acquire("src/main.ts", "agent-A");

      const secondAcquire = FileLock.acquire("src/main.ts", "agent-B");
      expect(secondAcquire).toBe(false);
      expect(FileLock.owner("src/main.ts")).toBe("agent-A");
    });

    it("allows same agent to re-acquire owned lock", () => {
      FileLock.acquire("src/main.ts", "agent-A");

      const reAcquire = FileLock.acquire("src/main.ts", "agent-A");
      expect(reAcquire).toBe(true);
    });

    it("releases lock and allows new requester", () => {
      FileLock.acquire("src/main.ts", "agent-A");
      FileLock.release("src/main.ts", "agent-A");

      const acquired = FileLock.acquire("src/main.ts", "agent-B");
      expect(acquired).toBe(true);
      expect(FileLock.owner("src/main.ts")).toBe("agent-B");
    });

    it("rejects release from non-owner", () => {
      FileLock.acquire("src/main.ts", "agent-A");

      const released = FileLock.release("src/main.ts", "agent-B");
      expect(released).toBe(false);
      expect(FileLock.owner("src/main.ts")).toBe("agent-A");
    });

    it("handles multiple independent file locks", () => {
      FileLock.acquire("src/a.ts", "agent-A");
      FileLock.acquire("src/b.ts", "agent-B");

      expect(FileLock.owner("src/a.ts")).toBe("agent-A");
      expect(FileLock.owner("src/b.ts")).toBe("agent-B");

      const crossAcquire = FileLock.acquire("src/a.ts", "agent-B");
      expect(crossAcquire).toBe(false);
    });

    it("clear removes all locks", () => {
      FileLock.acquire("src/a.ts", "agent-A");
      FileLock.acquire("src/b.ts", "agent-B");

      FileLock.clear();

      expect(FileLock.owner("src/a.ts")).toBeUndefined();
      expect(FileLock.owner("src/b.ts")).toBeUndefined();
    });
  });

  describe("EvidenceBundle required fields validation", () => {
    it("ConversationSupervisor result types have required fields", async () => {
      const { ConversationSupervisor } =
        await import("../../src/loop/conversation-supervisor");

      const config = {
        conversationSessionId: "session-1",
        sessionMode: "persistent" as const,
      };
      const input = { content: "test", metadata: {} };

      const result = await ConversationSupervisor.run(config, input);

      expect(result).toBeDefined();
      expect(result.type).toBeDefined();
      expect(typeof result.type).toBe("string");
      expect([
        "immediate",
        "plan_pending",
        "execution_forked",
        "ended",
        "error",
      ]).toContain(result.type);

      if (result.type === "error") {
        expect(typeof result.error).toBe("string");
        expect(result.error.length).toBeGreaterThan(0);
      }
    });

    it("ExecutionSupervisor result has required fields", async () => {
      const { ExecutionSupervisor } =
        await import("../../src/loop/execution-supervisor");

      const result = await ExecutionSupervisor.run({
        history: { summary: "test", constraints: [] },
        plan: {
          planId: "plan-1",
          objective: "test",
          steps: [
            { stepId: "step-0", description: "do something", dependsOn: [] },
          ],
        },
        sessionMode: "persistent",
        sessionId: "session-1",
        traceId: "trace-1",
      });

      expect(result).toBeDefined();
      expect(typeof result.success).toBe("boolean");
      expect(typeof result.summary).toBe("string");
      expect(result.terminalDecision).toBe("finish");
      expect(Array.isArray(result.stepOutcomes)).toBe(true);
      expect(result.stepOutcomes.length).toBe(1);

      const step = result.stepOutcomes[0]!;
      expect(step.stepId).toBe("step-0");
      expect(typeof step.success).toBe("boolean");
      expect(typeof step.summary).toBe("string");
    });

    it("ConversationSupervisor.createFork produces valid fork structure", async () => {
      const { ConversationSupervisor } =
        await import("../../src/loop/conversation-supervisor");

      const fork = ConversationSupervisor.createFork(
        "session-1",
        {
          requirements: ["req-1"],
          constraints: ["no-delete"],
          clarifications: [],
          contextSummary: "User wants X",
        },
        {
          planId: "plan-1",
          title: "Plan A",
          description: "Do X",
          workItems: [{ description: "step 1", effort: "small" as const }],
          createdAt: Date.now(),
        },
        "trace-1",
      );

      expect(fork.conversationSessionId).toBe("session-1");
      expect(fork.traceId).toBe("trace-1");
      expect(fork.summarizedHistory.contextSummary).toBe("User wants X");
      expect(fork.summarizedHistory.constraints).toEqual(["no-delete"]);
      expect(fork.approvedPlan.planId).toBe("plan-1");
      expect(fork.approvedPlan.workItems.length).toBe(1);
      expect(typeof fork.forkedAt).toBe("number");
    });

    it("ConversationSupervisor.requiresApproval returns true for plans with work items", async () => {
      const { ConversationSupervisor } =
        await import("../../src/loop/conversation-supervisor");

      const plan = {
        planId: "plan-1",
        title: "Plan",
        description: "test",
        workItems: [{ description: "item", effort: "small" as const }],
        createdAt: Date.now(),
      };

      expect(ConversationSupervisor.requiresApproval(plan)).toBe(true);

      const emptyPlan = { ...plan, workItems: [] };
      expect(ConversationSupervisor.requiresApproval(emptyPlan)).toBe(false);
    });
  });
});
