import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { ChatAgent, type AgentResult, type ChatAgentInput } from "@openomni/agent";
import type { Message } from "@openomni/protocol";
import { Session, Storage } from "@openomni/session";
import { SubagentRuntime } from "../../src/subagent/runtime";

const runCalls: ChatAgentInput[] = [];
const runResults: AgentResult[] = [];

let createSpy: ReturnType<typeof spyOn>;

const model = { provider: "anthropic", id: "claude-3-haiku-20240307" };

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

function createSession(): string {
  return Session.create({
    title: "compaction-test",
    model: { providerID: model.provider, modelID: model.id },
  }).id;
}

function addTextMessage(sessionId: string, role: "user" | "assistant", text: string): void {
  const id = crypto.randomUUID();
  const message: Message.UserMessage | Message.AssistantMessage =
    role === "user"
      ? {
          id,
          sessionID: sessionId,
          role: "user",
          time: { created: Date.now() },
          agent: "test",
          model: { providerID: model.provider, modelID: model.id },
        }
      : {
          id,
          sessionID: sessionId,
          role: "assistant",
          time: { created: Date.now() },
          parentID: "",
          modelID: model.id,
          providerID: model.provider,
          agent: "test",
          path: { cwd: process.cwd(), root: process.cwd() },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        };

  const part: Message.TextPart = {
    id: crypto.randomUUID(),
    sessionID: sessionId,
    messageID: id,
    type: "text",
    text,
  };

  Session.addMessage(sessionId, message);
  Session.addPart(id, part);
}

function seedLongTranscript(sessionId: string): void {
  addTextMessage(sessionId, "user", "initial goal: stabilize the subagent runtime transcript");
  addTextMessage(sessionId, "assistant", "acknowledged the initial goal and started execution");

  for (let index = 0; index < 10; index++) {
    addTextMessage(
      sessionId,
      "user",
      `user turn ${index}: expand transcript context with compaction candidate ${index}`,
    );
    addTextMessage(
      sessionId,
      "assistant",
      `assistant turn ${index}: retained context block ${index} for follow-up reasoning`,
    );
  }
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

describe("SubagentRuntime compaction", () => {
  it("compacts long send transcripts and re-injects the original goal anchor", async () => {
    const sessionId = createSession();
    seedLongTranscript(sessionId);
    queueResult("done");

    const originalMessages = SubagentRuntime.buildChildMessages(sessionId);
    let summarizedMessages: ChatAgentInput["messages"] | undefined;

    await SubagentRuntime.send({
      sessionId,
      prompt: "latest follow-up request after a long discussion",
      model,
      compaction: {
        contextWindowTokens: 10,
        onSummarize: async (messages) => {
          summarizedMessages = messages;
          return `summary of ${messages.length} removed messages`;
        },
      },
    });

    expect(runCalls).toHaveLength(1);
    expect(originalMessages.length).toBe(22);
    expect(summarizedMessages).toBeDefined();
    expect(summarizedMessages?.[0]).toEqual({
      role: "user",
      content: "initial goal: stabilize the subagent runtime transcript",
    });
    expect(runCalls[0]?.messages.length).toBeLessThan(originalMessages.length + 1);
    expect(runCalls[0]?.messages[0]).toEqual({
      role: "user",
      content: "Original goal: initial goal: stabilize the subagent runtime transcript",
    });
    expect(runCalls[0]?.messages.some((message) => message.content.includes("summary of"))).toBe(
      true,
    );
    expect(
      runCalls[0]?.messages.some((message) => message.content.includes("latest follow-up")),
    ).toBe(true);
  });

  it("keeps the full transcript when compaction threshold is not reached", async () => {
    const sessionId = createSession();
    addTextMessage(sessionId, "user", "initial goal");
    addTextMessage(sessionId, "assistant", "first answer");
    queueResult("done");

    await SubagentRuntime.send({
      sessionId,
      prompt: "second prompt",
      model,
      compaction: {
        contextWindowTokens: 10_000,
      },
    });

    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]?.messages).toEqual([
      { role: "user", content: "initial goal" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second prompt" },
    ]);
  });
});
