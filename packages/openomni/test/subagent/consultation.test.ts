import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { ChatAgent, type AgentResult, type ChatAgentInput } from "@openomni/agent";
import type { Message } from "@openomni/protocol";
import { Session, Storage } from "@openomni/session";
import { SubagentConsultation } from "../../src/subagent/consultation";

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

function createSession(title: string): string {
  return Session.create({
    title,
    model: { providerID: "anthropic", modelID: "claude-3-haiku-20240307" },
  }).id;
}

function addUserMessage(sessionId: string, text: string): Message.UserMessage {
  const message: Message.UserMessage = {
    id: crypto.randomUUID(),
    sessionID: sessionId,
    role: "user",
    time: { created: Date.now() },
    agent: "test",
    model: { providerID: "anthropic", modelID: "claude-3-haiku-20240307" },
  };

  Session.addMessage(sessionId, message);
  Session.addPart(message.id, {
    id: crypto.randomUUID(),
    sessionID: sessionId,
    messageID: message.id,
    type: "text",
    text,
  });

  return message;
}

function addAssistantMessage(sessionId: string, text: string): Message.AssistantMessage {
  const message: Message.AssistantMessage = {
    id: crypto.randomUUID(),
    sessionID: sessionId,
    role: "assistant",
    time: { created: Date.now() },
    parentID: "",
    modelID: "claude-3-haiku-20240307",
    providerID: "anthropic",
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

  Session.addMessage(sessionId, message);
  Session.addPart(message.id, {
    id: crypto.randomUUID(),
    sessionID: sessionId,
    messageID: message.id,
    type: "text",
    text,
  });

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

describe("SubagentConsultation", () => {
  it("active-session reads the target session transcript", async () => {
    const requesterSessionId = createSession("requester");
    const targetSessionId = createSession("target");

    addUserMessage(targetSessionId, "first question");
    addAssistantMessage(targetSessionId, "first answer");
    addUserMessage(targetSessionId, "follow-up question");

    queueResult("guided answer");

    await SubagentConsultation.consult(
      {
        sessionId: requesterSessionId,
        runId: "run-1",
        question: "what should I do next?",
        targetAgent: "advisor",
        mode: "active-session",
        targetSessionId,
      },
      {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
    );

    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]?.messages).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "follow-up question" },
      { role: "user", content: "what should I do next?" },
    ]);
  });

  it("active-session returns guidance from the consulted context", async () => {
    const requesterSessionId = createSession("requester");
    const targetSessionId = createSession("target");

    addUserMessage(targetSessionId, "service is timing out");
    addAssistantMessage(targetSessionId, "we already ruled out dns");

    queueResult("inspect the connection pool next");

    const result = await SubagentConsultation.consult(
      {
        sessionId: requesterSessionId,
        runId: "run-2",
        question: "what is the best next step?",
        targetAgent: "advisor",
        mode: "active-session",
        targetSessionId,
      },
      {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
    );

    expect(result.guidance).toBe("inspect the connection pool next");
    expect(result.source).toBe("advisor");
    expect(result.mode).toBe("active-session");
  });

  it("active-session does not write to the target session", async () => {
    const requesterSessionId = createSession("requester");
    const targetSessionId = createSession("target");

    addUserMessage(targetSessionId, "message one");
    addAssistantMessage(targetSessionId, "message two");
    const messageCount = Session.getMessages(targetSessionId).length;

    queueResult("leave the target untouched");

    await SubagentConsultation.consult(
      {
        sessionId: requesterSessionId,
        runId: "run-3",
        question: "help me with this",
        targetAgent: "advisor",
        mode: "active-session",
        targetSessionId,
      },
      {
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      },
    );

    expect(Session.getMessages(targetSessionId)).toHaveLength(messageCount);
  });

  it("active-session throws without a targetSessionId", async () => {
    const requesterSessionId = createSession("requester");

    try {
      await SubagentConsultation.consult(
        {
          sessionId: requesterSessionId,
          runId: "run-4",
          question: "help me with this",
          targetAgent: "advisor",
          mode: "active-session",
        },
        {
          model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        },
      );
      throw new Error("Expected consult() to require targetSessionId");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("targetSessionId is required for active-session mode");
    }
  });
});
