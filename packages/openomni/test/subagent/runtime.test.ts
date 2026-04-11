import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { ChatAgent, type AgentResult, type ChatAgentInput } from "@openomni/agent";
import { Session, Storage } from "@openomni/session";
import { SubagentRuntime } from "../../src/subagent/runtime";

const runCalls: ChatAgentInput[] = [];
const runResults: AgentResult[] = [];

let createSpy: ReturnType<typeof spyOn>;

function queueResult(text: string): void {
  runResults.push({
    text,
    steps: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    finishReason: "stop",
  });
}

function createParentSession(): string {
  return Session.create({
    title: "parent",
    model: { providerID: "anthropic", modelID: "claude-3-haiku-20240307" },
  }).id;
}

beforeEach(() => {
  Storage.reset();
  runCalls.length = 0;
  runResults.length = 0;
  createSpy = spyOn(ChatAgent, "create").mockImplementation(() => {
    return {
      run: async (input: ChatAgentInput) => {
        runCalls.push(input);

        const next = runResults.shift();
        if (!next) {
          throw new Error("No mocked agent result queued");
        }

        return next;
      },
    } as unknown as ReturnType<typeof ChatAgent.create>;
  });
});

afterEach(() => {
  createSpy.mockRestore();
});

describe("SubagentRuntime", () => {
  it("spawn creates a child session linked to the parent", async () => {
    const parentSessionId = createParentSession();
    queueResult("first output");

    const result = await SubagentRuntime.spawn({
      parentSessionId,
      agentName: "worker",
      title: "child task",
      prompt: "solve this",
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    });

    const childSession = Session.get(result.sessionId);
    expect(childSession).toBeDefined();
    expect(childSession?.parentSessionId).toBe(parentSessionId);
    expect(childSession?.spawnDepth).toBe(1);
  });

  it("spawn returns output text", async () => {
    queueResult("spawned answer");

    const result = await SubagentRuntime.spawn({
      agentName: "worker",
      title: "child task",
      prompt: "solve this",
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    });

    expect(result.output).toBe("spawned answer");
    expect(result.finishReason).toBe("stop");
  });

  it("send reuses the full transcript for the same session", async () => {
    queueResult("first answer");
    const spawned = await SubagentRuntime.spawn({
      agentName: "worker",
      title: "child task",
      prompt: "first prompt",
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    });

    queueResult("second answer");
    const sent = await SubagentRuntime.send({
      sessionId: spawned.sessionId,
      prompt: "second prompt",
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    });

    expect(sent.output).toBe("second answer");
    expect(runCalls).toHaveLength(2);
    expect(runCalls[1]?.messages).toEqual([
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second prompt" },
    ]);
  });

  it("wait returns the persisted run status and output", async () => {
    queueResult("done");
    const spawned = await SubagentRuntime.spawn({
      agentName: "worker",
      title: "child task",
      prompt: "solve this",
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    });

    const waited = await SubagentRuntime.wait({
      sessionId: spawned.sessionId,
      runId: spawned.runId,
    });

    expect(waited).toEqual({
      status: "succeeded",
      output: "done",
    });
  });

  it("spawn works without a parent session", async () => {
    queueResult("standalone answer");

    const spawned = await SubagentRuntime.spawn({
      agentName: "worker",
      title: "standalone task",
      prompt: "do work",
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    });

    const session = Session.get(spawned.sessionId);
    expect(session).toBeDefined();
    expect(session?.parentSessionId).toBeUndefined();
    expect(session?.spawnDepth).toBe(0);
  });
});
