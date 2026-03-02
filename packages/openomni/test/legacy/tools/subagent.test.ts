import { describe, it, expect, beforeEach } from "bun:test";
import { Subagent, type SubagentContext } from "../../../src/legacy/tools/subagent";
import { BuiltinAgentRegistry } from "../../../src/legacy/agent/registry/registry";
import { TaskStorage } from "../../../src/legacy/task/storage";
import { Session } from "@openomni/session";
import type { Sink } from "@openomni/protocol";

function createMockLLM(behavior: "stop" | "error" | "hang" = "stop") {
  return {
    run: async (_input: Record<string, unknown>, sink: Sink) => {
      if (behavior === "error") {
        return { type: "error" as const, error: new Error("LLM failed") };
      }
      if (behavior === "hang") {
        return new Promise<{ type: "stop" }>(() => {});
      }
      sink.onMessage({
        info: {
          id: crypto.randomUUID(),
          sessionID: "child-session",
          role: "assistant",
          time: { created: Date.now(), completed: Date.now() },
          parentID: crypto.randomUUID(),
          modelID: "test-model",
          providerID: "test-provider",
          agent: "test-agent",
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
            sessionID: "child-session",
            messageID: "msg-1",
            type: "text",
            text: "Subagent completed the task",
          },
        ],
      });
      return { type: "stop" as const };
    },
  };
}

function baseContext(
  overrides: Partial<SubagentContext> = {},
): SubagentContext {
  return {
    parentDepth: 0,
    llm: createMockLLM(),
    ...overrides,
  };
}

describe("Subagent", () => {
  beforeEach(() => {
    TaskStorage.reset();
    Session.storage.clear();

    BuiltinAgentRegistry.clear();
    BuiltinAgentRegistry.initializeBuiltins();
  });

  describe("execute", () => {
    it("spawns explore subagent and returns result", async () => {
      const result = await Subagent.execute(
        "call-1",
        { agentType: "explore", prompt: "find all auth files" },
        baseContext(),
      );

      expect(result.isError).toBe(false);
      expect(result.toolCallId).toBe("call-1");
      expect(result.output).toContain("Subagent completed the task");
    });

    it("returns error for invalid input (missing prompt)", async () => {
      const result = await Subagent.execute(
        "call-2",
        { agentType: "explore" },
        baseContext(),
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("Invalid subagent input");
    });

    it("returns error for unknown agent type", async () => {
      const result = await Subagent.execute(
        "call-3",
        { agentType: "nonexistent", prompt: "do something" },
        baseContext(),
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain('Unknown agent type: "nonexistent"');
      expect(result.output).toContain("Available:");
    });

    it("resumes existing session when sessionId provided", async () => {
      const sessionId = "existing-session-123";
      const now = Date.now();
      Session.storage.set(sessionId, {
        id: sessionId,
        title: "Existing Session",
        model: { providerID: "agent", modelID: "explore" },
        time: { created: now, updated: now },
      });

      const result = await Subagent.execute(
        "call-4",
        {
          agentType: "explore",
          prompt: "continue exploration",
          sessionId,
        },
        baseContext(),
      );

      expect(result.isError).toBe(false);
      expect(result.output).toContain("Subagent completed the task");
    });

    it("creates session for reuse when sessionId not found", async () => {
      const result = await Subagent.execute(
        "call-5",
        {
          agentType: "explore",
          prompt: "start new session",
          sessionId: "new-session-456",
        },
        baseContext(),
      );

      expect(result.isError).toBe(false);
    });
  });

  describe("depth limit enforcement", () => {
    it("rejects at default depth limit (3)", async () => {
      const result = await Subagent.execute(
        "call-depth-1",
        { agentType: "explore", prompt: "go deep" },
        baseContext({ parentDepth: 2 }),
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("depth limit reached");
      expect(result.output).toContain("3 >= 3");
    });

    it("rejects beyond custom depth limit", async () => {
      const result = await Subagent.execute(
        "call-depth-2",
        { agentType: "explore", prompt: "go deep" },
        baseContext({ parentDepth: 1, maxDepth: 2 }),
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("depth limit reached");
      expect(result.output).toContain("2 >= 2");
    });

    it("allows execution within depth limit", async () => {
      const result = await Subagent.execute(
        "call-depth-3",
        { agentType: "explore", prompt: "shallow call" },
        baseContext({ parentDepth: 1 }),
      );

      expect(result.isError).toBe(false);
    });

    it("allows depth 0 parent (first level nesting)", async () => {
      const result = await Subagent.execute(
        "call-depth-4",
        { agentType: "explore", prompt: "first level" },
        baseContext({ parentDepth: 0 }),
      );

      expect(result.isError).toBe(false);
    });

    it("4th level nesting throws error (depth 0→1→2→3 blocked)", async () => {
      const result = await Subagent.execute(
        "call-depth-5",
        { agentType: "explore", prompt: "too deep" },
        baseContext({ parentDepth: 3, maxDepth: 3 }),
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("depth limit reached");
    });
  });

  describe("abort propagation", () => {
    it("returns error when abort signal already fired", async () => {
      const controller = new AbortController();
      controller.abort();

      const result = await Subagent.execute(
        "call-abort-1",
        { agentType: "explore", prompt: "will be aborted" },
        baseContext({ abortSignal: controller.signal }),
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("aborted by parent");
    });

    it("aborts running child when parent aborts", async () => {
      const controller = new AbortController();

      const hangingLLM = {
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return { type: "stop" as const };
        },
      };

      const executePromise = Subagent.execute(
        "call-abort-2",
        { agentType: "explore", prompt: "long running task" },
        baseContext({ llm: hangingLLM, abortSignal: controller.signal }),
      );

      setTimeout(() => controller.abort(), 50);

      const result = await executePromise;

      expect(result.isError).toBe(true);
      expect(result.output).toContain("aborted by parent");
    });
  });

  describe("error handling", () => {
    it("handles LLM errors gracefully", async () => {
      const result = await Subagent.execute(
        "call-err-1",
        { agentType: "explore", prompt: "will fail" },
        baseContext({ llm: createMockLLM("error") }),
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("Subagent failed");
    });

    it("returns proper ToolResult shape on success", async () => {
      const result = await Subagent.execute(
        "call-shape-1",
        { agentType: "explore", prompt: "check shape" },
        baseContext(),
      );

      expect(result.id).toBeDefined();
      expect(typeof result.id).toBe("string");
      expect(result.toolCallId).toBe("call-shape-1");
      expect(typeof result.output).toBe("string");
      expect(result.isError).toBe(false);
    });

    it("returns proper ToolResult shape on error", async () => {
      const result = await Subagent.execute(
        "call-shape-2",
        { agentType: "nonexistent", prompt: "check shape" },
        baseContext(),
      );

      expect(result.id).toBeDefined();
      expect(typeof result.id).toBe("string");
      expect(result.toolCallId).toBe("call-shape-2");
      expect(typeof result.output).toBe("string");
      expect(result.isError).toBe(true);
    });
  });
});
