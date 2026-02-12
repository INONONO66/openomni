import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import type { Sink } from "@openomni/protocol";
import { Session } from "@openomni/session";
import { BuiltinAgentRegistry } from "../../src/agent/registry";
import {
  AgentMessenger,
  type MessageEnvelope,
} from "../../src/agent/communication";
import { TaskStorage } from "../../src/task/storage";
import { Subagent, type SubagentContext } from "../../src/tools/subagent";

function createMockLLM(behavior: "stop" | "error" = "stop") {
  return {
    run: async (_input: Record<string, unknown>, sink: Sink) => {
      if (behavior === "error") {
        return { type: "error" as const, error: new Error("LLM failed") };
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

describe("Subagent Completion Announce", () => {
  let capturedEnvelopes: MessageEnvelope[];
  let unsubscribe: () => void;

  beforeEach(() => {
    TaskStorage.reset();
    Session.storage.clear();
    BuiltinAgentRegistry.clear();
    BuiltinAgentRegistry.initializeBuiltins();
    AgentMessenger.resetAllowPatterns();
    AgentMessenger.resetBothPolicy();
    capturedEnvelopes = [];
    unsubscribe = AgentMessenger.subscribe("surface-agent", (envelope) => {
      capturedEnvelopes.push(envelope);
    });
  });

  afterEach(() => {
    unsubscribe();
  });

  describe("announce after successful completion", () => {
    it("sends announce to parent session on success", async () => {
      const result = await Subagent.execute(
        "call-1",
        { agentType: "explore", prompt: "find files" },
        baseContext({ parentSessionId: "parent-session-1" }),
      );

      expect(result.isError).toBe(false);

      await new Promise((r) => setTimeout(r, 5));

      expect(capturedEnvelopes.length).toBe(1);
      const announce = capturedEnvelopes[0];
      expect(announce.schemaRef).toBe("subagent.completion.announce.v1");
      expect(announce.sessionId).toBe("parent-session-1");
      expect(announce.fromAgentId).toBe("subagent-worker");
      expect(announce.toAgentId).toBe("surface-agent");
      expect(announce.persistencePolicy).toBe("asker_only");

      const payload = announce.payload as Record<string, unknown>;
      expect(payload.agentType).toBe("explore");
      expect(payload.success).toBe(true);
      expect(payload.summary).toContain("Subagent completed the task");
      expect(payload.error).toBeFalsy();
    });

    it("includes childSessionId from config", async () => {
      const result = await Subagent.execute(
        "call-sid",
        {
          agentType: "explore",
          prompt: "find files",
          sessionId: "child-session-explicit",
        },
        baseContext({ parentSessionId: "parent-session-2" }),
      );

      expect(result.isError).toBe(false);

      await new Promise((r) => setTimeout(r, 5));

      expect(capturedEnvelopes.length).toBe(1);
      const payload = capturedEnvelopes[0].payload as Record<string, unknown>;
      expect(payload.childSessionId).toBe("child-session-explicit");
    });
  });

  describe("announce after failed completion", () => {
    it("sends announce on failure", async () => {
      const result = await Subagent.execute(
        "call-fail",
        { agentType: "explore", prompt: "will fail" },
        baseContext({
          parentSessionId: "parent-session-3",
          llm: createMockLLM("error"),
        }),
      );

      expect(result.isError).toBe(true);

      await new Promise((r) => setTimeout(r, 5));

      expect(capturedEnvelopes.length).toBe(1);
      const payload = capturedEnvelopes[0].payload as Record<string, unknown>;
      expect(payload.success).toBe(false);
      expect(payload.agentType).toBe("explore");
    });
  });

  describe("no announce without parentSessionId", () => {
    it("skips announce when parentSessionId is not set", async () => {
      const result = await Subagent.execute(
        "call-no-parent",
        { agentType: "explore", prompt: "no parent" },
        baseContext(),
      );

      expect(result.isError).toBe(false);

      await new Promise((r) => setTimeout(r, 5));

      expect(capturedEnvelopes.length).toBe(0);
    });
  });

  describe("fire-and-forget semantics", () => {
    it("parent run returns immediately (does not wait for announce)", async () => {
      const startTime = Date.now();

      const result = await Subagent.execute(
        "call-fast",
        { agentType: "explore", prompt: "fast return" },
        baseContext({ parentSessionId: "parent-session-4" }),
      );

      const elapsed = Date.now() - startTime;

      expect(result.isError).toBe(false);
      expect(elapsed).toBeLessThan(5000);
    });

    it("announce failure does not affect parent run result", async () => {
      AgentMessenger.configureAllowPatterns([
        { from: "blocked-agent", to: "blocked-agent" },
      ]);

      const result = await Subagent.execute(
        "call-announce-fail",
        { agentType: "explore", prompt: "announce will fail" },
        baseContext({ parentSessionId: "parent-session-5" }),
      );

      expect(result.isError).toBe(false);
      expect(result.output).toContain("Subagent completed the task");

      await new Promise((r) => setTimeout(r, 5));

      expect(capturedEnvelopes.length).toBe(0);
    });

    it("announce failure logs error but does not throw", async () => {
      const consoleSpy = spyOn(console, "error").mockImplementation(() => {});

      AgentMessenger.configureAllowPatterns([
        { from: "blocked-agent", to: "blocked-agent" },
      ]);

      await Subagent.execute(
        "call-log-error",
        { agentType: "explore", prompt: "will log error" },
        baseContext({ parentSessionId: "parent-session-6" }),
      );

      await new Promise((r) => setTimeout(r, 5));

      expect(consoleSpy).toHaveBeenCalledWith(
        "Announce failed (non-fatal):",
        expect.any(Error),
      );

      consoleSpy.mockRestore();
    });
  });

  describe("announce envelope structure", () => {
    it("has all required envelope fields", async () => {
      await Subagent.execute(
        "call-structure",
        { agentType: "explore", prompt: "check structure" },
        baseContext({ parentSessionId: "parent-session-7" }),
      );

      await new Promise((r) => setTimeout(r, 5));

      expect(capturedEnvelopes.length).toBe(1);
      const envelope = capturedEnvelopes[0];

      expect(envelope.traceId).toBeDefined();
      expect(typeof envelope.traceId).toBe("string");
      expect(envelope.runId).toBeDefined();
      expect(typeof envelope.runId).toBe("string");
      expect(envelope.sentAt).toBeDefined();
      expect(new Date(envelope.sentAt).getTime()).toBeGreaterThan(0);
      expect(envelope.schemaRef).toBe("subagent.completion.announce.v1");
    });
  });
});
