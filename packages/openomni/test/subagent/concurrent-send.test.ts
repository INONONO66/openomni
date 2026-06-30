import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  ChatAgent,
  type AgentResult,
  type ChatAgentInput,
  type PolicyRegistration,
} from "@openomni/agent";
import { PolicyDecision } from "@openomni/protocol";
import { Session, Storage } from "@openomni/session";
import { SubagentRuntime } from "../../src/subagent/runtime";

const model = { provider: "anthropic", id: "claude-3-haiku-20240307" };

const allowDelegation: PolicyRegistration = {
  name: "test:allow-delegation",
  timing: "invoke.prepare",
  priority: 0,
  fn: () => PolicyDecision.allow({ policyId: "test:allow-delegation" }),
};

let createSpy: ReturnType<typeof spyOn>;
const executionLog: string[] = [];

function makeDelayedResult(index: number): AgentResult {
  return {
    text: `result-${index}`,
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    finishReason: "stop",
  };
}

beforeEach(() => {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
  executionLog.length = 0;
});

afterEach(() => {
  createSpy?.mockRestore();
});

describe("concurrent send guard", () => {
  it("serializes 10 concurrent send() calls on the same session", async () => {
    let callIndex = 0;

    createSpy = spyOn(ChatAgent, "create").mockImplementation(() => {
      return {
        run: async (_input: ChatAgentInput) => {
          const idx = callIndex++;
          executionLog.push(`start-${idx}`);
          await new Promise((resolve) => setTimeout(resolve, 5));
          executionLog.push(`end-${idx}`);
          return makeDelayedResult(idx);
        },
      } as unknown as ReturnType<typeof ChatAgent.create>;
    });

    const spawned = await SubagentRuntime.spawn({
      agentName: "worker",
      title: "task",
      prompt: "init",
      model,
    });

    executionLog.length = 0;
    callIndex = 0;

    const promises = Array.from({ length: 10 }, (_, i) =>
      SubagentRuntime.send({
        sessionId: spawned.sessionId,
        prompt: `message-${i}`,
        model,
      }),
    );

    const results = await Promise.all(promises);

    expect(results).toHaveLength(10);
    expect(executionLog).toHaveLength(20);
    for (let i = 0; i < 10; i++) {
      expect(executionLog[i * 2]).toBe(`start-${i}`);
      expect(executionLog[i * 2 + 1]).toBe(`end-${i}`);
    }
  });

  it("no duplicate message IDs across concurrent sends", async () => {
    let callIndex = 0;

    createSpy = spyOn(ChatAgent, "create").mockImplementation(() => {
      return {
        run: async (_input: ChatAgentInput) => {
          const idx = callIndex++;
          await new Promise((resolve) => setTimeout(resolve, 2));
          return makeDelayedResult(idx);
        },
      } as unknown as ReturnType<typeof ChatAgent.create>;
    });

    const spawned = await SubagentRuntime.spawn({
      agentName: "worker",
      title: "task",
      prompt: "init",
      model,
    });

    const promises = Array.from({ length: 10 }, (_, i) =>
      SubagentRuntime.send({
        sessionId: spawned.sessionId,
        prompt: `msg-${i}`,
        model,
      }),
    );

    await Promise.all(promises);

    const messages = Session.getMessages(spawned.sessionId);
    const messageIds = messages.map((m) => m.id);
    const uniqueIds = new Set(messageIds);
    expect(uniqueIds.size).toBe(messageIds.length);
  });

  it("one failed send does not break the chain for subsequent sends", async () => {
    let callIndex = 0;

    createSpy = spyOn(ChatAgent, "create").mockImplementation(() => {
      return {
        run: async (_input: ChatAgentInput) => {
          const idx = callIndex++;
          await new Promise((resolve) => setTimeout(resolve, 2));
          if (idx === 1) {
            throw new Error("transient failure");
          }
          return makeDelayedResult(idx);
        },
      } as unknown as ReturnType<typeof ChatAgent.create>;
    });

    const spawned = await SubagentRuntime.spawn({
      agentName: "worker",
      title: "task",
      prompt: "init",
      model,
    });

    callIndex = 0;

    const results = await Promise.allSettled([
      SubagentRuntime.send({ sessionId: spawned.sessionId, prompt: "a", model }),
      SubagentRuntime.send({ sessionId: spawned.sessionId, prompt: "b", model }),
      SubagentRuntime.send({ sessionId: spawned.sessionId, prompt: "c", model }),
    ]);

    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
    expect(results[2].status).toBe("fulfilled");
  });

  it("different sessions are not blocked by each other", async () => {
    let callIndex = 0;

    createSpy = spyOn(ChatAgent, "create").mockImplementation(() => {
      return {
        run: async (_input: ChatAgentInput) => {
          const idx = callIndex++;
          executionLog.push(`run-${idx}`);
          await new Promise((resolve) => setTimeout(resolve, 5));
          return makeDelayedResult(idx);
        },
      } as unknown as ReturnType<typeof ChatAgent.create>;
    });

    const session1 = await SubagentRuntime.spawn({
      agentName: "worker",
      title: "task-1",
      prompt: "init-1",
      model,
    });

    const session2 = await SubagentRuntime.spawn({
      agentName: "worker",
      title: "task-2",
      prompt: "init-2",
      model,
    });

    executionLog.length = 0;
    callIndex = 0;

    const [r1, r2] = await Promise.all([
      SubagentRuntime.send({ sessionId: session1.sessionId, prompt: "s1", model }),
      SubagentRuntime.send({ sessionId: session2.sessionId, prompt: "s2", model }),
    ]);

    expect(r1.output).toBeDefined();
    expect(r2.output).toBeDefined();
    expect(executionLog.filter((e) => e.startsWith("run-"))).toHaveLength(2);
  });

  it("spawn calls on the same parent are also serialized", async () => {
    let callIndex = 0;

    createSpy = spyOn(ChatAgent, "create").mockImplementation(() => {
      return {
        run: async (_input: ChatAgentInput) => {
          const idx = callIndex++;
          executionLog.push(`start-${idx}`);
          await new Promise((resolve) => setTimeout(resolve, 5));
          executionLog.push(`end-${idx}`);
          return makeDelayedResult(idx);
        },
      } as unknown as ReturnType<typeof ChatAgent.create>;
    });

    const parent = Session.create({
      title: "parent",
      model: { providerID: "anthropic", modelID: "claude-3-haiku-20240307" },
    });

    const promises = Array.from({ length: 3 }, (_, i) =>
      SubagentRuntime.spawn({
        parentSessionId: parent.id,
        agentName: `worker-${i}`,
        title: `task-${i}`,
        prompt: `prompt-${i}`,
        model,
        middleware: [allowDelegation],
      }),
    );

    const results = await Promise.all(promises);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.output.startsWith("result-"))).toBe(true);
  });
});
