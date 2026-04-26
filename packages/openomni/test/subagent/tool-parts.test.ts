import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { ChatAgent, type AgentResult, type ChatAgentInput } from "@openomni/agent";
import type { Message } from "@openomni/protocol";
import { Session, Storage } from "@openomni/session";
import { SubagentRuntime } from "../../src/subagent/runtime";

const runCalls: ChatAgentInput[] = [];
const runResults: AgentResult[] = [];

let createSpy: ReturnType<typeof spyOn>;

function queueResult(result: AgentResult): void {
  runResults.push(result);
}

function createResult(text: string, steps: AgentResult["steps"] = []): AgentResult {
  return {
    text,
    steps,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    finishReason: "stop",
  };
}

function getAssistantMessage(sessionId: string): Message.AssistantMessage {
  const message = Session.getMessages(sessionId).find(
    (candidate): candidate is Message.AssistantMessage => candidate.role === "assistant",
  );

  if (!message) {
    throw new Error("Expected assistant message to exist");
  }

  return message;
}

beforeEach(() => {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
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

describe("SubagentRuntime tool parts", () => {
  it("stores tool calls from spawn as completed tool parts", async () => {
    queueResult(
      createResult("done", [
        {
          type: "tool-call",
          content: "used lookup",
          toolCalls: [
            {
              id: "call-1",
              tool: "lookup",
              input: { query: "openomni" },
            },
          ],
          toolResults: [
            {
              id: "result-1",
              toolCallId: "call-1",
              output: "found it",
            },
          ],
        },
      ]),
    );

    const result = await SubagentRuntime.spawn({
      agentName: "worker",
      title: "child task",
      prompt: "solve this",
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    });

    const assistantMessage = getAssistantMessage(result.sessionId);
    const parts = Session.getParts(assistantMessage.id);
    const toolPart = parts.find((part): part is Message.ToolPart => part.type === "tool");

    expect(toolPart).toBeDefined();
    expect(toolPart).toMatchObject({
      sessionID: result.sessionId,
      messageID: assistantMessage.id,
      type: "tool",
      callID: "call-1",
      tool: "lookup",
      state: {
        status: "completed",
        input: { query: "openomni" },
        output: "found it",
        title: "lookup",
        metadata: {},
      },
    });
    expect(toolPart?.state.status).toBe("completed");
    if (toolPart?.state.status === "completed") {
      expect(toolPart.state.time.start).toEqual(expect.any(Number));
      expect(toolPart.state.time.end).toEqual(expect.any(Number));
    }
  });

  it("rebuilds assistant transcript with tool context and persists send tool parts", async () => {
    queueResult(
      createResult("first answer", [
        {
          type: "tool-call",
          content: "used lookup",
          toolCalls: [
            {
              id: "call-1",
              tool: "lookup",
              input: { query: "openomni" },
            },
          ],
          toolResults: [
            {
              id: "result-1",
              toolCallId: "call-1",
              output: "found it",
            },
          ],
        },
      ]),
    );

    const spawned = await SubagentRuntime.spawn({
      agentName: "worker",
      title: "child task",
      prompt: "first prompt",
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    });

    queueResult(
      createResult("second answer", [
        {
          type: "tool-call",
          content: "used formatter",
          toolCalls: [
            {
              id: "call-2",
              tool: "formatter",
              input: { format: "markdown" },
            },
          ],
          toolResults: [
            {
              id: "result-2",
              toolCallId: "call-2",
              output: "formatted",
            },
          ],
        },
      ]),
    );

    await SubagentRuntime.send({
      sessionId: spawned.sessionId,
      prompt: "second prompt",
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    });

    expect(runCalls).toHaveLength(2);
    expect(runCalls[1]?.messages).toEqual([
      { role: "user", content: "first prompt" },
      {
        role: "assistant",
        content: 'first answer\n[Tool: lookup] Input: {"query":"openomni"} Output: found it',
      },
      { role: "user", content: "second prompt" },
    ]);

    const assistantMessages = Session.getMessages(spawned.sessionId).filter(
      (message): message is Message.AssistantMessage => message.role === "assistant",
    );
    const latestAssistant = assistantMessages[assistantMessages.length - 1];
    const latestParts = Session.getParts(latestAssistant!.id);
    const toolPart = latestParts.find((part): part is Message.ToolPart => part.type === "tool");

    expect(toolPart).toBeDefined();
    expect(toolPart).toMatchObject({
      callID: "call-2",
      tool: "formatter",
      state: {
        status: "completed",
        input: { format: "markdown" },
        output: "formatted",
        title: "formatter",
        metadata: {},
      },
    });
  });
});
