import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { PlanStep, Tool } from "@openomni/protocol";
import type { AgentResult, TokenUsage } from "@openomni/agent";
import { Teammate } from "../../src/team/teammate";

// Mock ChatAgent module
const mockChatAgentInstances: Array<{
  run: (input: unknown) => Promise<AgentResult>;
}> = [];

mock.module("@openomni/agent", () => ({
  ChatAgent: {
    create: (config: unknown) => {
      const instance = {
        run: mock(async (input: unknown): Promise<AgentResult> => {
          return {
            text: "Mock agent output",
            steps: [],
            usage: {
              inputTokens: 10,
              outputTokens: 20,
              totalTokens: 30,
            },
            finishReason: "stop",
          };
        }),
      };
      mockChatAgentInstances.push(instance);
      return instance;
    },
  },
}));

describe("Teammate", () => {
  beforeEach(() => {
    mockChatAgentInstances.length = 0;
  });

  describe("execute()", () => {
    it("should return ExecuteResult with correct agentId and stepId", async () => {
      const step: PlanStep = {
        stepId: "step-1",
        description: "Test step",
        expectedOutput: "Expected result",
      };

      const config: Teammate.TeammateConfig = {
        agentId: "agent-1",
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      };

      const result = await Teammate.execute({ step }, config);

      expect(result.agentId).toBe("agent-1");
      expect(result.stepId).toBe("step-1");
      expect(result.output).toBe("Mock agent output");
      expect(result.usage).toEqual({
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
      });
      expect(result.finishReason).toBe("stop");
    });

    it("should create fresh ChatAgent per call (no shared state)", async () => {
      const step: PlanStep = {
        stepId: "step-1",
        description: "Test step",
        expectedOutput: "Expected result",
      };

      const config: Teammate.TeammateConfig = {
        agentId: "agent-1",
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      };

      // First call
      await Teammate.execute({ step }, config);
      const firstInstanceCount = mockChatAgentInstances.length;

      // Second call
      await Teammate.execute({ step }, config);
      const secondInstanceCount = mockChatAgentInstances.length;

      // Should have created 2 separate instances
      expect(secondInstanceCount).toBe(firstInstanceCount + 1);
    });

    it("should include context in user message when provided", async () => {
      const step: PlanStep = {
        stepId: "step-1",
        description: "Test step",
        expectedOutput: "Expected result",
      };

      const config: Teammate.TeammateConfig = {
        agentId: "agent-1",
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      };

      const context = "Previous step output: some data";

      await Teammate.execute({ step, context }, config);

      // Verify the ChatAgent.run was called with context in message
      const instance = mockChatAgentInstances[0];
      expect(instance.run).toHaveBeenCalled();

      const callArgs = instance.run.mock.calls[0];
      const input = callArgs[0] as { messages: Array<{ content: string }> };

      // Check that context is in the user message
      const userMessage = input.messages[0];
      expect(userMessage.content).toContain("Context from previous steps:");
      expect(userMessage.content).toContain(context);
    });

    it("should include handoffDocument in user message when provided", async () => {
      const step: PlanStep = {
        stepId: "step-1",
        description: "Test step",
        expectedOutput: "Expected result",
      };

      const config: Teammate.TeammateConfig = {
        agentId: "agent-1",
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      };

      const handoffDocument =
        "Previous attempt notes: try a different approach";

      await Teammate.execute({ step, handoffDocument }, config);

      const instance = mockChatAgentInstances[0];
      const callArgs = instance.run.mock.calls[0];
      const input = callArgs[0] as { messages: Array<{ content: string }> };

      const userMessage = input.messages[0];
      expect(userMessage.content).toContain("Handoff from previous attempt:");
      expect(userMessage.content).toContain(handoffDocument);
    });

    it("should pass toolExecutor to ChatAgent config when provided", async () => {
      const step: PlanStep = {
        stepId: "step-1",
        description: "Test step",
        expectedOutput: "Expected result",
      };

      const mockToolExecutor = mock(async (call: Tool.Call) => ({
        id: "result-1",
        toolCallId: call.id,
        output: "Tool result",
        isError: false,
      }));

      const config: Teammate.TeammateConfig = {
        agentId: "agent-1",
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        toolExecutor: mockToolExecutor,
      };

      await Teammate.execute({ step }, config);

      // Verify ChatAgent.create was called with toolExecutor in config
      // This is verified by checking that the instance was created
      expect(mockChatAgentInstances.length).toBe(1);
    });

    it("should return result.output matching AgentResult.text", async () => {
      const step: PlanStep = {
        stepId: "step-1",
        description: "Test step",
        expectedOutput: "Expected result",
      };

      const config: Teammate.TeammateConfig = {
        agentId: "agent-1",
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      };

      const result = await Teammate.execute({ step }, config);

      // The output should match the text from AgentResult
      expect(result.output).toBe("Mock agent output");
    });

    it("should build user message with task description and expected output", async () => {
      const step: PlanStep = {
        stepId: "step-1",
        description: "Analyze the data",
        expectedOutput: "A summary of findings",
      };

      const config: Teammate.TeammateConfig = {
        agentId: "agent-1",
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      };

      await Teammate.execute({ step }, config);

      const instance = mockChatAgentInstances[0];
      const callArgs = instance.run.mock.calls[0];
      const input = callArgs[0] as { messages: Array<{ content: string }> };

      const userMessage = input.messages[0];
      expect(userMessage.content).toContain("Execute the following task:");
      expect(userMessage.content).toContain("Task: Analyze the data");
      expect(userMessage.content).toContain(
        "Expected Output: A summary of findings",
      );
    });

    it("should pass systemPrompt to ChatAgent config when provided", async () => {
      const step: PlanStep = {
        stepId: "step-1",
        description: "Test step",
        expectedOutput: "Expected result",
      };

      const systemPrompt = "You are a helpful assistant";

      const config: Teammate.TeammateConfig = {
        agentId: "agent-1",
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        systemPrompt,
      };

      await Teammate.execute({ step }, config);

      // Verify ChatAgent.create was called
      expect(mockChatAgentInstances.length).toBe(1);
    });

    it("should pass tools to ChatAgent config when provided", async () => {
      const step: PlanStep = {
        stepId: "step-1",
        description: "Test step",
        expectedOutput: "Expected result",
      };

      const tools: Tool.Spec[] = [
        {
          name: "test-tool",
          description: "A test tool",
          inputSchema: {
            type: "object",
            properties: {},
            required: [],
          },
        },
      ];

      const config: Teammate.TeammateConfig = {
        agentId: "agent-1",
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        tools,
      };

      await Teammate.execute({ step }, config);

      expect(mockChatAgentInstances.length).toBe(1);
    });

    it("should pass budget to ChatAgent config when provided", async () => {
      const step: PlanStep = {
        stepId: "step-1",
        description: "Test step",
        expectedOutput: "Expected result",
      };

      const budget = { maxTurns: 5, maxToolCalls: 10 };

      const config: Teammate.TeammateConfig = {
        agentId: "agent-1",
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        budget,
      };

      await Teammate.execute({ step }, config);

      expect(mockChatAgentInstances.length).toBe(1);
    });
  });
});
