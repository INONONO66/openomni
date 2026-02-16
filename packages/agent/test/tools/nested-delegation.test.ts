import { beforeEach, describe, expect, it } from "bun:test";
import type { Sink } from "@openomni/protocol";
import { Session } from "@openomni/session";
import { BuiltinAgentRegistry } from "../../src/agent/registry";
import { TaskStorage } from "../../src/task/storage";
import { Subagent, type SubagentContext } from "../../src/tools/subagent";
import { Dispatch, type DispatchContext } from "../../src/tools/dispatch";
import { FileLock } from "../../src/execution/file-lock";

function createMockLLM() {
  return {
    run: async (_input: Record<string, unknown>, sink: Sink) => {
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
            text: "Task completed",
          },
        ],
      });
      return { type: "stop" as const };
    },
  };
}

function baseSubagentContext(
  overrides: Partial<SubagentContext> = {},
): SubagentContext {
  return {
    parentDepth: 0,
    llm: createMockLLM(),
    ...overrides,
  };
}

function baseDispatchContext(
  overrides: Partial<DispatchContext> = {},
): DispatchContext {
  return {
    llm: createMockLLM(),
    ...overrides,
  };
}

describe("Nested Delegation Guard", () => {
  beforeEach(() => {
    TaskStorage.reset();
    Session.storage.clear();
    FileLock.clear();
    BuiltinAgentRegistry.clear();
    BuiltinAgentRegistry.initializeBuiltins();
  });

  describe("Subagent nested delegation", () => {
    it("allows root-level subagent call (insideDelegation unset)", async () => {
      const result = await Subagent.execute(
        "call-root",
        { agentType: "explore", prompt: "root task" },
        baseSubagentContext(),
      );

      expect(result.isError).toBe(false);
      expect(result.output).toContain("Task completed");
    });

    it("allows root-level subagent call (insideDelegation=false)", async () => {
      const result = await Subagent.execute(
        "call-root-explicit",
        { agentType: "explore", prompt: "root task" },
        baseSubagentContext({ insideDelegation: false }),
      );

      expect(result.isError).toBe(false);
      expect(result.output).toContain("Task completed");
    });

    it("blocks subagent calling subagent (insideDelegation=true)", async () => {
      const result = await Subagent.execute(
        "call-nested",
        { agentType: "explore", prompt: "nested task" },
        baseSubagentContext({ insideDelegation: true }),
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("Nested delegation not allowed");
      expect(result.output).toContain("subagent cannot call subagent/dispatch");
      expect(result.toolCallId).toBe("call-nested");
      expect(result.id).toBeDefined();
    });

    it("nested delegation guard runs before depth check", async () => {
      const result = await Subagent.execute(
        "call-guard-order",
        { agentType: "explore", prompt: "order test" },
        baseSubagentContext({ insideDelegation: true, parentDepth: 0 }),
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("Nested delegation not allowed");
      expect(result.output).not.toContain("depth limit");
    });

    it("nested delegation guard runs after input validation", async () => {
      const result = await Subagent.execute(
        "call-invalid-input",
        { agentType: "explore" },
        baseSubagentContext({ insideDelegation: true }),
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("Invalid subagent input");
    });
  });

  describe("Dispatch nested delegation", () => {
    it("allows root-level dispatch call (insideDelegation unset)", async () => {
      const result = await Dispatch.execute(
        "dispatch-root",
        {
          objective: "Root dispatch",
          tasks: [
            {
              id: "T1",
              description: "Do work",
              agentType: "implement",
              dependencies: [],
              fileScope: ["src/a.ts"],
            },
          ],
        },
        baseDispatchContext({
          review: () => ({ decision: "accept" }),
        }),
      );

      expect(result.isError).toBe(false);
    });

    it("blocks dispatch child calling dispatch (insideDelegation=true)", async () => {
      const result = await Dispatch.execute(
        "dispatch-nested",
        {
          objective: "Nested dispatch",
          tasks: [
            {
              id: "T1",
              description: "Do work",
              agentType: "implement",
              dependencies: [],
              fileScope: [],
            },
          ],
        },
        baseDispatchContext({ insideDelegation: true }),
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("Nested delegation not allowed");
      expect(result.output).toContain(
        "dispatch child cannot call subagent/dispatch",
      );
      expect(result.toolCallId).toBe("dispatch-nested");
      expect(result.id).toBeDefined();
    });

    it("blocks dispatch child calling subagent (via subagent tool with flag)", async () => {
      const result = await Subagent.execute(
        "subagent-from-dispatch",
        { agentType: "explore", prompt: "dispatch child calling subagent" },
        baseSubagentContext({ insideDelegation: true }),
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("Nested delegation not allowed");
    });

    it("nested delegation guard runs after input validation", async () => {
      const result = await Dispatch.execute(
        "dispatch-invalid",
        { objective: "" },
        baseDispatchContext({ insideDelegation: true }),
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("Invalid dispatch input");
    });
  });

  describe("Guard independence from depth check", () => {
    it("delegation guard blocks even at depth 0", async () => {
      const result = await Subagent.execute(
        "call-depth-0-delegated",
        { agentType: "explore", prompt: "should be blocked" },
        baseSubagentContext({ insideDelegation: true, parentDepth: 0 }),
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("Nested delegation not allowed");
    });

    it("depth check still works independently when not delegated", async () => {
      const result = await Subagent.execute(
        "call-depth-exceeded",
        { agentType: "explore", prompt: "too deep" },
        baseSubagentContext({ parentDepth: 3, maxDepth: 3 }),
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("depth limit reached");
    });

    it("delegation guard blocks dispatch even with no depth set", async () => {
      const result = await Dispatch.execute(
        "dispatch-no-depth",
        {
          objective: "No depth dispatch",
          tasks: [
            {
              id: "T1",
              description: "Work",
              agentType: "implement",
              dependencies: [],
              fileScope: [],
            },
          ],
        },
        baseDispatchContext({ insideDelegation: true }),
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("Nested delegation not allowed");
    });
  });
});
