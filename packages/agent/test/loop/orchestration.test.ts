import { describe, it, expect, beforeEach } from "bun:test";
import {
  Orchestrator,
  OrchestratorConfig,
  OrchestratorRunInput,
} from "../../src/loop/orchestration";
import { TaskManager } from "../../src/task/manager";
import { Task } from "../../src/task/types";
import { TaskStorage } from "../../src/task/storage";
import { Session } from "@openomni/session";
import type { Sink } from "@openomni/protocol";

describe("Orchestrator", () => {
  beforeEach(() => {
    TaskStorage.reset();
    Session.storage.clear();
  });

  function createTask(overrides: Partial<Task.CreateInput> = {}): Task.Info {
    return TaskManager.create({
      title: "Test Task",
      owner: { type: "user", id: "user-1" },
      triggers: [{ id: "manual-1", type: "manual" }],
      ...overrides,
    });
  }

  async function createRun(taskId: string): Promise<string> {
    const result = await TaskManager.trigger(taskId, {
      triggerId: "manual-1",
      type: "manual",
      occurredAt: Date.now(),
    });
    if ("runId" in result) {
      return result.runId;
    }
    throw new Error(`Failed to create run: ${result.error}`);
  }

  describe("run", () => {
    it("returns error when task not found", async () => {
      const config: OrchestratorConfig = {
        taskId: "non-existent-task",
        runId: "non-existent-run",
        maxRetries: 0,
      };

      const input: OrchestratorRunInput = {
        llm: {
          run: async () => ({ type: "stop" as const }),
        },
        input: {},
      };

      const result = await Orchestrator.run(config, input);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Task not found");
    });

    it("returns error when run not found", async () => {
      const task = createTask();

      const config: OrchestratorConfig = {
        taskId: task.id,
        runId: "non-existent-run",
        maxRetries: 0,
      };

      const input: OrchestratorRunInput = {
        llm: {
          run: async () => ({ type: "stop" as const }),
        },
        input: {},
      };

      const result = await Orchestrator.run(config, input);

      expect(result.success).toBe(false);
      expect(result.error).toContain("TaskRun not found");
    });

    it("run respects concurrency gate (drop mode)", async () => {
      const task = createTask({
        policy: {
          concurrency: { maxRunning: 1, mode: "drop" },
        },
      });

      const runId1 = await createRun(task.id);
      const runId2 = await createRun(task.id);

      TaskManager.setRunStatus(runId1, "running");

      const config: OrchestratorConfig = {
        taskId: task.id,
        runId: runId2,
        maxRetries: 0,
      };

      const input: OrchestratorRunInput = {
        llm: {
          run: async () => ({ type: "stop" as const }),
        },
        input: {},
      };

      const result = await Orchestrator.run(config, input);

      expect(result.success).toBe(false);
      expect(result.error).toContain("dropped by concurrency policy");
    });

    it("run respects permission gate (deny)", async () => {
      const task = createTask();

      const runId = await createRun(task.id);

      const config: OrchestratorConfig = {
        taskId: task.id,
        runId,
        maxRetries: 0,
      };

      const input: OrchestratorRunInput = {
        llm: {
          run: async () => ({ type: "stop" as const }),
        },
        input: {},
        permission: {
          systemDefault: "deny",
        },
      };

      const result = await Orchestrator.run(config, input);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Selected from system default");
    });

    it("run handles successful completion (outcome type: stop)", async () => {
      const task = createTask();
      const runId = await createRun(task.id);

      const config: OrchestratorConfig = {
        taskId: task.id,
        runId,
        maxRetries: 0,
      };

      let sinkCalled = false;

      const input: OrchestratorRunInput = {
        llm: {
          run: async (llmInput, sink: Sink) => {
            sinkCalled = true;
            sink.onSnapshot({
              id: "snap-1",
              sessionID: "session-1",
              timestamp: Date.now(),
              state: {},
            });
            return { type: "stop" as const };
          },
        },
        input: { test: "data" },
      };

      const result = await Orchestrator.run(config, input);

      expect(result.success).toBe(true);
      expect(sinkCalled).toBe(true);
      expect(result.error).toBe("");

      const run = TaskManager.getRun(runId);
      expect(run?.status).toBe("done");
    });

    it("run handles retry on error", async () => {
      const task = createTask({
        policy: {
          retry: {
            maxAttempts: 2,
            backoffMs: { initial: 10, multiplier: 1, max: 10 },
            retryOn: ["transient_error"],
          },
        },
      });

      const runId = await createRun(task.id);

      let callCount = 0;

      const config: OrchestratorConfig = {
        taskId: task.id,
        runId,
        maxRetries: 1,
      };

      const input: OrchestratorRunInput = {
        llm: {
          run: async () => {
            callCount++;
            if (callCount === 1) {
              throw new Error("Transient error");
            }
            return { type: "stop" as const };
          },
        },
        input: {},
      };

      const result = await Orchestrator.run(config, input);

      expect(callCount).toBe(2);
      expect(result.success).toBe(true);
    });

    it("run extracts summary from session messages", async () => {
      const task = createTask();
      const runId = await createRun(task.id);

      const config: OrchestratorConfig = {
        taskId: task.id,
        runId,
        maxRetries: 0,
      };

      const input: OrchestratorRunInput = {
        llm: {
          run: async (llmInput, sink: Sink) => {
            sink.onMessage({
              info: {
                id: "msg-1",
                sessionID: "session-1",
                role: "assistant",
                time: {
                  created: Date.now(),
                  completed: Date.now(),
                },
                parentID: "parent-1",
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
                  id: "part-1",
                  sessionID: "session-1",
                  messageID: "msg-1",
                  type: "text",
                  text: "Task completed successfully",
                },
              ],
            });
            return { type: "stop" as const };
          },
        },
        input: {},
      };

      const result = await Orchestrator.run(config, input);

      expect(result.success).toBe(true);
      expect(result.summary).toContain("Task completed successfully");
    });

    it("run cleans up session after completion", async () => {
      const task = createTask();
      const runId = await createRun(task.id);

      const config: OrchestratorConfig = {
        taskId: task.id,
        runId,
        maxRetries: 0,
      };

      const input: OrchestratorRunInput = {
        llm: {
          run: async (llmInput, sink: Sink) => {
            sink.onSnapshot({
              id: "snap-1",
              sessionID: "session-1",
              timestamp: Date.now(),
              state: {},
            });
            return { type: "stop" as const };
          },
        },
        input: {},
      };

      const result = await Orchestrator.run(config, input);

      expect(result.success).toBe(true);

      const run = TaskManager.getRun(runId);
      const sessionKey = run?.sessionKey;

      if (sessionKey) {
        const session = Session.get(sessionKey);
        expect(session).toBeUndefined();
      }
    });
  });
});
