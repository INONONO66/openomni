import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import {
  RunWorker,
  OrchestratorConfig,
  OrchestratorRunInput,
} from "../../src/worker/run-worker";
import { TaskManager } from "../../src/task/manager";
import { Task } from "../../src/task/types";
import { TaskStorage } from "../../src/task/storage";
import { Session } from "@openomni/session";
import type { Sink } from "@openomni/protocol";
import { Observability } from "../../src/worker/observability";
import { AuditLog } from "../../src/worker/audit";
import { DeadLetterQueue } from "../../src/worker/dlq";
import { SummaryDelivery } from "../../src/worker/summary";

describe("RunWorker", () => {
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

      const result = await RunWorker.run(config, input);

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

      const result = await RunWorker.run(config, input);

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

      const result = await RunWorker.run(config, input);

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

      const result = await RunWorker.run(config, input);

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
            void llmInput;
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

      const result = await RunWorker.run(config, input);

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

      const result = await RunWorker.run(config, input);

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
            void llmInput;
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

      const result = await RunWorker.run(config, input);

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
            void llmInput;
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

      const result = await RunWorker.run(config, input);

      expect(result.success).toBe(true);

      const run = TaskManager.getRun(runId);
      const sessionKey = run?.sessionKey;

      if (sessionKey) {
        const session = Session.get(sessionKey);
        expect(session).toBeUndefined();
      }
    });

    it("emits observability events on successful run", async () => {
      const task = createTask();
      const runId = await createRun(task.id);

      const emitSpy = spyOn(Observability, "emitRunEvent");
      emitSpy.mockClear();

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
      };

      await RunWorker.run(config, input);

      const runEvents = emitSpy.mock.calls.filter((call) => call[0] === runId);
      expect(runEvents).toHaveLength(2);
      expect(runEvents[0][1]).toBe("started");
      expect(runEvents[1][1]).toBe("completed");
    });

    it("logs permission decision", async () => {
      const task = createTask();
      const runId = await createRun(task.id);

      const logSpy = spyOn(AuditLog, "logPermission");
      logSpy.mockClear();

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
      };

      await RunWorker.run(config, input);

      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls[0][0]).toBe(runId);
    });

    it("logs run outcome on success", async () => {
      const task = createTask();
      const runId = await createRun(task.id);

      const logSpy = spyOn(AuditLog, "logRunOutcome");
      logSpy.mockClear();

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
      };

      await RunWorker.run(config, input);

      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls[0][0]).toBe(runId);
      expect(logSpy.mock.calls[0][1]).toHaveProperty("success", true);
    });

    it("persists summary on successful run", async () => {
      const task = createTask();
      const runId = await createRun(task.id);

      const persistSpy = spyOn(SummaryDelivery, "persist");
      persistSpy.mockClear();

      const config: OrchestratorConfig = {
        taskId: task.id,
        runId,
        maxRetries: 0,
      };

      const input: OrchestratorRunInput = {
        llm: {
          run: async (llmInput, sink: Sink) => {
            void llmInput;
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
                  text: "Summary text",
                },
              ],
            });
            return { type: "stop" as const };
          },
        },
        input: {},
      };

      await RunWorker.run(config, input);

      expect(persistSpy).toHaveBeenCalledTimes(1);
      expect(persistSpy.mock.calls[0][0]).toBe(runId);
      expect(persistSpy.mock.calls[0][1]).toContain("Summary text");
    });

    it("adds to DLQ when retries exhausted", async () => {
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

      const dlqSpy = spyOn(DeadLetterQueue, "add");
      dlqSpy.mockClear();

      const config: OrchestratorConfig = {
        taskId: task.id,
        runId,
        maxRetries: 1,
      };

      const input: OrchestratorRunInput = {
        llm: {
          run: async () => {
            throw new Error("Persistent error");
          },
        },
        input: {},
      };

      await RunWorker.run(config, input);

      expect(dlqSpy).toHaveBeenCalledTimes(1);
      expect(dlqSpy.mock.calls[0][0]).toHaveProperty("type", "run");
      expect(dlqSpy.mock.calls[0][0]).toHaveProperty("reason");
      expect(dlqSpy.mock.calls[0][0].payload).toHaveProperty("runId", runId);
      expect(dlqSpy.mock.calls[0][0].payload).toHaveProperty("taskId", task.id);
    });

    describe("session modes", () => {
      it("ephemeral mode (default) creates and deletes session", async () => {
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
        };

        const result = await RunWorker.run(config, input);

        expect(result.success).toBe(true);

        const run = TaskManager.getRun(runId);
        const sessionKey = run?.sessionKey;
        if (sessionKey) {
          const session = Session.get(sessionKey);
          expect(session).toBeUndefined();
        }
      });

      it("ephemeral mode explicitly set creates and deletes session", async () => {
        const task = createTask();
        const runId = await createRun(task.id);

        const config: OrchestratorConfig = {
          taskId: task.id,
          runId,
          maxRetries: 0,
          sessionMode: "ephemeral",
        };

        const input: OrchestratorRunInput = {
          llm: {
            run: async () => ({ type: "stop" as const }),
          },
          input: {},
        };

        const result = await RunWorker.run(config, input);

        expect(result.success).toBe(true);

        const run = TaskManager.getRun(runId);
        const sessionKey = run?.sessionKey;
        if (sessionKey) {
          const session = Session.get(sessionKey);
          expect(session).toBeUndefined();
        }
      });

      it("persistent mode creates session but does NOT delete it", async () => {
        const task = createTask();
        const runId = await createRun(task.id);

        const config: OrchestratorConfig = {
          taskId: task.id,
          runId,
          maxRetries: 0,
          sessionMode: "persistent",
        };

        const input: OrchestratorRunInput = {
          llm: {
            run: async () => ({ type: "stop" as const }),
          },
          input: {},
        };

        const result = await RunWorker.run(config, input);

        expect(result.success).toBe(true);

        const run = TaskManager.getRun(runId);
        const sessionKey = run?.sessionKey;
        if (sessionKey) {
          const session = Session.get(sessionKey);
          expect(session).toBeDefined();
        }
      });

      it("persistent mode preserves session on error", async () => {
        const task = createTask();
        const runId = await createRun(task.id);

        const config: OrchestratorConfig = {
          taskId: task.id,
          runId,
          maxRetries: 0,
          sessionMode: "persistent",
        };

        const input: OrchestratorRunInput = {
          llm: {
            run: async () => {
              throw new Error("Test error");
            },
          },
          input: {},
        };

        const result = await RunWorker.run(config, input);

        expect(result.success).toBe(false);

        const run = TaskManager.getRun(runId);
        const sessionKey = run?.sessionKey;
        if (sessionKey) {
          const session = Session.get(sessionKey);
          expect(session).toBeDefined();
        }
      });

      it("reuse mode uses provided sessionId", async () => {
        const task = createTask();
        const runId = await createRun(task.id);

        const existingSessionId = "reuse-session-123";
        const now = Date.now();
        Session.storage.set(existingSessionId, {
          id: existingSessionId,
          title: "Existing session",
          model: { providerID: "test", modelID: "test" },
          time: { created: now, updated: now },
        });

        const config: OrchestratorConfig = {
          taskId: task.id,
          runId,
          maxRetries: 0,
          sessionMode: "reuse",
          sessionId: existingSessionId,
        };

        let capturedSessionID: string | undefined;

        const input: OrchestratorRunInput = {
          llm: {
            run: async (llmInput) => {
              capturedSessionID = llmInput.sessionID as string;
              return { type: "stop" as const };
            },
          },
          input: {},
        };

        const result = await RunWorker.run(config, input);

        expect(result.success).toBe(true);
        expect(capturedSessionID).toBe(existingSessionId);

        const session = Session.get(existingSessionId);
        expect(session).toBeDefined();
      });

      it("reuse mode returns error when sessionId is missing", async () => {
        const task = createTask();
        const runId = await createRun(task.id);

        const config: OrchestratorConfig = {
          taskId: task.id,
          runId,
          maxRetries: 0,
          sessionMode: "reuse",
        };

        const input: OrchestratorRunInput = {
          llm: {
            run: async () => ({ type: "stop" as const }),
          },
          input: {},
        };

        const result = await RunWorker.run(config, input);

        expect(result.success).toBe(false);
        expect(result.error).toContain("sessionId is required");
      });

      it("reuse mode returns error when session not found", async () => {
        const task = createTask();
        const runId = await createRun(task.id);

        const config: OrchestratorConfig = {
          taskId: task.id,
          runId,
          maxRetries: 0,
          sessionMode: "reuse",
          sessionId: "non-existent-session",
        };

        const input: OrchestratorRunInput = {
          llm: {
            run: async () => ({ type: "stop" as const }),
          },
          input: {},
        };

        const result = await RunWorker.run(config, input);

        expect(result.success).toBe(false);
        expect(result.error).toContain("Session not found for reuse");
      });
    });

    describe("depth limit", () => {
      it("refuses when currentDepth >= maxSubagentDepth", async () => {
        const task = createTask();
        const runId = await createRun(task.id);

        const config: OrchestratorConfig = {
          taskId: task.id,
          runId,
          maxRetries: 0,
          maxSubagentDepth: 3,
          currentDepth: 3,
        };

        const input: OrchestratorRunInput = {
          llm: {
            run: async () => ({ type: "stop" as const }),
          },
          input: {},
        };

        const result = await RunWorker.run(config, input);

        expect(result.success).toBe(false);
        expect(result.error).toContain("Subagent depth limit reached");
        expect(result.error).toContain("3 >= 3");
      });

      it("refuses when currentDepth exceeds maxSubagentDepth", async () => {
        const task = createTask();
        const runId = await createRun(task.id);

        const config: OrchestratorConfig = {
          taskId: task.id,
          runId,
          maxRetries: 0,
          maxSubagentDepth: 2,
          currentDepth: 5,
        };

        const input: OrchestratorRunInput = {
          llm: {
            run: async () => ({ type: "stop" as const }),
          },
          input: {},
        };

        const result = await RunWorker.run(config, input);

        expect(result.success).toBe(false);
        expect(result.error).toContain("Subagent depth limit reached");
      });

      it("allows when currentDepth < maxSubagentDepth", async () => {
        const task = createTask();
        const runId = await createRun(task.id);

        const config: OrchestratorConfig = {
          taskId: task.id,
          runId,
          maxRetries: 0,
          maxSubagentDepth: 3,
          currentDepth: 2,
        };

        const input: OrchestratorRunInput = {
          llm: {
            run: async () => ({ type: "stop" as const }),
          },
          input: {},
        };

        const result = await RunWorker.run(config, input);

        expect(result.success).toBe(true);
      });

      it("uses default maxSubagentDepth of 3 when not specified", async () => {
        const task = createTask();
        const runId = await createRun(task.id);

        const config: OrchestratorConfig = {
          taskId: task.id,
          runId,
          maxRetries: 0,
          currentDepth: 3,
        };

        const input: OrchestratorRunInput = {
          llm: {
            run: async () => ({ type: "stop" as const }),
          },
          input: {},
        };

        const result = await RunWorker.run(config, input);

        expect(result.success).toBe(false);
        expect(result.error).toContain("Subagent depth limit reached");
        expect(result.error).toContain("3 >= 3");
      });

      it("defaults currentDepth to 0 when not specified (allows execution)", async () => {
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
        };

        const result = await RunWorker.run(config, input);

        expect(result.success).toBe(true);
      });
    });

    it("emits failed event and logs outcome on failure", async () => {
      const task = createTask();
      const runId = await createRun(task.id);

      const emitSpy = spyOn(Observability, "emitRunEvent");
      emitSpy.mockClear();
      const logSpy = spyOn(AuditLog, "logRunOutcome");
      logSpy.mockClear();

      const config: OrchestratorConfig = {
        taskId: task.id,
        runId,
        maxRetries: 0,
      };

      const input: OrchestratorRunInput = {
        llm: {
          run: async () => {
            throw new Error("Test error");
          },
        },
        input: {},
      };

      await RunWorker.run(config, input);

      const runEvents = emitSpy.mock.calls.filter((call) => call[0] === runId);
      expect(runEvents).toHaveLength(2);
      expect(runEvents[1][1]).toBe("failed");
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls[0][1]).toHaveProperty("success", false);
    });
  });
});
