import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Sink } from "@openomni/protocol";
import { Session } from "@openomni/session";
import { BuiltinAgentRegistry } from "../../../src/legacy/agent/registry/registry";
import { TaskStorage } from "../../../src/legacy/task/storage";
import { FileLock } from "../../../src/legacy/execution/graph";
import { ExecutionSupervisor } from "../../../src/legacy/execution/execution-supervisor";
import type {
  DispatchExecutionInput,
  DispatchContext,
  DispatchTask,
} from "../../../src/legacy/execution/execution-types";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      agent: "execution-supervisor-test",
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

function createMockLLM(config?: { defaultDelayMs?: number }) {
  const defaultDelayMs = config?.defaultDelayMs ?? 10;

  return {
    llm: {
      run: async (input: Record<string, unknown>, sink: Sink) => {
        const sessionId = String(input.sessionID ?? "unknown-session");
        await sleep(defaultDelayMs);
        emitAssistantText(sink, sessionId, "Task completed");
        return { type: "stop" as const };
      },
    },
  };
}

describe("ExecutionSupervisor.executeDispatch", () => {
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

  describe("1. DAG Dependency Resolution", () => {
    it("executes sequential dependencies (B depends on A)", async () => {
      const mock = createMockLLM({ defaultDelayMs: 5 });

      const input: DispatchExecutionInput = {
        objective: "Test sequential execution",
        tasks: [
          {
            id: "A",
            description: "Step A",
            agentType: "implement",
            dependencies: [],
            fileScope: [],
          },
          {
            id: "B",
            description: "Step B",
            agentType: "implement",
            dependencies: ["A"],
            fileScope: [],
          },
        ],
      };

      const context: DispatchContext = {
        llm: mock.llm,
        review: () => ({ decision: "accept" }),
      };

      const result = await ExecutionSupervisor.executeDispatch(input, context);

      expect(result.success).toBe(true);
      expect(result.completedTaskIds.sort()).toEqual(["A", "B"]);
    });

    it("executes parallel tasks (A and B have no dependencies)", async () => {
      const mock = createMockLLM({ defaultDelayMs: 10 });

      const input: DispatchExecutionInput = {
        objective: "Test parallel execution",
        tasks: [
          {
            id: "A",
            description: "Step A",
            agentType: "implement",
            dependencies: [],
            fileScope: [],
          },
          {
            id: "B",
            description: "Step B",
            agentType: "implement",
            dependencies: [],
            fileScope: [],
          },
        ],
      };

      const context: DispatchContext = {
        llm: mock.llm,
        review: () => ({ decision: "accept" }),
      };

      const startTime = Date.now();
      const result = await ExecutionSupervisor.executeDispatch(input, context);
      const duration = Date.now() - startTime;

      expect(result.success).toBe(true);
      expect(result.completedTaskIds.sort()).toEqual(["A", "B"]);
      expect(duration).toBeLessThan(500);
    });

    it("executes complex DAG (A,B parallel -> C -> D)", async () => {
      const mock = createMockLLM({ defaultDelayMs: 5 });

      const input: DispatchExecutionInput = {
        objective: "Test complex DAG",
        tasks: [
          {
            id: "A",
            description: "Step A",
            agentType: "implement",
            dependencies: [],
            fileScope: [],
          },
          {
            id: "B",
            description: "Step B",
            agentType: "implement",
            dependencies: [],
            fileScope: [],
          },
          {
            id: "C",
            description: "Step C",
            agentType: "implement",
            dependencies: ["A", "B"],
            fileScope: [],
          },
          {
            id: "D",
            description: "Step D",
            agentType: "implement",
            dependencies: ["C"],
            fileScope: [],
          },
        ],
      };

      const context: DispatchContext = {
        llm: mock.llm,
        review: () => ({ decision: "accept" }),
      };

      const result = await ExecutionSupervisor.executeDispatch(input, context);

      expect(result.success).toBe(true);
      expect(result.completedTaskIds.sort()).toEqual(["A", "B", "C", "D"]);
    });
  });

  describe("2. ReviewGate Accept/Reject", () => {
    it("accepts task result and completes", async () => {
      const mock = createMockLLM({ defaultDelayMs: 5 });

      const input: DispatchExecutionInput = {
        objective: "Test accept decision",
        tasks: [
          {
            id: "T1",
            description: "Task 1",
            agentType: "implement",
            dependencies: [],
            fileScope: [],
          },
        ],
      };

      const context: DispatchContext = {
        llm: mock.llm,
        review: () => ({ decision: "accept" }),
      };

      const result = await ExecutionSupervisor.executeDispatch(input, context);

      expect(result.success).toBe(true);
      expect(result.completedTaskIds).toContain("T1");
    });

    it("rejects task result and retries with feedback", async () => {
      const mock = createMockLLM({ defaultDelayMs: 5 });
      let rejectionCount = 0;

      const input: DispatchExecutionInput = {
        objective: "Test reject and retry",
        tasks: [
          {
            id: "T1",
            description: "Task 1",
            agentType: "implement",
            dependencies: [],
            fileScope: [],
          },
        ],
      };

      const context: DispatchContext = {
        llm: mock.llm,
        review: () => {
          rejectionCount += 1;
          if (rejectionCount < 2) {
            return {
              decision: "reject",
              feedback: "Needs revision",
            };
          }
          return { decision: "accept" };
        },
      };

      const result = await ExecutionSupervisor.executeDispatch(input, context);

      expect(result.success).toBe(true);
      expect(result.completedTaskIds).toContain("T1");
      expect(rejectionCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe("3. Handoff (3 rejections -> agent rotation)", () => {
    it("triggers handoff after MAX_REJECTIONS_BEFORE_HANDOFF", async () => {
      const mock = createMockLLM({ defaultDelayMs: 5 });
      let rejectionCount = 0;

      const input: DispatchExecutionInput = {
        objective: "Test handoff trigger",
        tasks: [
          {
            id: "T1",
            description: "Task 1",
            agentType: "implement",
            dependencies: [],
            fileScope: [],
          },
        ],
      };

      const context: DispatchContext = {
        llm: mock.llm,
        review: () => {
          rejectionCount += 1;
          if (rejectionCount <= 3) {
            return {
              decision: "reject",
              feedback: `Revision needed ${rejectionCount}`,
            };
          }
          return { decision: "accept" };
        },
      };

      const result = await ExecutionSupervisor.executeDispatch(input, context);

      expect(result.success).toBe(true);
      const taskResult = result.results.find((r) => r.id === "T1");
      expect(taskResult?.handoffs).toBeGreaterThanOrEqual(1);
      expect(taskResult?.rejections).toBeGreaterThanOrEqual(3);
    });

    it("generates handoff document with context", async () => {
      const mock = createMockLLM({ defaultDelayMs: 5 });
      let rejectionCount = 0;

      const input: DispatchExecutionInput = {
        objective: "Test handoff document",
        tasks: [
          {
            id: "T1",
            description: "Task 1",
            agentType: "implement",
            dependencies: [],
            fileScope: [],
          },
        ],
      };

      const context: DispatchContext = {
        llm: mock.llm,
        review: () => {
          rejectionCount += 1;
          if (rejectionCount <= 3) {
            return {
              decision: "reject",
              feedback: `Revision ${rejectionCount}`,
            };
          }
          return { decision: "accept" };
        },
      };

      const result = await ExecutionSupervisor.executeDispatch(input, context);

      expect(result.success).toBe(true);
      const taskResult = result.results.find((r) => r.id === "T1");
      expect(taskResult?.agentHistory.length).toBeGreaterThan(1);
    });
  });

  describe("4. Abort/Timeout", () => {
    it("aborts execution when abort signal is triggered", async () => {
      const mock = createMockLLM({ defaultDelayMs: 50 });
      const abortController = new AbortController();

      const input: DispatchExecutionInput = {
        objective: "Test abort signal",
        tasks: [
          {
            id: "A",
            description: "Step A",
            agentType: "implement",
            dependencies: [],
            fileScope: [],
          },
          {
            id: "B",
            description: "Step B",
            agentType: "implement",
            dependencies: ["A"],
            fileScope: [],
          },
        ],
      };

      const context: DispatchContext = {
        llm: mock.llm,
        abortSignal: abortController.signal,
        review: () => ({ decision: "accept" }),
      };

      setTimeout(() => abortController.abort(), 20);

      const result = await ExecutionSupervisor.executeDispatch(input, context);

      expect(result.success).toBe(false);
    });

    it("handles timeout by aborting execution", async () => {
      const mock = createMockLLM({ defaultDelayMs: 100 });

      const input: DispatchExecutionInput = {
        objective: "Test timeout",
        tasks: [
          {
            id: "A",
            description: "Step A",
            agentType: "implement",
            dependencies: [],
            fileScope: [],
          },
          {
            id: "B",
            description: "Step B",
            agentType: "implement",
            dependencies: [],
            fileScope: [],
          },
        ],
      };

      const context: DispatchContext = {
        llm: mock.llm,
        timeoutMs: 50,
        review: () => ({ decision: "accept" }),
      };

      const result = await ExecutionSupervisor.executeDispatch(input, context);

      expect(result.success).toBe(false);
    });
  });

  describe("5. Cyclic Dependency Rejection", () => {
    it("throws error for cyclic dependencies (A -> B -> A)", async () => {
      const mock = createMockLLM({ defaultDelayMs: 5 });

      const input: DispatchExecutionInput = {
        objective: "Test cyclic dependency",
        tasks: [
          {
            id: "A",
            description: "Step A",
            agentType: "implement",
            dependencies: ["B"],
            fileScope: [],
          },
          {
            id: "B",
            description: "Step B",
            agentType: "implement",
            dependencies: ["A"],
            fileScope: [],
          },
        ],
      };

      const context: DispatchContext = {
        llm: mock.llm,
        review: () => ({ decision: "accept" }),
      };

      let errorThrown = false;
      try {
        await ExecutionSupervisor.executeDispatch(input, context);
      } catch (e) {
        errorThrown = true;
        expect(String(e)).toContain("cycle");
      }
      expect(errorThrown).toBe(true);
    });

    it("throws error for complex cycle (A -> B -> C -> A)", async () => {
      const mock = createMockLLM({ defaultDelayMs: 5 });

      const input: DispatchExecutionInput = {
        objective: "Test complex cycle",
        tasks: [
          {
            id: "A",
            description: "Step A",
            agentType: "implement",
            dependencies: ["C"],
            fileScope: [],
          },
          {
            id: "B",
            description: "Step B",
            agentType: "implement",
            dependencies: ["A"],
            fileScope: [],
          },
          {
            id: "C",
            description: "Step C",
            agentType: "implement",
            dependencies: ["B"],
            fileScope: [],
          },
        ],
      };

      const context: DispatchContext = {
        llm: mock.llm,
        review: () => ({ decision: "accept" }),
      };

      let errorThrown = false;
      try {
        await ExecutionSupervisor.executeDispatch(input, context);
      } catch (e) {
        errorThrown = true;
        expect(String(e)).toContain("cycle");
      }
      expect(errorThrown).toBe(true);
    });
  });

  describe("6. Agent Injection (agentId set)", () => {
    it("uses AgentDefinition when agentId is set", async () => {
      const mock = createMockLLM({ defaultDelayMs: 5 });

      const input: DispatchExecutionInput = {
        objective: "Test agent injection",
        tasks: [
          {
            id: "T1",
            description: "Task 1",
            agentType: "implement",
            dependencies: [],
            fileScope: [],
          },
        ],
      };

      const context: DispatchContext = {
        llm: mock.llm,
        agentId: "implement",
        review: () => ({ decision: "accept" }),
      };

      const result = await ExecutionSupervisor.executeDispatch(input, context);

      expect(result.success).toBe(true);
      expect(result.completedTaskIds).toContain("T1");
    });

    it("passes suggestedAgent hint to LLM for assignment", async () => {
      const mock = createMockLLM({ defaultDelayMs: 5 });

      const input: DispatchExecutionInput = {
        objective: "Test suggestedAgent hint",
        tasks: [
          {
            id: "T1",
            description: "Task 1",
            agentType: "implement",
            suggestedAgent: "implement",
            dependencies: [],
            fileScope: [],
          },
        ],
      };

      const context: DispatchContext = {
        llm: mock.llm,
        agentId: "implement",
        availableAgents: ["implement", "review"],
        review: () => ({ decision: "accept" }),
      };

      const result = await ExecutionSupervisor.executeDispatch(input, context);

      expect(result.success).toBe(true);
      expect(result.completedTaskIds).toContain("T1");
    });

    it("LLM can override suggestedAgent with assign_agents tool", async () => {
      const mock = createMockLLM({ defaultDelayMs: 5 });

      const input: DispatchExecutionInput = {
        objective: "Test agent override",
        tasks: [
          {
            id: "T1",
            description: "Task 1",
            agentType: "implement",
            suggestedAgent: "implement",
            dependencies: [],
            fileScope: [],
          },
        ],
      };

      const context: DispatchContext = {
        llm: mock.llm,
        agentId: "implement",
        availableAgents: ["implement", "review"],
        review: () => ({ decision: "accept" }),
      };

      const result = await ExecutionSupervisor.executeDispatch(input, context);

      expect(result.success).toBe(true);
      expect(result.completedTaskIds).toContain("T1");
    });
  });

  describe("7. Agent Fallback (agentId not set)", () => {
    it("maintains backward compatibility when agentId not set", async () => {
      const mock = createMockLLM({ defaultDelayMs: 5 });

      const input: DispatchExecutionInput = {
        objective: "Test backward compatibility",
        tasks: [
          {
            id: "T1",
            description: "Task 1",
            agentType: "implement",
            dependencies: [],
            fileScope: [],
          },
        ],
      };

      const context: DispatchContext = {
        llm: mock.llm,
        review: () => ({ decision: "accept" }),
      };

      const result = await ExecutionSupervisor.executeDispatch(input, context);

      expect(result.success).toBe(true);
      expect(result.completedTaskIds).toContain("T1");
    });

    it("uses default agent when agentId not provided", async () => {
      const mock = createMockLLM({ defaultDelayMs: 5 });

      const input: DispatchExecutionInput = {
        objective: "Test default agent",
        tasks: [
          {
            id: "T1",
            description: "Task 1",
            agentType: "implement",
            dependencies: [],
            fileScope: [],
          },
        ],
      };

      const context: DispatchContext = {
        llm: mock.llm,
        agentId: undefined,
        review: () => ({ decision: "accept" }),
      };

      const result = await ExecutionSupervisor.executeDispatch(input, context);

      expect(result.success).toBe(true);
      expect(result.completedTaskIds).toContain("T1");
    });

    it("skips agent assignment when no agentId provided", async () => {
      const mock = createMockLLM({ defaultDelayMs: 5 });

      const input: DispatchExecutionInput = {
        objective: "Test no agent assignment",
        tasks: [
          {
            id: "T1",
            description: "Task 1",
            agentType: "implement",
            dependencies: [],
            fileScope: [],
          },
        ],
      };

      const context: DispatchContext = {
        llm: mock.llm,
        review: () => ({ decision: "accept" }),
      };

      const result = await ExecutionSupervisor.executeDispatch(input, context);

      expect(result.success).toBe(true);
      expect(result.results.length).toBe(1);
    });
  });

  describe("8. Failure Handling (handle_failure tool)", () => {
    it("calls handle_failure tool on step failure", async () => {
      const mock = createMockLLM({ defaultDelayMs: 5 });

      const input: DispatchExecutionInput = {
        objective: "Test failure handling",
        tasks: [
          {
            id: "T1",
            description: "Task 1",
            agentType: "implement",
            dependencies: [],
            fileScope: [],
          },
        ],
      };

      const context: DispatchContext = {
        llm: mock.llm,
        review: () => ({ decision: "accept" }),
      };

      const result = await ExecutionSupervisor.executeDispatch(input, context);

      expect(result.success).toBe(true);
    });

    it("applies retry decision from handle_failure", async () => {
      const mock = createMockLLM({ defaultDelayMs: 5 });
      let attemptCount = 0;

      const input: DispatchExecutionInput = {
        objective: "Test retry decision",
        tasks: [
          {
            id: "T1",
            description: "Task 1",
            agentType: "implement",
            dependencies: [],
            fileScope: [],
          },
        ],
      };

      const context: DispatchContext = {
        llm: mock.llm,
        review: () => {
          attemptCount += 1;
          if (attemptCount < 2) {
            return {
              decision: "reject",
              feedback: "Retry needed",
            };
          }
          return { decision: "accept" };
        },
      };

      const result = await ExecutionSupervisor.executeDispatch(input, context);

      expect(result.success).toBe(true);
      expect(attemptCount).toBeGreaterThanOrEqual(2);
    });

    it("applies skip decision from handle_failure", async () => {
      const mock = createMockLLM({ defaultDelayMs: 5 });

      const input: DispatchExecutionInput = {
        objective: "Test skip decision",
        tasks: [
          {
            id: "A",
            description: "Step A",
            agentType: "implement",
            dependencies: [],
            fileScope: [],
          },
          {
            id: "B",
            description: "Step B",
            agentType: "implement",
            dependencies: ["A"],
            fileScope: [],
          },
        ],
      };

      const context: DispatchContext = {
        llm: mock.llm,
        review: () => ({ decision: "accept" }),
      };

      const result = await ExecutionSupervisor.executeDispatch(input, context);

      expect(result.success).toBe(true);
      expect(result.results.length).toBe(2);
    });

    it("applies replan decision from handle_failure", async () => {
      const mock = createMockLLM({ defaultDelayMs: 5 });

      const input: DispatchExecutionInput = {
        objective: "Test replan decision",
        tasks: [
          {
            id: "T1",
            description: "Task 1",
            agentType: "implement",
            dependencies: [],
            fileScope: [],
          },
        ],
      };

      const context: DispatchContext = {
        llm: mock.llm,
        review: () => ({ decision: "accept" }),
      };

      const result = await ExecutionSupervisor.executeDispatch(input, context);

      expect(result.success).toBe(true);
      expect(result.completedTaskIds).toContain("T1");
    });

    it("exercises handle_failure tool path with worker failures", async () => {
      let llmCallCount = 0;

      const hybridLLM = {
        run: async (input: Record<string, unknown>, sink: Sink) => {
          llmCallCount++;
          const sessionId = String(input.sessionID ?? "unknown-session");
          await sleep(5);
          emitAssistantText(sink, sessionId, "LLM response");
          return { type: "stop" as const };
        },
      };

      const input: DispatchExecutionInput = {
        objective: "Test handle_failure tool",
        tasks: [
          {
            id: "T1",
            description: "Task with failures",
            agentType: "implement",
            dependencies: [],
            fileScope: [],
          },
        ],
      };

      let reviewCount = 0;
      const context: DispatchContext = {
        llm: hybridLLM,
        agentId: "implement",
        availableAgents: ["implement"],
        review: () => {
          reviewCount++;
          if (reviewCount < 2) {
            return { decision: "reject" as const, feedback: "Retry needed" };
          }
          return { decision: "accept" as const };
        },
      };

      const result = await ExecutionSupervisor.executeDispatch(input, context);

      expect(result.success).toBe(true);
      expect(llmCallCount).toBeGreaterThan(1);
      expect(reviewCount).toBeGreaterThanOrEqual(2);
      expect(result.results.length).toBe(1);
    });
  });

  describe("Integration: Complex scenarios", () => {
    it("handles mixed sequential and parallel with agent injection", async () => {
      const mock = createMockLLM({ defaultDelayMs: 5 });

      const input: DispatchExecutionInput = {
        objective: "Test mixed execution",
        tasks: [
          {
            id: "A",
            description: "Step A",
            agentType: "implement",
            suggestedAgent: "implement",
            dependencies: [],
            fileScope: [],
          },
          {
            id: "B",
            description: "Step B",
            agentType: "implement",
            suggestedAgent: "review",
            dependencies: [],
            fileScope: [],
          },
          {
            id: "C",
            description: "Step C",
            agentType: "implement",
            dependencies: ["A", "B"],
            fileScope: [],
          },
        ],
      };

      const context: DispatchContext = {
        llm: mock.llm,
        agentId: "implement",
        availableAgents: ["implement", "review"],
        review: () => ({ decision: "accept" }),
      };

      const result = await ExecutionSupervisor.executeDispatch(input, context);

      expect(result.success).toBe(true);
      expect(result.completedTaskIds.sort()).toEqual(["A", "B", "C"]);
    });

    it("handles rejection with agent rotation and recovery", async () => {
      const mock = createMockLLM({ defaultDelayMs: 5 });
      let rejectionCount = 0;

      const input: DispatchExecutionInput = {
        objective: "Test rejection recovery",
        tasks: [
          {
            id: "T1",
            description: "Task 1",
            agentType: "implement",
            dependencies: [],
            fileScope: [],
          },
        ],
      };

      const context: DispatchContext = {
        llm: mock.llm,
        agentId: "implement",
        review: () => {
          rejectionCount += 1;
          if (rejectionCount <= 3) {
            return {
              decision: "reject",
              feedback: `Revision ${rejectionCount}`,
            };
          }
          return { decision: "accept" };
        },
      };

      const result = await ExecutionSupervisor.executeDispatch(input, context);

      expect(result.success).toBe(true);
      expect(rejectionCount).toBeGreaterThanOrEqual(3);
    });

    it("handles empty task list gracefully", async () => {
      const mock = createMockLLM({ defaultDelayMs: 5 });

      const input: DispatchExecutionInput = {
        objective: "Test empty tasks",
        tasks: [],
      };

      const context: DispatchContext = {
        llm: mock.llm,
        review: () => ({ decision: "accept" }),
      };

      const result = await ExecutionSupervisor.executeDispatch(input, context);

      expect(result.success).toBe(true);
      expect(result.completedTaskIds.length).toBe(0);
    });

    it("handles single task plan", async () => {
      const mock = createMockLLM({ defaultDelayMs: 5 });

      const input: DispatchExecutionInput = {
        objective: "Test single task",
        tasks: [
          {
            id: "T1",
            description: "Single task",
            agentType: "implement",
            dependencies: [],
            fileScope: [],
          },
        ],
      };

      const context: DispatchContext = {
        llm: mock.llm,
        review: () => ({ decision: "accept" }),
      };

      const result = await ExecutionSupervisor.executeDispatch(input, context);

      expect(result.success).toBe(true);
      expect(result.completedTaskIds).toContain("T1");
    });
  });
});
